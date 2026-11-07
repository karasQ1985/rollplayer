/**
 * genre-backfill.mjs —— 流派补采工具（独立进程，不动主服务）
 *
 * 为什么是独立进程：主服务里 meta-worker 是 SQLite 的唯一写者，再开写者会破坏单写者约束。
 * 本工具只读文件 + 走网络，写库一律通过主服务的 HTTP API（受锁、背压、COALESCE 保护）。
 *
 * 数据来源（实测结论，2026-11-07 探测）：
 *   · 本地内嵌标签 common.genre —— 零请求，但你这库只有约 13% 的文件写了流派
 *   · iTunes primaryGenreName  —— 严格匹配下约 60% 命中，值稳定且是"大类"（Rock / J-Pop / Metal…）
 *   · MusicBrainz tags          —— 实测 3 首：recording 级全空、release-group 级仅 1 条且不是流派
 *                                  （"white album:1"），且 search 端点不支持 inc=tags，需要额外一次
 *                                  mbid lookup，成本翻倍而收益接近 0 → 不作为数据源
 *
 * 用法（在项目根运行，需先启动服务）：
 *   node tools/genre-backfill.mjs --limit 50        试跑 50 首
 *   node tools/genre-backfill.mjs --limit 0         跑完全部缺失
 *   node tools/genre-backfill.mjs --no-tag          跳过本地标签（更快，只走 iTunes）
 *   node tools/genre-backfill.mjs --dry             只探测不写库
 *   node tools/genre-backfill.mjs --reset-skip      清空跳过的记录（重新尝试之前没命中的）
 *
 * 产出：
 *   data/run/genre-backfill.json         游标/进度（complete 标记供前端判断）
 *   data/run/genre-backfill-report.json  本次明细：ok / empty / fail
 *   data/run/genre-backfill.log          纯文本日志（UTF-8，控制台乱码时看这个）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFile } from 'music-metadata';
import { normalizeGenre, normalizeGenreList } from './genre-normalize.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN_DIR = path.join(ROOT, 'data', 'run');
const STATE_PATH = path.join(RUN_DIR, 'genre-backfill.json');
const REPORT_PATH = path.join(RUN_DIR, 'genre-backfill-report.json');
const LOG_PATH = path.join(RUN_DIR, 'genre-backfill.log');
const SERVICE_PATH = path.join(RUN_DIR, 'service.json');

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
/** 支持 --name value 与 --name=value 两种写法；无值布尔开关返回 true */
function getArg(name) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--' + name) {
      const next = argv[i + 1];
      return (next && !next.startsWith('--')) ? next : true;
    }
    if (a.startsWith('--' + name + '=')) return a.slice(a.indexOf('=') + 1);
  }
  return undefined;
}
const LIMIT = Number(getArg('limit') || 0);        // 0 = 不限
const DELAY = Number(getArg('delay')) || 400;      // 每首之间（iTunes 礼貌间隔）
const NO_TAG = !!getArg('no-tag');
const DRY = !!getArg('dry');
const RESET_SKIP = !!getArg('reset-skip');
const FIX_JUNK = !!getArg('fix-junk');
const RENORM = !!getArg('renorm');

/* ---------------- 基础 ---------------- */
fs.mkdirSync(RUN_DIR, { recursive: true });
const logLines = [];
function log(msg) {
  const line = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + msg;
  console.log(line);
  logLines.push(line);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJsonSafe(p, def) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; }
}
function writeJson(p, obj) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

/** 服务地址：优先读运行记录里的端口，读不到再用 9898 */
function serviceBase() {
  const rec = readJsonSafe(SERVICE_PATH, null);
  const port = (rec && rec.port) || 9898;
  return 'http://127.0.0.1:' + port;
}
const BASE = serviceBase();

async function api(pathname, opts = {}) {
  const res = await fetch(BASE + pathname, { ...opts, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (data && data.error || ''));
  return data;
}

/* ---------------- 归一化与匹配 ---------------- */

/**
 * 写入前的最后一道闸：全部走 genre-normalize 的别名表收敛到标准大类，
 * 顺带把 Other/Unknown/数字/邮箱片段/非流派中文词这类脏值拦掉。
 * （"Other/Unknown" 在归一里被判为 placeholder，所以不需要额外黑名单）
 */
function cleanGenres(list) {
  return normalizeGenreList(list);
}

/** 库里已有的值是不是"有值但归一后为空"（即垃圾值） */
function isJunkCell(raw) {
  if (!raw) return false;
  return parseGenreCell(raw).length > 0 && normalizeGenreList(parseGenreCell(raw)).length === 0;
}

/** 解析库里的 genre 列（JSON 数组字符串，兼容旧的 ; / | 分隔写法） */
function parseGenreCell(raw) {
  if (!raw) return [];
  const s = String(raw).trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try { const v = JSON.parse(s); if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean); } catch {}
  }
  return s.split(/[;|/]+/).map((x) => x.trim()).filter(Boolean);
}

/** 去掉括号注释、标点、空白，统一小写：用于曲名/歌手比对 */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\(.*?\)|（.*?）|\[.*?\]|【.*?】|「.*?」|『.*?』/g, '')
    .replace(/[\s\-_.,:;·'"!?/\\|~^]+/g, '');
}

/** iTunes：严格匹配（曲名归一后相等 + 歌手命中才认），否则不用——避免"同名异曲"错配 */
async function lookupItunes(artist, title) {
  const term = [artist, title].filter(Boolean).join(' ');
  if (!term) return null;
  const u = 'https://itunes.apple.com/search?term=' + encodeURIComponent(term) + '&entity=song&limit=5';
  const res = await fetch(u, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) return { status: res.status, list: [] };
  const j = await res.json();
  const list = j.results || [];
  const nt = norm(title), na = norm(artist);
  const strict = list.find((x) => {
    if (!x.trackName || norm(x.trackName) !== nt) return false;
    if (!na) return true;
    const xa = norm(x.artistName);
    return xa.includes(na) || na.includes(xa);
  });
  if (!strict) return { status: res.status, list: list.length, matched: false };
  const genres = [strict.primaryGenreName].filter(Boolean).map((g) => g.trim());
  return {
    status: res.status,
    matched: true,
    genres,
    matchedName: strict.trackName,
    matchedArtist: strict.artistName,
    collection: strict.collectionName || null,
  };
}

/** 本地内嵌标签：music-metadata 的 common.genre（多值） */
async function readTagGenres(filePath) {
  try {
    const md = await parseFile(filePath, { duration: false });
    const g = (md.common && md.common.genre) || [];
    const flat = [];
    for (const item of g) {
      String(item).split(/[;|/]+/).forEach((x) => {
        const t = x.trim();
        if (t && !flat.includes(t)) flat.push(t);
      });
    }
    return flat;
  } catch { return []; }
}

/* ---------------- 主流程 ---------------- */

const skipState = RESET_SKIP ? {} : readJsonSafe(path.join(RUN_DIR, 'genre-backfill-skip.json'), {});
const report = { startedAt: new Date().toISOString(), ok: [], empty: [], fail: [], sources: { tag: 0, itunes: 0 } };
const t0 = Date.now();
const state = { limit: LIMIT, processed: 0, written: 0, startedAt: report.startedAt, complete: false };

let interrupted = false;
process.on('SIGINT', async () => {
  interrupted = true;
  log('收到中断，正在收尾…');
  await flush();
  process.exit(130);
});
process.on('SIGTERM', () => { interrupted = true; flush(); process.exit(130); });

function flush() {
  state.processed = report.ok.length + report.empty.length + report.fail.length;
  state.written = report.ok.length;
  state.updatedAt = new Date().toISOString();
  writeJson(STATE_PATH, state);
  writeJson(REPORT_PATH, { ...report, finishedAt: new Date().toISOString(), durationMs: Date.now() - t0 });
  try { fs.writeFileSync(LOG_PATH, logLines.join('\n') + '\n', 'utf8'); } catch {}
}

// 服务必须在跑（写库走 API）
try {
  await api('/api/meta/stats');
} catch (err) {
  log('✗ 连不上本地服务（' + BASE + '）：' + err.message);
  log('  先用 start.bat 选 1 启动服务，再运行本工具。');
  process.exit(2);
}

const before = await api('/api/meta/stats');
log('目标：缺失流派 ' + before.genreMissing + ' 首 / 共 ' + before.tracks + ' 首（已有 ' + before.genreCovered + '）');

/* ---------- 归一模式：只收敛库里已有值，不联网 ---------- */
if (RENORM) {
  log('模式：归一（把已有流派值收敛到标准大类，不重新请求网络）');
  const q = await api('/api/meta/genre-queue?limit=500&junk=3');
  let changed = 0, emptied = 0, same = 0;
  for (const row of q.rows || []) {
    const cur = parseGenreCell(row.genre);
    if (!cur.length) continue;                        // 空的留给常规补采
    const next = cleanGenres(cur);
    if (JSON.stringify(cur) === JSON.stringify(next)) { same++; continue; }
    if (!next.length) {
      // 整条都是脏值：清空，交给常规补采重来
      await api('/api/meta/genre', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fingerprint: row.fingerprint, path: row.path, genre: [], source: 'junk' }),
      });
      emptied++;
      log('✗ ' + (row.title || row.path) + ' → ' + cur.join(' / ') + ' 全是脏值，已清空');
      continue;
    }
    await api('/api/meta/genre', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fingerprint: row.fingerprint, path: row.path, genre: next, source: row.genreSource || 'renorm' }),
    });
    changed++;
    log('↺ ' + (row.title || row.path) + ' → ' + cur.join(' / ') + ' ⇒ ' + next.join(' / '));
  }
  const afterNorm = await api('/api/meta/stats');
  log('归一完成：改写 ' + changed + ' 首，清空脏值 ' + emptied + ' 首，无需改动 ' + same + ' 首');
  log('库现状：有流派 ' + afterNorm.genreCovered + ' 首，仍缺 ' + afterNorm.genreMissing + ' 首');
  try { fs.writeFileSync(LOG_PATH, logLines.join('\n') + '\n', 'utf8'); } catch {}
  process.exit(0);
}

log('参数：limit=' + (LIMIT || '全部') + ' delay=' + DELAY + 'ms tag=' + (NO_TAG ? 'off' : 'on') + (DRY ? ' [DRY]' : ''));
log('来源：本地内嵌标签 → iTunes 大类（MusicBrainz 已实测不可用，不接入）；写入前统一归一到大类');

let writtenTotal = 0;
let clearedCount = 0;
let loopGuard = 0;

while (!interrupted) {
  if (LIMIT && report.ok.length + report.empty.length + report.fail.length >= LIMIT) break;
  const q = await api('/api/meta/genre-queue?limit=500' + (FIX_JUNK ? '&junk=2' : ''));
  const rows = (q.rows || []).filter((r) => !skipState[r.fingerprint]);
  if (!rows.length) {
    log('队列已无待补曲目（剩余缺失 ' + (q.total || 0) + ' 首，均属于已跳过项）');
    break;
  }
  if (++loopGuard > 20) { log('循环保护触发，提前结束'); break; }

  for (const row of rows) {
    if (interrupted) break;
    if (LIMIT && report.ok.length + report.empty.length + report.fail.length >= LIMIT) break;

    const name = row.title ? (row.artist ? row.artist + ' - ' + row.title : row.title) : path.basename(row.path || '?');
    let genres = [];
    let source = null;
    let note = '';

    if (!NO_TAG) {
      genres = cleanGenres(await readTagGenres(row.path));
      if (genres.length) source = 'tag';
    }
    if (!genres.length) {
      try {
        const r = await lookupItunes(row.artist, row.title);
        if (r && r.matched) {
          genres = cleanGenres(r.genres);
          if (genres.length) { source = 'itunes'; note = r.matchedName || ''; }
        } else if (r && r.status === 403) { note = 'iTunes 403（被限流）'; }
      } catch (err) {
        report.empty.push({ path: row.path, title: row.title, artist: row.artist, reason: 'lookup-error: ' + err.message });
        log('✗ ' + name + ' → 查询失败：' + err.message);
        await sleep(DELAY);
        continue;
      }
    }

    if (!genres.length) {
      const hadJunk = isJunkCell(row.genre);
      if (hadJunk && !DRY) {
        // 回修模式下把旧的 Other/Unknown 清空，免得垃圾值留在库里污染分组
        try {
          await api('/api/meta/genre', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fingerprint: row.fingerprint, path: row.path, genre: [], source: 'junk' }),
          });
          clearedCount++;
          skipState[row.fingerprint] = 'junk-cleared';
          log('✗ ' + name + ' → 只有 Other/Unknown，已清空旧值');
        } catch (err) {
          log('✗ ' + name + ' → 清空旧值失败：' + err.message);
        }
        await sleep(DELAY);
        continue;
      }
      report.empty.push({ path: row.path, title: row.title, artist: row.artist });
      if (!DRY) skipState[row.fingerprint] = 'empty';
      log('· ' + name + ' → 无命中' + (hadJunk ? '（旧值是 Other/Unknown，未动）' : ''));
      await sleep(DELAY);
      continue;
    }

    if (DRY) {
      log('· ' + name + ' → ' + genres.join(' / ') + ' [' + source + ']' + (note ? ' (' + note + ')' : ''));
      report.ok.push({ path: row.path, title: row.title, genres, source });
      await sleep(DELAY);
      continue;
    }

    try {
      const w = await api('/api/meta/genre', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fingerprint: row.fingerprint, path: row.path, genre: genres, source }),
      });
      if (w && w.updated > 0) {
        writtenTotal++;
        report.ok.push({ path: row.path, title: row.title, genres, source, via: w.via });
        report.sources[source] = (report.sources[source] || 0) + 1;
        log('✓ [' + (report.ok.length + report.empty.length + report.fail.length) + '] ' + name + ' → ' + genres.join(' / ') + ' [' + source + ']');
      } else {
        fail(row, 'no-row-matched');
        log('✗ ' + name + ' → 库里找不到对应记录（指纹与路径都没匹配）');
      }
    } catch (err) {
      fail(row, 'write-error: ' + err.message);
      log('✗ ' + name + ' → 写库失败：' + err.message);
    }
    await sleep(DELAY);
  }
}

function fail(row, reason) {
  report.fail.push({ path: row.path, title: row.title, artist: row.artist, reason });
  if (!DRY) skipState[row.fingerprint] = reason;
}

flush();
if (!DRY) writeJson(path.join(RUN_DIR, 'genre-backfill-skip.json'), skipState);
// complete 判定：只有队列真正空了才算全量完成
try {
  const after = await api('/api/meta/stats');
  state.genreMissingAfter = after.genreMissing;
  state.genreCoveredAfter = after.genreCovered;
  if (after.genreMissing === 0) state.complete = true;
  writeJson(STATE_PATH, state);
  log('收尾：本次写入 ' + writtenTotal + ' 首，清空垃圾值 ' + clearedCount + ' 首，无命中 ' + report.empty.length + '，失败 ' + report.fail.length);
  log('库现状：有流派 ' + after.genreCovered + ' 首，仍缺 ' + after.genreMissing + ' 首' + (state.complete ? '（已全量补齐）' : ''));
} catch (err) {
  log('收尾统计失败：' + err.message);
}
log('日志 ' + LOG_PATH);
log('报告 ' + REPORT_PATH);
