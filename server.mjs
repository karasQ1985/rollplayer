/**
 * 媒体库轮播播放器 —— 本地代理服务（零第三方依赖，Node >= 18）
 *
 * 为什么需要它：
 *   Chrome 的 File System Access API 无法访问网络位置（UNC 路径 / 映射网络驱动器），
 *   而 50GB+ 媒体库需要服务端递归扫描、去重与 Range 流式播放。
 *
 * 启动： node server.mjs
 * 访问： http://127.0.0.1:9898 （默认自动打开浏览器；设环境变量 MP_NO_OPEN=1 可关闭）
 *
 * API：
 *   POST /api/check        { path }                      校验目录是否存在且可读
 *   POST /api/open-dir     { path }                      在资源管理器中定位文件所在目录并选中
 *   POST /api/scan         { paths: [...] }              创建后台扫描任务，返回 requestId
 *   GET  /api/scan-status  ?requestId=                   轮询扫描进度 / 结果
 *   GET  /api/files        ?requestId=&offset=&limit=    分批拉取音频清单（去重后）
 *   GET  /stream           ?path=                        Range 流式播放音频
 *   GET  /（静态资源）                                     页面 / 前端模块
 *
 * 安全边界：
 *   - 仅接受盘符绝对路径与 UNC 路径，拒绝相对路径与 .. 跳转
 *   - /stream 仅放行白名单音频扩展名
 *   - 静态资源仅限 public 目录内
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import crypto from 'node:crypto';
import { parseFile } from 'music-metadata'; // 成熟元数据/内嵌封面解析（mp3/flac/m4a/wav/ogg）
import { metaStore, fingerprintOf } from './meta-store.mjs'; // 元数据本地库门面（worker 线程持有 SQLite）

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT_BASE = Number(process.env.MP_PORT || 9898);
const MAX_PORT_TRIES = 4;
/** 监听地址：默认只绑 IPv4 loopback，避免与环境中其他服务(如 127.0.0.1:8765)发生地址族冲突。
    要让同局域网的其他设备（iPad / 手机）访问，启动时设 MP_HOST=0.0.0.0 放开（等价 start-lan.bat）。 */
const HOST = process.env.MP_HOST || '127.0.0.1';

/** 0.0.0.0 时列出本机所有可用的局域网地址，方便直接把链接抄到 iPad 上 */
function lanUrls(port) {
  const out = [];
  try {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${port}`);
      }
    }
  } catch {}
  return out;
}

/* 运行记录：data/run/service.json —— 让 start.bat 能精确管理"这一个"进程。
   停止脚本据此做四重校验（pid 存活 / 进程名 node / 命令行含 server.mjs / 启动时刻吻合），
   绝不按端口笼统杀 node，也绝不碰其他程序占用的端口。退出时自动删除。 */
const RUN_DIR = path.join(__dirname, 'data', 'run');
const RUN_FILE = path.join(RUN_DIR, 'service.json');
function writeRunRecord(port) {
  try {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    const rec = {
      pid: process.pid,
      port,
      host: HOST,
      startedAt: Date.now(),
      cwd: __dirname,
      exe: process.execPath,
    };
    fs.writeFileSync(RUN_FILE, JSON.stringify(rec, null, 2), 'utf8');
  } catch (e) {
    console.warn('[run] 写运行记录失败（不影响播放）:', e.message);
  }
}
function clearRunRecord() {
  try {
    if (!fs.existsSync(RUN_FILE)) return;
    const rec = JSON.parse(fs.readFileSync(RUN_FILE, 'utf8'));
    if (rec && rec.pid === process.pid) fs.unlinkSync(RUN_FILE); // 只删自己写的那份
  } catch {}
}

/** 音频格式白名单（前端与此保持一致） */
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.opus']);

/** 扫描时跳过的系统 / 无关目录 */
const SKIP_DIRS = new Set([
  '$RECYCLE.BIN',
  'System Volume Information',
  '@eaDir',
  '.git',
  'node_modules',
  '.thumbnails',
]);

/* 扫描资源熔断（S-5）：防误加根目录/超大目录导致全盘递归、内存/时间失控 */
const MAX_SCAN_FILES = 100000;          // 单次扫描收录上限，超过即截断并标记 partial
const MAX_SCAN_TIME_MS = 180000;        // 单次扫描时长上限（3 分钟），超时即截断

const MIME = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

/* ================= 路径与安全校验 ================= */

function isAbsoluteWin(p) {
  return /^[a-zA-Z]:[\\/]/.test(p) || /^[a-zA-Z]:$/.test(p) || /^\\\\/.test(p);
}

/** 校验并规范化 Windows 绝对路径（盘符 或 UNC），拒绝相对路径与 .. 跳转 */
function assertSafePath(p) {
  if (typeof p !== 'string' || p.trim() === '') throw new Error('EMPTY_PATH: 路径为空');
  let trimmed = p.trim().replace(/[\\/]+$/, '');
  // 盘符根（C:）规范化为 C:\，避免 'C:' 的"当前目录"语义
  if (/^[a-zA-Z]:$/.test(trimmed)) trimmed += '\\';
  if (!isAbsoluteWin(trimmed)) {
    throw new Error('NOT_ABSOLUTE: 仅支持盘符路径(如 D:\\Music)或UNC路径(如 \\\\192.168.1.100\\music)');
  }
  const n = path.win32.normalize(trimmed);
  if (n.split(/[\\/]/).includes('..')) throw new Error('TRAVERSAL: 路径包含非法跳转');
  return n;
}

function assertAudioFile(p) {
  const ext = path.win32.extname(p).toLowerCase();
  if (!AUDIO_EXTS.has(ext)) throw new Error('NOT_AUDIO: 仅允许播放白名单音频格式');
}

/** 枚举本机可用盘符根（含映射的网络驱动器，如 Z:\） */
function enumerateDrives() {
  const drives = [];
  for (let c = 65; c <= 90; c++) {
    const letter = String.fromCharCode(c);
    const root = letter + ':\\';
    try {
      if (fs.existsSync(root)) drives.push({ name: letter + ':', path: root });
    } catch {}
  }
  return drives;
}

/* ================= 内嵌封面提取（零依赖） ================= */

/** ID3v2 syncsafe 4 字节 -> 长度 */
function syncsafe4(b) {
  return ((b[0] & 0x7f) << 21) | ((b[1] & 0x7f) << 14) | ((b[2] & 0x7f) << 7) | (b[3] & 0x7f);
}

/** 提取 mp3 ID3v2 中的 APIC 封面帧 */
async function extractMp3Cover(filePath) {
  let fh;
  try {
    fh = await fsp.open(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const head = Buffer.alloc(10);
    const { bytesRead: n0 } = await fh.read(head, 0, 10, 0);
    if (n0 < 10 || head.toString('latin1', 0, 3) !== 'ID3') return null;
    const tagSize = syncsafe4(head.subarray(6, 10));
    if (tagSize <= 0 || tagSize > 20 * 1024 * 1024) return null;
    const tag = Buffer.alloc(tagSize);
    let read = 0;
    while (read < tagSize) {
      const { bytesRead: n } = await fh.read(tag, read, tagSize - read, 10 + read);
      if (!n) break;
      read += n;
    }
    let o = 0;
    while (o + 10 <= tag.length) {
      const id = tag.toString('latin1', o, o + 4);
      const size = tag.readUInt32BE(o + 4);
      if (id === '\u0000\u0000\u0000\u0000' || size <= 0 || size > tag.length - o - 10) break;
      if (id === 'APIC') {
        const start = o + 10;
        if (start + 2 > tag.length) break;
        const enc = tag[start];
        let q = start + 1;
        const mimeEnd = tag.indexOf(0, q);
        if (mimeEnd < 0 || mimeEnd >= start + size) break;
        const mime = tag.toString('latin1', q, mimeEnd);
        q = mimeEnd + 1 + 1; // MIME 结尾0 + 图片类型1字节
        // 描述字符串按编码跳过
        const sep = enc === 1 || enc === 2 ? 2 : 1;
        let descEnd = tag.indexOf(0, q);
        if (descEnd < 0 || descEnd >= start + size) break;
        let dataStart = descEnd + 1;
        if (sep === 2) {
          // utf16：结束符为 00 00，且描述内每字符有 00；找连续两个 00 更稳
          let found = -1;
          for (let k = q; k < start + size - 1; k++) {
            if (tag[k] === 0 && tag[k + 1] === 0) {
              found = k;
              break;
            }
          }
          if (found < 0) break;
          dataStart = found + 2;
        }
        if (dataStart >= start + size) break;
        const data = tag.subarray(dataStart, start + size);
        if (data.length > 0) return { mime: mime || 'image/jpeg', buffer: Buffer.from(data) };
        break;
      }
      o += 10 + size;
    }
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

/** 提取 flac 的 PICTURE 元数据块 */
async function extractFlacCover(filePath) {
  let fh;
  try {
    fh = await fsp.open(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const head = Buffer.alloc(4);
    const { bytesRead: n0 } = await fh.read(head, 0, 4, 0);
    if (n0 < 4 || head.toString('latin1') !== 'fLaC') return null;
    let offset = 4;
    let last = false;
    for (let guard = 0; !last && guard < 64; guard++) {
      const mb = Buffer.alloc(4);
      const { bytesRead: n } = await fh.read(mb, 0, 4, offset);
      if (n < 4) break;
      last = (mb[0] & 0x80) !== 0;
      const type = mb[0] & 0x7f;
      const len = mb.readUIntBE(1, 3);
      offset += 4;
      if (type === 6) {
        const pic = Buffer.alloc(len);
        let read = 0;
        while (read < len) {
          const { bytesRead: r } = await fh.read(pic, read, len - read, offset + read);
          if (!r) break;
          read += r;
        }
        // PICTURE: type(4) mimeLen(4) mime descLen(4) desc width(4) height(4) depth(4) colors(4) dataLen(4) data
        if (len < 12) break;
        const mimeLen = pic.readUInt32BE(4);
        if (8 + mimeLen + 4 > len) break;
        const mime = pic.toString('latin1', 8, 8 + mimeLen);
        const descLen = pic.readUInt32BE(8 + mimeLen);
        const afterDesc = 12 + mimeLen + descLen; // width 起始
        if (afterDesc + 20 > len) break;
        const dataLen = pic.readUInt32BE(afterDesc + 16);
        const dataStart = afterDesc + 20;
        if (dataStart + dataLen > len) break;
        const data = pic.subarray(dataStart, dataStart + dataLen);
        if (data.length > 0) return { mime: mime || 'image/jpeg', buffer: Buffer.from(data) };
        break;
      }
      offset += len;
    }
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

async function extractCover(filePath) {
  const ext = path.win32.extname(filePath).toLowerCase();
  if (ext === '.mp3') return extractMp3Cover(filePath);
  if (ext === '.flac') return extractFlacCover(filePath);
  return null;
}

/* ================= 歌词提取与解析 ================= */

/** 文本编码探测：BOM 优先 → UTF-8 校验 → GBK 回退（中文 LRC 常见 GBK） */
function decodeLyrics(buf) {
  if (buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
    if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8');
  }
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try { return new TextDecoder('gbk').decode(buf); } catch { return utf8; }
}

/** 解析 LRC：支持多时间标签 [mm:ss.xx] / [mm:ss.xxx] 与同段多标签，返回按时间排序的 { time, text }[] */
function parseLrc(text) {
  const lines = [];
  const tsRe = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const raw of text.split(/\r?\n/)) {
    const times = [];
    let m;
    tsRe.lastIndex = 0;
    while ((m = tsRe.exec(raw)) !== null) {
      const min = +m[1];
      const sec = +m[2];
      let frac = 0;
      if (m[3]) frac = m[3].length >= 3 ? +m[3].slice(0, 3) / 1000 : +m[3].padEnd(2, '0') / 100;
      times.push(min * 60 + sec + frac);
    }
    if (!times.length) continue;
    const content = raw.replace(tsRe, '').trim();
    if (!content) continue;
    for (const time of times) lines.push({ time, text: content });
  }
  lines.sort((a, b) => a.time - b.time);
  return lines;
}

/** 按 ID3v2 文本编码解码 */
function decodeId3Text(enc, buf) {
  if (enc === 3) return buf.toString('utf8');
  if (enc === 1) return new TextDecoder('utf-16').decode(buf); // 含 BOM，自动识别端序
  if (enc === 2) return new TextDecoder('utf-16be').decode(buf);
  return buf.toString('latin1'); // enc 0 = ISO-8859-1
}

/** 提取 mp3 ID3v2 USLT（未同步歌词）帧 */
async function extractMp3Lyrics(filePath) {
  let fh;
  try {
    fh = await fsp.open(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const head = Buffer.alloc(10);
    const { bytesRead: n0 } = await fh.read(head, 0, 10, 0);
    if (n0 < 10 || head.toString('latin1', 0, 3) !== 'ID3') return null;
    const tagSize = syncsafe4(head.subarray(6, 10));
    if (tagSize <= 0 || tagSize > 20 * 1024 * 1024) return null;
    const tag = Buffer.alloc(tagSize);
    let read = 0;
    while (read < tagSize) {
      const { bytesRead: n } = await fh.read(tag, read, tagSize - read, 10 + read);
      if (!n) break;
      read += n;
    }
    let o = 0;
    while (o + 10 <= tag.length) {
      const id = tag.toString('latin1', o, o + 4);
      const size = tag.readUInt32BE(o + 4);
      if (id === '\u0000\u0000\u0000\u0000' || size <= 0 || size > tag.length - o - 10) break;
      if (id === 'USLT') {
        const start = o + 10;
        if (start + 1 > tag.length) break;
        const enc = tag[start];
        let q = start + 1 + 3; // 编码 1 字节 + 语言 3 字节
        if (enc === 1 || enc === 2) {
          // UTF-16：内容描述符以 00 00 结尾
          let found = -1;
          for (let k = q; k < start + size - 1; k++) {
            if (tag[k] === 0 && tag[k + 1] === 0) { found = k; break; }
          }
          if (found < 0) break;
          return decodeId3Text(enc, tag.subarray(found + 2, start + size));
        }
        const descEnd = tag.indexOf(0, q);
        if (descEnd < 0 || descEnd >= start + size) break;
        return decodeId3Text(enc, tag.subarray(descEnd + 1, start + size));
      }
      o += 10 + size;
    }
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

/** 解析 flac VORBIS_COMMENT，取 LYRICS / UNSYNCEDLYRICS 字段 */
function parseVorbisComment(data) {
  let o = 0;
  if (o + 4 > data.length) return null;
  const vendorLen = data.readUInt32LE(o); o += 4;
  o += vendorLen;
  if (o + 4 > data.length) return null;
  const count = data.readUInt32LE(o); o += 4;
  for (let i = 0; i < count; i++) {
    if (o + 4 > data.length) break;
    const clen = data.readUInt32LE(o); o += 4;
    if (o + clen > data.length) break;
    const comment = data.toString('utf8', o, o + clen); o += clen;
    const eq = comment.indexOf('=');
    if (eq < 0) continue;
    const key = comment.slice(0, eq).toUpperCase();
    if (key === 'LYRICS' || key === 'UNSYNCEDLYRICS') return comment.slice(eq + 1);
  }
  return null;
}

/** 提取 flac VORBIS_COMMENT 内嵌歌词 */
async function extractFlacLyrics(filePath) {
  let fh;
  try {
    fh = await fsp.open(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const head = Buffer.alloc(4);
    const { bytesRead: n0 } = await fh.read(head, 0, 4, 0);
    if (n0 < 4 || head.toString('latin1') !== 'fLaC') return null;
    let offset = 4;
    let last = false;
    for (let guard = 0; !last && guard < 64; guard++) {
      const mb = Buffer.alloc(4);
      const { bytesRead: n } = await fh.read(mb, 0, 4, offset);
      if (n < 4) break;
      last = (mb[0] & 0x80) !== 0;
      const type = mb[0] & 0x7f;
      const len = mb.readUIntBE(1, 3);
      offset += 4;
      if (type === 4) {
        const data = Buffer.alloc(len);
        let read = 0;
        while (read < len) {
          const { bytesRead: r } = await fh.read(data, read, len - read, offset + read);
          if (!r) break;
          read += r;
        }
        return parseVorbisComment(data);
      }
      offset += len;
    }
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

/** 汇总歌词：LRC 侧车优先，其次内嵌；返回 { source, lines?, text? } */
async function getLyrics(filePath) {
  const ext = path.win32.extname(filePath);
  const lrcPath = filePath.slice(0, -ext.length) + '.lrc';
  try {
    const st = await fsp.stat(lrcPath);
    if (st.isFile()) {
      const text = decodeLyrics(await fsp.readFile(lrcPath));
      const lines = parseLrc(text);
      if (lines.length) return { source: 'lrc', lines };
      return { source: 'lrc', text: text || '' };
    }
  } catch {}

  const embedded = ext === '.mp3'
    ? await extractMp3Lyrics(filePath)
    : ext === '.flac' ? await extractFlacLyrics(filePath) : null;
  if (embedded) {
    const lines = parseLrc(embedded);
    if (lines.length) return { source: 'embedded', lines };
    return { source: 'embedded', text: embedded };
  }
  return { source: 'none', lines: [] };
}

/* ================= 在线刮削（lrclib 歌词 + MusicBrainz 元数据 + Cover Art 封面） =================
   仅内存缓存（后续可扩展落盘）；出站仅限白名单开源源 */

const SCRAPE_UA = 'RollPlay/1.0 (127.0.0.1:9898; local media player)';
const scrapeCache = new Map(); // key=小写路径 -> { lyrics, cover, meta }

/** 从文件名解析 歌手/曲名：优先 "歌手 - 曲名.ext"，无分隔则整体当作曲名 */
function parseTrackPath(filePath) {
  const base = path.win32.basename(filePath);
  const name = base.replace(/\.[^.]+$/, '');
  const parts = name.split(/\s+-\s+/);
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  return { artist: '', title: name.trim() };
}

/* ---------------- 内嵌标签读取（零依赖，手写 ID3v2 / FLAC Vorbis） ---------------- */

/** 读音频内嵌标签（music-metadata 成熟解析，支持 mp3/flac/m4a/wav/ogg）：识别链最优先（内嵌标签 > 文件名） */
async function readAudioTags(filePath) {
  try {
    const md = await parseFile(filePath, { duration: false });
    const c = md.common || {};
    return {
      artist: (c.artist || (c.artists && c.artists[0]) || '').trim(),
      title: (c.title || '').trim(),
      album: (c.album || '').trim(),
      picture: (Array.isArray(c.picture) && c.picture[0]) ? { format: c.picture[0].format, data: c.picture[0].data } : null,
    };
  } catch { return { artist: '', title: '', album: '', picture: null }; }
}

/** 识别链：内嵌标签优先（含内嵌封面），否则回退文件名 */
async function identifyTrack(filePath) {
  const tags = await readAudioTags(filePath);
  if (tags.title || tags.artist) return { artist: tags.artist, title: tags.title, album: tags.album, picture: tags.picture, from: 'tags' };
  const fp = parseTrackPath(filePath);
  return { artist: fp.artist, title: fp.title, album: '', picture: null, from: 'filename' };
}

/** 专辑封面共享缓存：key=(artist|album).toLowerCase()，同专辑多曲共享一张封面 */
const albumCoverCache = new Map();

/** lrclib.net 开源歌词 API：优先返回带时间戳的同步歌词 */
async function scrapeLyrics(artist, title) {
  const u = new URL('https://lrclib.net/api/search');
  u.searchParams.set('track_name', title);
  if (artist) u.searchParams.set('artist_name', artist);
  const r = await fetch(u, { headers: { 'User-Agent': SCRAPE_UA } });
  if (!r.ok) return null;
  const list = await r.json();
  if (!Array.isArray(list) || !list.length) return null;
  const hit = list.find((x) => x && x.syncedLyrics) || list[0];
  const raw = (hit && (hit.syncedLyrics || hit.plainLyrics)) || '';
  if (!raw.trim()) return null;
  const lines = parseLrc(raw);
  if (lines.length) return { source: 'online', lines };
  return { source: 'online', text: raw.trim() };
}

/** MusicBrainz：查录音元数据 + release-group mbid（用于封面） */
async function scrapeMeta(artist, title) {
  const q = `recording:"${title.replace(/"/g, '')}"${artist ? ` AND artist:"${artist.replace(/"/g, '')}"` : ''}`;
  const u = `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(q)}&fmt=json&limit=3`;
  const r = await fetch(u, { headers: { 'User-Agent': SCRAPE_UA } });
  if (!r.ok) return { meta: null, mbid: null };
  const j = await r.json();
  const rec = (j.recordings || [])[0];
  if (!rec) return { meta: null, mbid: null };
  const meta = {
    title: rec.title || title,
    artist: rec['artist-credit'] ? rec['artist-credit'].map((a) => a.name).filter(Boolean).join(', ') : artist,
    album: null,
    year: null,
  };
  const rel = (rec.releases || [])[0];
  const rg = rel && (rel['release-group'] || {});
  const mbid = (rg && (rg.id || rg['id'])) || null;
  return { meta, mbid };
}

/** Cover Art Archive：按 release-group mbid 取 500px 封面 URL */
function scrapeCover(mbid) {
  return mbid ? `https://coverartarchive.org/release-group/${mbid}/front-500` : null;
}

/* ---------------- 网易云音乐（中文主力，非官方接口） ---------------- */
const NETEASE_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': 'http://music.163.com' };

/** search 找最佳候选（歌手+曲名都命中优先），返回 songId 与基础元数据 */
async function neteaseLookup(artist, title) {
  const s = [artist, title].filter(Boolean).join(' ');
  const u = 'http://music.163.com/api/search/get?s=' + encodeURIComponent(s) + '&type=1&offset=0&total=true&limit=8';
  const r = await fetch(u, { headers: NETEASE_HEADERS });
  if (!r.ok) return null;
  const j = await r.json();
  const songs = (j.result && j.result.songs) || [];
  if (!songs.length) return null;
  const hit = songs.find((x) => x.name === title && artist && x.artists && x.artists.some((a) => a.name === artist))
    || songs.find((x) => x.name === title)
    || songs.find((x) => x.name && x.name.includes(title) && (!artist || (x.artists && x.artists.some((a) => (a.name || '').includes(artist) || artist.includes(a.name)))))
    || songs[0];
  return {
    id: hit.id,
    title: hit.name,
    artist: hit.artists && hit.artists[0] ? hit.artists[0].name : artist,
    album: hit.album && hit.album.name || null,
  };
}

/** 网易云同步歌词（LRC 逐行时间戳） */
async function neteaseLyric(id) {
  const u = `http://music.163.com/api/song/lyric?os=iphone&id=${id}&lv=-1&kv=-1&tv=-1`;
  const r = await fetch(u, { headers: NETEASE_HEADERS });
  if (!r.ok) return null;
  const j = await r.json();
  const raw = j.lrc && j.lrc.lyric;
  if (!raw || !raw.trim()) return null;
  const lines = parseLrc(raw);
  const transText = (j.tlyric && j.tlyric.lyric) || '';
  const trans = transText.trim() ? parseLrc(transText) : [];
  if (lines.length) {
    if (trans.length) attachTranslations(lines, trans);
    return { source: 'online', lines };
  }
  return { source: 'online', text: raw.trim() };
}

/** 把译文按时间就近挂到主歌词行上（tlyric 时间轴通常与主歌词一致，容差 0.6s） */
function attachTranslations(lines, trans) {
  const used = new Set();
  let cursor = 0;
  for (const ln of lines) {
    let best = -1;
    let bestDiff = Infinity;
    for (let k = cursor; k < trans.length && trans[k].time <= ln.time + 0.6; k++) {
      if (used.has(k)) continue;
      const diff = Math.abs(trans[k].time - ln.time);
      if (diff < bestDiff) { bestDiff = diff; best = k; }
    }
    if (best >= 0 && bestDiff <= 0.6) {
      used.add(best);
      ln.trans = trans[best].text;
      cursor = best + 1;
    }
  }
}

/** 网易云封面与专辑元数据（song/detail 拿 picUrl） */
async function neteaseCoverMeta(id) {
  const u = `http://music.163.com/api/song/detail?ids=${encodeURIComponent('[' + id + ']')}`;
  const r = await fetch(u, { headers: NETEASE_HEADERS });
  if (!r.ok) return { cover: null, meta: null };
  const j = await r.json();
  const s = (j.songs || [])[0];
  if (!s) return { cover: null, meta: null };
  const album = s.album || {};
  return {
    cover: album.picUrl ? { url: album.picUrl } : null,
    meta: { title: s.name, artist: (s.artists && s.artists[0] && s.artists[0].name) || '', album: album.name || null, year: null },
  };
}

/* ---------------- iTunes（英文兜底，苹果官方免费） ---------------- */
async function itunesLookup(artist, title) {
  const term = [artist, title].filter(Boolean).join(' ');
  const u = 'https://itunes.apple.com/search?term=' + encodeURIComponent(term) + '&entity=song&limit=3';
  const r = await fetch(u, { headers: { 'User-Agent': SCRAPE_UA } });
  if (!r.ok) return null;
  const j = await r.json();
  const tl = title.toLowerCase();
  const hit = (j.results || []).find((x) => x.trackName && x.trackName.toLowerCase().includes(tl)) || (j.results || [])[0];
  if (!hit) return null;
  return {
    cover: hit.artworkUrl100 ? { url: hit.artworkUrl100.replace('100x100bb', '600x600bb') } : null,
    meta: { title: hit.trackName, artist: hit.artistName, album: hit.collectionName || null, year: hit.releaseDate ? hit.releaseDate.substring(0, 4) : null },
  };
}

/* ---------------- 元数据解析链：内存缓存 → 本地库 → 在线四层 → 写回 ---------------- */

/** 进行中的刮削任务：同一首歌的并发请求只跑一次（多开网页 / 内嵌浏览器同时请求都在这里合并） */
const inflightScrape = new Map();

/** 本地库记录 -> 与旧接口一致的结果形状（封面：有落地哈希走本地直出，否则回落到读文件内嵌封面） */
function dbRowToResult(row, filePath) {
  let lyrics = null;
  if (row.lyrics) {
    try { lyrics = JSON.parse(row.lyrics); }
    catch { lyrics = { source: 'cache', text: row.lyrics }; }
  }
  const cover = row.coverHash
    ? { url: '/api/cover-hash?hash=' + row.coverHash, local: true, from: 'db' }
    : { url: '/api/cover-art?path=' + encodeURIComponent(filePath), local: true, from: 'embedded' };
  const meta = (row.title || row.artist || row.album)
    ? { title: row.title, artist: row.artist, album: row.album, year: row.year || null, genre: parseGenreCell(row.genre), genreSource: row.genreSource || null }
    : null;
  return { lyrics, cover, meta, from: 'db', provider: row.provider || null };
}

/** genre 列存的是 JSON 数组字符串；旧数据/脏数据一律回退成单值数组，不抛错 */
function parseGenreCell(raw) {
  if (!raw) return [];
  const s = String(raw).trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try { const v = JSON.parse(s); if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean); } catch {}
  }
  return s.split(/[;|/]+/).map((x) => x.trim()).filter(Boolean);
}

/** 远程封面落地成本地文件；成功则把 result.cover.url 换成 /api/cover-hash?hash=，返回 hash */
async function materializeCover(result) {
  const c = result && result.cover;
  if (!c || !c.url || c.local || c.url.startsWith('/')) return null;
  try {
    const r = await fetch(c.url, { headers: { 'User-Agent': SCRAPE_UA } });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1024) return null;                          // 太小多半是占位图，不落盘
    const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
    const ext = /png/i.test(r.headers.get('content-type') || '') ? 'png' : 'jpg';
    const saved = await metaStore.putCover(hash, buf, ext, c.url);
    if (!saved) return null;                                     // 写不进去就保留远程 url，功能不受影响
    c.url = '/api/cover-hash?hash=' + hash;
    c.local = true;
    c.from = 'local-file';
    return hash;
  } catch { return null; }
}

/** 增量写回本地库：UPSERT 用 COALESCE，已有值/人工锁不会被空值覆盖 */
async function persistScrape(filePath, ident, result, coverHash) {
  try {
    const stat = await fsp.stat(filePath);
    const meta = result.meta || {};
    const lyricsJson = result.lyrics ? JSON.stringify(result.lyrics) : null;
    if (!lyricsJson && !coverHash && !meta.title) return;        // 什么都没抓到，不留垃圾记录
    const provider = (result.lyrics && result.lyrics.source) || ident.from || 'online';
    const confidence = (meta.title && ident.title && meta.title === ident.title) ? 0.92 : 0.6;
    await metaStore.putTracks([{
      fingerprint: fingerprintOf(filePath, stat.size, Math.floor(stat.mtimeMs)),
      path: filePath.toLowerCase(),
      size: stat.size,
      mtime: Math.floor(stat.mtimeMs),
      title: meta.title || ident.title || null,
      artist: meta.artist || ident.artist || null,
      album: meta.album || ident.album || null,
      year: meta.year || null,
      lyrics: lyricsJson,
      lyricsFormat: lyricsJson ? 'json' : null,
      coverHash: coverHash || null,
      provider,
      confidence,
      fetchedAt: Date.now(),
    }]);
  } catch {}
}

/** 在线四层：网易云(中文主力) → lrclib 歌词 → MusicBrainz+CoverArt → iTunes（内嵌标签/内嵌封面永远优先） */
async function onlineScrape(filePath, ident) {
  const artist = ident.artist, title = ident.title;
  const albumKey = (ident.album && ident.artist) ? (ident.artist + '|' + ident.album).toLowerCase() : null;
  const result = { lyrics: null, cover: null, meta: null };
  // 本地内嵌封面优先（成熟数据源，有封面附件则无需联网刮削）
  if (ident.picture && ident.picture.data && ident.picture.data.length) {
    result.cover = { url: '/api/cover-art?path=' + encodeURIComponent(filePath), local: true };
  }
  if (title) {
    // 同专辑共享封面（仅在无内嵌封面时）
    if (!result.cover && albumKey && albumCoverCache.has(albumKey)) result.cover = { url: albumCoverCache.get(albumKey) };
    // 1) 网易云（中文主力）
    let ne = null;
    try { ne = await neteaseLookup(artist, title); } catch {}
    if (ne && ne.id) {
      try { if (!result.lyrics) result.lyrics = await neteaseLyric(ne.id); } catch {}
      try {
        const cm = await neteaseCoverMeta(ne.id);
        if (!result.cover) result.cover = cm.cover;
        if (!result.meta) result.meta = cm.meta;
      } catch {}
    }
    // 2) 英文兜底：lrclib 歌词
    if (!result.lyrics) { try { result.lyrics = await scrapeLyrics(artist, title); } catch {} }
    // 3) 兜底：MusicBrainz 元数据 + coverart 封面
    if (!result.cover || !result.meta) {
      try {
        const { meta, mbid } = await scrapeMeta(artist, title);
        if (!result.meta) result.meta = meta;
        if (mbid && !result.cover) result.cover = { url: scrapeCover(mbid) };
      } catch {}
    }
    // 4) iTunes 兜底：英文封面/元数据
    if (!result.cover || !result.meta) {
      try {
        const it = await itunesLookup(artist, title);
        if (it) { if (!result.cover) result.cover = it.cover; if (!result.meta) result.meta = it.meta; }
      } catch {}
    }
    // 刮到封面则写入专辑共享缓存，供同专辑后续曲目复用
    if (albumKey && result.cover && result.cover.url && !albumCoverCache.has(albumKey)) {
      albumCoverCache.set(albumKey, result.cover.url);
    }
  }
  return result;
}

/** 综合刮削：内存 → 本地库 → 在线；在线成功即增量写回本地库 */
async function handleScrape(filePath) {
  const key = filePath.toLowerCase();
  const cached = scrapeCache.get(key);
  if (cached) return cached;
  const running = inflightScrape.get(key);
  if (running) return running;                                   // 并发合并：只打一次网络

  const job = (async () => {
    const ident = await identifyTrack(filePath);
    // L0/L1：本地库命中直接返回（指纹 = 路径+大小+mtime，文件没动过就一直有效）
    let stat = null;
    try { stat = await fsp.stat(filePath); } catch {}
    if (stat) {
      const row = await metaStore.getTrack(filePath, stat);
      if (row && (row.lyrics || row.coverHash || row.title)) {
        const hit = dbRowToResult(row, filePath);
        scrapeCache.set(key, hit);
        return hit;
      }
    }
    // L2：在线
    const result = await onlineScrape(filePath, ident);
    const coverHash = await materializeCover(result);            // 远程封面落地成本地文件
    await persistScrape(filePath, ident, result, coverHash);     // 增量写回
    scrapeCache.set(key, result);
    return result;
  })();

  inflightScrape.set(key, job);
  try { return await job; }
  finally { inflightScrape.delete(key); }
}

/* ================= 扫描 ================= */

/** requestId -> { status, files, total, scanned, skipped, error, seen } */
const scans = new Map();

async function walkDir(root, rec) {
  if (rec.truncated) return; // 已达上限/超时，停止遍历
  let dir;
  try {
    dir = await fsp.opendir(root);
  } catch (err) {
    rec.skipped.push({ path: root, reason: err.code || err.message });
    rec.scanned++;
    return;
  }
  try {
    for await (const entry of dir) {
      if (rec.truncated) return; // 熔断检查
      rec.scanned++;
      const full = path.win32.join(root, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walkDir(full, rec);
      } else if (entry.isFile()) {
        const ext = path.win32.extname(entry.name).toLowerCase();
        if (!AUDIO_EXTS.has(ext)) continue;
        const key = full.toLowerCase(); // Windows 文件系统大小写不敏感 -> 按小写去重
        if (rec.seen.has(key)) continue;
        if (rec.files.length >= MAX_SCAN_FILES || Date.now() - rec.startedAt > MAX_SCAN_TIME_MS) {
          rec.truncated = true; // 达到上限/超时：截断，标记部分扫描
          return;
        }
        rec.seen.add(key);
        rec.files.push(full);
      }
    }
  } finally {
    await dir.close().catch(() => {});
  }
}

function startScan(paths) {
  const id =
    'scan-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const rec = {
    status: 'scanning',
    files: [],
    total: 0,
    scanned: 0,
    skipped: [],
    error: null,
    truncated: false,
    startedAt: Date.now(),
    seen: new Set(),
  };
  scans.set(id, rec);
  runScan(rec, paths).catch((err) => {
    rec.status = 'error';
    rec.error = err.message;
  });
  return id;
}

async function runScan(rec, paths) {
  for (const raw of paths) {
    if (rec.truncated) break; // 已有截断，停止后续目录
    let target;
    try {
      target = assertSafePath(raw);
    } catch (err) {
      rec.skipped.push({ path: raw, reason: err.message });
      continue;
    }
    let st;
    try {
      st = await fsp.stat(target);
    } catch (err) {
      rec.skipped.push({ path: target, reason: err.code || err.message });
      continue;
    }
    if (!st.isDirectory()) {
      rec.skipped.push({ path: target, reason: 'NOT_DIRECTORY' });
      continue;
    }
    await walkDir(target, rec);
  }
  rec.status = 'done';
  rec.total = rec.files.length;
}

/* ================= HTTP 工具 ================= */

function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) {
        reject(new Error('BODY_TOO_LARGE'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        reject(new Error('BAD_JSON'));
      }
    });
    req.on('error', reject);
  });
}

/* ================= 流式播放（Range） ================= */

async function handleStream(req, res, url) {
  let filePath;
  try {
    filePath = assertSafePath(url.searchParams.get('path') || '');
    assertAudioFile(filePath);
  } catch (err) {
    return json(res, 400, { error: err.message });
  }

  let st;
  try {
    st = await fsp.stat(filePath);
  } catch (err) {
    return json(res, 404, { error: 'FILE_NOT_FOUND', code: err.code });
  }
  if (!st.isFile()) return json(res, 400, { error: 'NOT_FILE' });

  const total = st.size;
  const mime = MIME[path.win32.extname(filePath).toLowerCase()] || 'application/octet-stream';
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');

  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start;
    let end;
    if (m && m[1] !== '' && m[2] !== '') {
      start = Number(m[1]);
      end = Math.min(Number(m[2]), total - 1);
    } else if (m && m[1] !== '') {
      start = Number(m[1]);
      end = total - 1;
    } else if (m && m[2] !== '') {
      start = Math.max(0, total - Number(m[2]));
      end = total - 1;
    } else {
      start = 0;
      end = total - 1;
    }
    if (start > end || start >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      return res.end();
    }
    res.writeHead(206, {
      'Content-Type': mime,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${total}`,
    });
    const s = fs.createReadStream(filePath, { start, end });
    s.on('error', () => {
      try {
        res.destroy();
      } catch {}
    });
    s.pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': total });
    const s = fs.createReadStream(filePath);
    s.on('error', () => {
      try {
        res.destroy();
      } catch {}
    });
    s.pipe(res);
  }
}

/* ================= 静态资源 ================= */

async function serveStatic(relPath, res) {
  const rel = (relPath === '/' ? 'index.html' : relPath).replace(/^\/+/, '');
  let abs = path.resolve(PUBLIC_DIR, rel);
  if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + path.sep)) {
    return json(res, 403, { error: 'FORBIDDEN' });
  }
  let st;
  try {
    st = await fsp.stat(abs);
  } catch {
    return json(res, 404, { error: 'NOT_FOUND' });
  }
  if (st.isDirectory()) {
    abs = path.join(abs, 'index.html');
    try {
      st = await fsp.stat(abs);
    } catch {
      return json(res, 404, { error: 'NOT_FOUND' });
    }
  }
  const mime = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  /* 静态资源每次都回源校验，避免旧的错误响应（如早期 SVG 被当作 octet-stream）被浏览器启发式缓存 */
  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': 'no-cache, must-revalidate',
    'Last-Modified': st.mtime.toUTCString(),
  });
  fs.createReadStream(abs).pipe(res);
}

/* ================= 路由 ================= */

async function handler(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  try {
    if (req.method === 'POST' && p === '/api/cache-clear') {
      // 清空刮削结果内存缓存（歌词/封面/元数据），不影响磁盘上的音频与 .lrc
      const before = scrapeCache.size;
      scrapeCache.clear();
      return json(res, 200, { ok: true, cleared: before });
    }

    if (req.method === 'POST' && p === '/api/check') {
      const { path: raw } = await readJson(req);
      let target;
      try {
        target = assertSafePath(raw);
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message });
      }
      let st;
      try {
        st = await fsp.stat(target);
      } catch (err) {
        return json(res, 200, {
          ok: false,
          path: target,
          error: err.code || err.message,
          hint:
            err.code === 'EACCES' || err.code === 'EPERM'
              ? '无权限访问。请检查共享权限，或在命令行执行 net use 将共享映射为盘符后改用盘符路径。'
              : undefined,
        });
      }
      let readable = true;
      if (st.isDirectory()) {
        try {
          const dh = await fsp.opendir(target);
          await dh.close();
        } catch {
          readable = false;
        }
      }
      return json(res, 200, {
        ok: true,
        path: target,
        isDirectory: st.isDirectory(),
        readable,
      });
    }

    if (req.method === 'POST' && p === '/api/check-paths') {
      // 批量校验路径存在性（恢复播放前预过滤失效文件，S-3/S-4）
      const { paths } = await readJson(req);
      const list = Array.isArray(paths) ? paths.slice(0, 5000) : [];
      const existing = [];
      const missing = [];
      for (const raw of list) {
        try {
          const target = assertSafePath(raw);
          const st = await fsp.stat(target);
          if (st.isFile()) existing.push(target);
          else missing.push(raw);
        } catch {
          missing.push(raw);
        }
      }
      return json(res, 200, { existing, missing });
    }

    if (req.method === 'POST' && p === '/api/open-path') {
      /* 打开路径：目录用 explorer 打开该文件夹；文件则定位并选中 */
      const { path: raw } = await readJson(req);
      let target;
      try {
        target = assertSafePath(raw);
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message });
      }
      let st;
      try {
        st = await fsp.stat(target);
      } catch (err) {
        return json(res, 200, { ok: false, error: err.code || err.message });
      }
      try {
        const { exec } = await import('node:child_process');
        const cmd = st.isDirectory()
          ? `explorer.exe "${target}"`
          : `explorer.exe /select,"${target}"`;
        exec(cmd, { windowsHide: true }, () => {});
        return json(res, 200, { ok: true });
      } catch (err) {
        return json(res, 200, { ok: false, error: err.message });
      }
    }

    if (req.method === 'POST' && p === '/api/open-dir') {
      const { path: raw } = await readJson(req);
      let target;
      try {
        target = assertSafePath(raw);
        assertAudioFile(target); // 仅对白名单音频文件开放
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message });
      }
      let st;
      try {
        st = await fsp.stat(target);
      } catch (err) {
        return json(res, 200, { ok: false, error: err.code || err.message });
      }
      if (st.isDirectory()) {
        return json(res, 200, { ok: false, error: 'NOT_FILE: 目标不是文件' });
      }
      try {
        const { exec } = await import('node:child_process');
        // 用 exec 让 shell 按字面引号解析，生成 explorer /select,"<完整路径>"。
        // 不能用 spawn 拼接参数：含空格/中文的路径会被 node 二次转义，
        // 导致 explorer 忽略 /select 并打开默认位置（文档/快速访问）。
        // explorer 是 GUI 程序，常返回退出码 1，属正常现象，回调里忽略 err。
        exec(`explorer.exe /select,"${target}"`, { windowsHide: true }, () => {});
        return json(res, 200, { ok: true });
      } catch (err) {
        return json(res, 200, { ok: false, error: err.message });
      }
    }

    if (req.method === 'POST' && p === '/api/scan') {
      const { paths } = await readJson(req);
      if (!Array.isArray(paths) || paths.length === 0) {
        return json(res, 400, { error: 'PATHS_REQUIRED' });
      }
      const requestId = startScan(paths);
      return json(res, 200, { requestId });
    }

    if (req.method === 'GET' && p === '/api/list') {
      const raw = url.searchParams.get('path') || '';
      // 空 path：返回本机盘符根列表（含网络驱动器映射盘符）
      if (!raw) {
        return json(res, 200, { ok: true, drives: enumerateDrives() });
      }
      let target;
      try {
        target = assertSafePath(raw);
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message });
      }
      let st;
      try {
        st = await fsp.stat(target);
      } catch (err) {
        return json(res, 200, { ok: false, path: target, error: err.code || err.message });
      }
      if (!st.isDirectory()) {
        return json(res, 200, { ok: false, path: target, error: 'NOT_DIRECTORY' });
      }
      let dirs = [];
      let files = [];
      let readable = true;
      try {
        const dh = await fsp.opendir(target);
        for await (const e of dh) {
          if (e.isDirectory()) dirs.push(e.name);
          else files.push(e.name);
        }
        await dh.close().catch(() => {});
      } catch (err) {
        readable = false;
        return json(res, 200, { ok: true, path: target, isDirectory: true, readable: false, dirs: [], files: [], error: err.code || err.message });
      }
      dirs.sort((a, b) => a.localeCompare(b, 'zh-CN'));
      files.sort((a, b) => a.localeCompare(b, 'zh-CN'));
      return json(res, 200, { ok: true, path: target, isDirectory: true, readable, dirs, files });
    }

    if (req.method === 'GET' && p === '/api/scan-status') {
      const id = url.searchParams.get('requestId') || '';
      const rec = scans.get(id);
      if (!rec) return json(res, 404, { error: 'SCAN_NOT_FOUND' });
      return json(res, 200, {
        requestId: id,
        status: rec.status,
        scanned: rec.scanned,
        total: rec.total,
        skipped: rec.skipped.slice(0, 30),
        error: rec.error,
        truncated: rec.truncated, // S-5：是否因超限/超时被截断（部分结果）
      });
    }

    if (req.method === 'GET' && p === '/api/files') {
      const id = url.searchParams.get('requestId') || '';
      const rec = scans.get(id);
      if (!rec) return json(res, 404, { error: 'SCAN_NOT_FOUND' });
      if (rec.status !== 'done') {
        return json(res, 200, { status: rec.status, files: [], total: 0 });
      }
      const offset = Math.max(0, Number(url.searchParams.get('offset') || 0) | 0);
      const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get('limit') || 2000) | 0));
      return json(res, 200, {
        status: 'done',
        total: rec.total,
        offset,
        files: rec.files.slice(offset, offset + limit),
      });
    }

    if (req.method === 'GET' && p === '/api/cover') {
      let filePath;
      try {
        filePath = assertSafePath(url.searchParams.get('path') || '');
        assertAudioFile(filePath);
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
      const cov = await extractCover(filePath);
      if (!cov) return json(res, 404, { error: 'NO_COVER' });
      res.writeHead(200, {
        'Content-Type': cov.mime,
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(cov.buffer);
      return;
    }

    if (req.method === 'GET' && p === '/api/lyrics') {
      let filePath;
      try {
        filePath = assertSafePath(url.searchParams.get('path') || '');
        assertAudioFile(filePath);
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
      return json(res, 200, await getLyrics(filePath));
    }

    if (req.method === 'GET' && p === '/api/scrape') {
      let filePath;
      try {
        filePath = assertSafePath(url.searchParams.get('path') || '');
        assertAudioFile(filePath);
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
      return json(res, 200, await handleScrape(filePath));
    }

    if (req.method === 'GET' && p === '/api/cover-art') {
      let filePath;
      try {
        filePath = assertSafePath(url.searchParams.get('path') || '');
        assertAudioFile(filePath);
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
      const tags = await readAudioTags(filePath);
      if (tags.picture && tags.picture.data && tags.picture.data.length) {
        res.writeHead(200, { 'Content-Type': tags.picture.format || 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
        return res.end(tags.picture.data);
      }
      return json(res, 404, { error: 'NO_EMBEDDED_COVER' });
    }

    if (req.method === 'GET' && p === '/api/cover-hash') {
      const hash = (url.searchParams.get('hash') || '').replace(/[^a-f0-9]/gi, '').toLowerCase();
      if (!hash) return json(res, 400, { error: 'BAD_HASH' });
      const cov = await metaStore.getCover(hash);
      if (!cov) return json(res, 404, { error: 'NO_COVER' });
      res.writeHead(200, {
        'Content-Type': cov.ext === 'png' ? 'image/png' : 'image/jpeg',
        'Cache-Control': 'public, max-age=31536000, immutable',   // 内容寻址，哈希不变即内容不变
      });
      return fs.createReadStream(cov.path).pipe(res);
    }

    if (req.method === 'GET' && p === '/api/meta/stats') {
      return json(res, 200, await metaStore.stats());
    }

    if (req.method === 'GET' && p === '/api/meta/audit') {
      const top = Math.min(30, Number(url.searchParams.get('top') || 8));
      const r = await metaStore.audit(top);
      return json(res, 200, r || { tracks: 0, fields: {}, providers: {}, genreBuckets: [], worstAlbums: [] });
    }

    if (req.method === 'GET' && p === '/api/meta/genre-queue') {
      const limit = Math.min(500, Number(url.searchParams.get('limit') || 200));
      const junk = Math.min(3, Math.max(0, Number(url.searchParams.get('junk') || 0)));
      const r = await metaStore.listGenreQueue(limit, junk);
      return json(res, 200, r || { rows: [], total: 0, covered: 0 });
    }

    if (req.method === 'POST' && p === '/api/meta/genre') {
      const body = await readJson(req).catch(() => ({}));
      const list = Array.isArray(body && body.genre)
        ? body.genre.map((x) => String(x).trim()).filter(Boolean)
        : (body && body.genre ? [String(body.genre).trim()].filter(Boolean) : []);
      // 空数组 = 清空该曲流派（用于回修 Other/Unknown 这类垃圾值）
      const clearing = Array.isArray(body && body.genre) && body.genre.length === 0;
      if (!body || !body.fingerprint || (!list.length && !clearing)) {
        return json(res, 400, { error: 'BAD_REQUEST' });
      }
      const r = await metaStore.putGenre({
        fingerprint: String(body.fingerprint),
        path: body.path ? String(body.path) : null,
        genre: clearing ? null : JSON.stringify(list.slice(0, 8)),
        source: String(body.source || 'manual').slice(0, 24),
      });
      return json(res, 200, r || { updated: 0 });
    }

    if (req.method === 'POST' && p === '/api/meta/purge') {
      const body = await readJson(req).catch(() => ({}));
      const scope = body && body.scope === 'missing' ? 'missing' : 'all';
      const r = await metaStore.purge(scope);
      if (scope === 'all') scrapeCache.clear();
      return json(res, 200, { ok: !!r, scope, result: r });
    }

    if (req.method === 'GET' && p === '/stream') {
      return handleStream(req, res, url);
    }

    if (req.method === 'GET') {
      return serveStatic(p, res);
    }

    return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
}

/* ================= 启动 ================= */

// 元数据本地库：先起 worker（拿单实例锁、建表迁移），失败也只是降级成内存缓存，不影响服务启动
const metaInit = await metaStore.init();
console.log('[meta] 本地库模式:', metaInit.mode, metaInit.healthy ? '可用' : '降级', metaInit.dbPath || '');
process.on('exit', () => {
  try { metaStore.dispose(); } catch {}
  try { clearRunRecord(); } catch {}
});

/* 优雅退出：Ctrl+C / Ctrl+Break / kill 时先删运行记录与收尾本地库再退出。
   Windows 关控制台窗口会直接结束进程（走不到这里），那种情况由下次启动的 precheck 清理陈旧记录。 */
let shuttingDown = false;
function gracefulExit(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] 收到 ${sig}，正在关闭 ...`);
  try { clearRunRecord(); } catch {}
  try { metaStore.dispose(); } catch {}
  process.exit(0);
}
['SIGINT', 'SIGBREAK', 'SIGTERM'].forEach((sig) => process.on(sig, () => gracefulExit(sig)));

function start(port, tries) {
  const server = http.createServer(handler);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && tries < MAX_PORT_TRIES) {
      start(port + 1, tries + 1);
    } else {
      console.error('[server] 启动失败:', err.message);
      process.exit(1);
    }
  });
  // 默认绑 IPv4 loopback；MP_HOST=0.0.0.0 时才对外，供同局域网设备访问
  server.listen(port, HOST, () => {
    writeRunRecord(port);   // 先登记身份，后续停止/状态都只认这条记录
    console.log(`[server] 媒体库轮播播放器已启动: http://127.0.0.1:${port}`);
    console.log(`[server] 支持音频格式: ${[...AUDIO_EXTS].join(' ')}`);
    if (HOST === '0.0.0.0') {
      console.log('[server] 已对外开放（MP_HOST=0.0.0.0），同局域网的设备可访问：');
      const urls = lanUrls(port);
      if (urls.length) urls.forEach((u) => console.log(`         ${u}`));
      else console.log('         （未检测到可用的局域网 IPv4 地址）');
    }
    if (process.env.MP_NO_OPEN !== '1') {
      import('node:child_process').then(({ spawn }) => {
        try {
          spawn('cmd', ['/c', 'start', '', `http://127.0.0.1:${port}`], {
            stdio: 'ignore',
            detached: true,
          }).unref();
        } catch {}
      });
    }
  });
}

start(PORT_BASE, 0);
