/**
 * meta-worker.mjs —— 元数据本地库的唯一持有者（运行在 worker 线程）
 *
 * 为什么单独开线程：
 *   node:sqlite 的 API 是同步的（DatabaseSync），再加封面下载与写盘，都会占住事件循环。
 *   放进 worker 后，主线程只收发消息，扫描/播放/HTTP 不受影响。
 *
 * 红线：
 *   · 本文件是**唯一**打开 SQLite 的地方（单写者），主线程绝不另开连接。
 *   · 只按 { id, op, args } 收消息、按 { id, ok, result|error } 回话。
 *   · 封面落盘用"临时文件 + rename"保证原子（半张图不会被当成完整封面）。
 *   · 写入串行（本线程天然单线程），批量用一次事务，不逐条往返。
 */

import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const DB_PATH = workerData.dbPath;
const COVER_DIR = workerData.coverDir;

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(COVER_DIR, { recursive: true });

const SCHEMA_VERSION = 2;

/** 打开库并做一次幂等的建表/迁移 */
function openDb() {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');       // 读写并发更友好，崩溃后易恢复
  db.exec('PRAGMA busy_timeout = 5000');      // 万一有别的进程持有写锁，最多等 5 秒
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracks (
      fingerprint   TEXT PRIMARY KEY,
      path          TEXT NOT NULL,
      size          INTEGER,
      mtime         INTEGER,
      title         TEXT,
      artist        TEXT,
      album         TEXT,
      albumArtist   TEXT,
      year          TEXT,
      trackNo       INTEGER,
      genre         TEXT,
      lyrics        TEXT,
      lyricsFormat  TEXT,
      coverHash     TEXT,
      provider      TEXT,
      confidence    REAL,
      manualLock    INTEGER DEFAULT 0,
      fetchedAt     INTEGER,
      updatedAt     INTEGER,
      genreSource   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tracks_path ON tracks(path);
    CREATE TABLE IF NOT EXISTS covers (
      hash       TEXT PRIMARY KEY,
      ext        TEXT,
      bytes      INTEGER,
      fetchedAt  INTEGER,
      srcUrl     TEXT
    );
    CREATE TABLE IF NOT EXISTS meta (
      key    TEXT PRIMARY KEY,
      value  TEXT
    );
  `);
  migrate(db);
  return db;
}

/** 结构版本号留迁移位：以后加列/改列在这里按 fromVersion 递增 */
function migrate(db) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
  const current = row ? Number(row.value) : 0;
  // v2：补流派来源列（老库走 ALTER；新库建表时已含该列，ALTER 会报重复则忽略）
  if (current < 2) {
    try { db.exec('ALTER TABLE tracks ADD COLUMN genreSource TEXT'); } catch {}
  }
  if (current < SCHEMA_VERSION) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('schema_version', String(SCHEMA_VERSION));
    if (!row) db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('created_at', String(Date.now()));
  }
}

let db = openDb();

/* ---------------- 语句（一次编译，重复使用） ---------------- */

const stGetTrack = () => db.prepare('SELECT * FROM tracks WHERE fingerprint = ?');
const stGetByPath = () => db.prepare('SELECT * FROM tracks WHERE path = ? LIMIT 1');
const stStats = () => ({
  tracks: db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n,
  covers: db.prepare('SELECT COUNT(*) AS n FROM covers').get().n,
  withLyrics: db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE lyrics IS NOT NULL AND lyrics <> ''").get().n,
});
const UPSERT_SQL = `
INSERT INTO tracks (
  fingerprint, path, size, mtime, title, artist, album, albumArtist, year, trackNo, genre,
  lyrics, lyricsFormat, coverHash, provider, confidence, manualLock, fetchedAt, updatedAt
) VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
)
ON CONFLICT(fingerprint) DO UPDATE SET
  path        = excluded.path,
  size        = excluded.size,
  mtime       = excluded.mtime,
  title       = COALESCE(excluded.title, tracks.title),
  artist      = COALESCE(excluded.artist, tracks.artist),
  album       = COALESCE(excluded.album, tracks.album),
  albumArtist = COALESCE(excluded.albumArtist, tracks.albumArtist),
  year        = COALESCE(excluded.year, tracks.year),
  trackNo     = COALESCE(excluded.trackNo, tracks.trackNo),
  genre       = COALESCE(excluded.genre, tracks.genre),
  lyrics      = COALESCE(excluded.lyrics, tracks.lyrics),
  lyricsFormat= COALESCE(excluded.lyricsFormat, tracks.lyricsFormat),
  coverHash   = COALESCE(excluded.coverHash, tracks.coverHash),
  provider    = COALESCE(excluded.provider, tracks.provider),
  confidence  = MAX(COALESCE(excluded.confidence, 0), COALESCE(tracks.confidence, 0)),
  manualLock  = MAX(COALESCE(excluded.manualLock, 0), COALESCE(tracks.manualLock, 0)),
  updatedAt   = excluded.updatedAt
`;

/* ---------------- 操作 ---------------- */

const ops = {
  /** 批量写入（一次事务），返回写入条数 */
  async putTracks({ rows }) {
    if (!Array.isArray(rows) || !rows.length) return { written: 0 };
    const stmt = db.prepare(UPSERT_SQL);
    db.exec('BEGIN');
    let written = 0;
    try {
      for (const r of rows) {
        if (!r || !r.fingerprint) continue;
        stmt.run(
          r.fingerprint, r.path || '', r.size ?? null, r.mtime ?? null,
          r.title || null, r.artist || null, r.album || null, r.albumArtist || null,
          r.year || null, r.trackNo ?? null, r.genre || null,
          r.lyrics || null, r.lyricsFormat || null, r.coverHash || null,
          r.provider || null, r.confidence ?? null,
          r.manualLock ?? 0, r.fetchedAt ?? Date.now(), Date.now(),
        );
        written++;
      }
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch {}
      throw err;
    }
    return { written };
  },

  /** 单条查询：先按指纹，指纹变了（文件改动）再按路径兜底 */
  async getTrack({ fingerprint, path: p }) {
    let row = stGetTrack().get(fingerprint);
    if (!row && p) row = stGetByPath().get(p);
    return row || null;
  },

  async getTracks({ fingerprints }) {
    const stmt = stGetTrack();
    const out = [];
    for (const fp of fingerprints || []) {
      const row = stmt.get(fp);
      if (row) out.push(row);
    }
    return out;
  },

  /** 封面落盘：临时文件 + rename。返回 { hash, ext, path } */
  async putCover({ hash, ext, data, srcUrl }) {
    if (!hash || !data) return null;
    const safeExt = String(ext || 'jpg').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg';
    const fileName = hash + '.' + safeExt;
    const finalPath = path.join(COVER_DIR, fileName);
    const tmpPath = finalPath + '.' + process.pid + '.' + Date.now() + '.tmp';
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    await fsp.writeFile(tmpPath, buf);
    await fsp.rename(tmpPath, finalPath);           // 同目录 rename 是原子替换
    db.prepare('INSERT INTO covers (hash, ext, bytes, fetchedAt, srcUrl) VALUES (?, ?, ?, ?, ?) ON CONFLICT(hash) DO UPDATE SET ext = excluded.ext, bytes = excluded.bytes, srcUrl = excluded.srcUrl')
      .run(hash, safeExt, buf.length, Date.now(), srcUrl || null);
    return { hash, ext: safeExt, path: finalPath, bytes: buf.length };
  },

  /** 封面查路径（不读内容，主线程用流式返回） */
  async getCover({ hash }) {
    const row = db.prepare('SELECT hash, ext FROM covers WHERE hash = ?').get(hash);
    if (!row) return null;
    const filePath = path.join(COVER_DIR, row.hash + '.' + row.ext);
    if (!fs.existsSync(filePath)) return null;
    return { hash: row.hash, ext: row.ext, path: filePath };
  },

  async stats() {
    const s = stStats();
    s.genreCovered = db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE genre IS NOT NULL AND TRIM(genre) <> ''").get().n;
    s.genreMissing = db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE genre IS NULL OR TRIM(genre) = ''").get().n;
    let dbBytes = 0;
    try { dbBytes = fs.statSync(DB_PATH).size; } catch {}
    return { ...s, dbBytes, dbPath: DB_PATH, mode: workerData.mode || 'rw' };
  },

  /**
   * 完整度切片（只读、零写入）：字段覆盖率 / 来源分布 / 流派桶 / 缺口最多的专辑
   * 一次扫全表（几百行级别）在内存里聚合，不建索引也不改表结构
   */
  async audit({ top = 8 } = {}) {
    const rows = db.prepare(`
      SELECT path, title, artist, album, year, genre, coverHash, lyrics, provider, genreSource
      FROM tracks
    `).all();
    const total = rows.length;
    const filled = (v) => v !== null && v !== undefined && String(v).trim() !== '';
    const fields = { title: 0, artist: 0, album: 0, year: 0, genre: 0, cover: 0, lyrics: 0 };
    const providers = {};
    const genreCount = {};
    const albumAgg = new Map();

    const parseGenres = (raw) => {
      if (!raw) return [];
      try { const v = JSON.parse(raw); if (Array.isArray(v)) return v.map(String); } catch {}
      return String(raw).split(/[;|/]+/).map((x) => x.trim()).filter(Boolean);
    };

    for (const r of rows) {
      if (filled(r.title)) fields.title++;
      if (filled(r.artist)) fields.artist++;
      if (filled(r.album)) fields.album++;
      if (filled(r.year)) fields.year++;
      if (r.coverHash) fields.cover++;
      if (filled(r.lyrics)) fields.lyrics++;
      const genres = parseGenres(r.genre);
      if (genres.length) fields.genre++;
      for (const g of genres) genreCount[g] = (genreCount[g] || 0) + 1;
      const p = r.provider || 'none';
      providers[p] = (providers[p] || 0) + 1;

      const key = (r.album || '（未知专辑）') + '|' + (r.artist || '');
      const agg = albumAgg.get(key) || { album: r.album || '（未知专辑）', artist: r.artist || '', tracks: 0, noGenre: 0, noCover: 0, noYear: 0 };
      agg.tracks++;
      if (!genres.length) agg.noGenre++;
      if (!r.coverHash) agg.noCover++;
      if (!filled(r.year)) agg.noYear++;
      albumAgg.set(key, agg);
    }

    const buckets = Object.entries(genreCount)
      .map(([name, n]) => ({ name, n }))
      .sort((a, b) => b.n - a.n);

    const worstAlbums = [...albumAgg.values()]
      .filter((a) => a.noGenre > 0)
      .sort((a, b) => b.noGenre - a.noGenre || b.tracks - a.tracks)
      .slice(0, Math.max(1, Math.min(30, Number(top) || 8)));

    return {
      tracks: total,
      fields,
      providers,
      genreBuckets: buckets,
      genreBucketCount: buckets.length,
      worstAlbums,
      genreCovered: fields.genre,
      genreMissing: total - fields.genre,
    };
  },

  /** 补流派队列：列出还没有流派的曲目（老的优先），工具按批拉取
   *  junk: 0=只补空的（默认） 1=空的和 Other/Unknown 一起挑 2=只挑 Other/Unknown（回修用） */
  async listGenreQueue({ limit = 200, junk = 0 }) {
    const n = Math.max(1, Math.min(500, Number(limit) || 200));
    const junkMode = Number(junk) || 0;
    const junkCond = `(genre LIKE '%"Other"%' OR genre LIKE '%"Unknown"%' OR genre LIKE '%"Miscellaneous"%')`;
    const missingCond = `(genre IS NULL OR TRIM(genre) = '')`;
    const where = junkMode === 3 ? '1 = 1' : junkMode === 2 ? junkCond : junkMode === 1 ? `(${missingCond} OR ${junkCond})` : missingCond;
    const rows = db.prepare(`
      SELECT fingerprint, path, size, mtime, title, artist, album, year, genre, genreSource
      FROM tracks
      WHERE ${where}
      ORDER BY COALESCE(updatedAt, 0) ASC
      LIMIT ?
    `).all(n);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM tracks WHERE ${where}`).get().n;
    const covered = db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE genre IS NOT NULL AND TRIM(genre) <> ''").get().n;
    return { rows, total, covered, junk: junkMode };
  },

  /**
   * 只写流派列（不动 path/size/title，避免 UPSERT 那种整行覆盖）
   * genre 传 null 表示清空（用于回修垃圾值）；指纹匹配不到时按 path 兜底
   */
  async putGenre({ fingerprint, path: p, genre, source }) {
    if (genre === undefined) return { updated: 0 };
    const value = (genre === null || genre === '') ? null : String(genre);
    const src = value === null ? null : (source || null);
    const now = Date.now();
    const r1 = db.prepare('UPDATE tracks SET genre = ?, genreSource = ?, updatedAt = ? WHERE fingerprint = ?')
      .run(value, src, now, fingerprint || '');
    if ((r1.changes || 0) > 0) return { updated: r1.changes, via: 'fingerprint', cleared: value === null };
    if (p) {
      const r2 = db.prepare('UPDATE tracks SET genre = ?, genreSource = ?, updatedAt = ? WHERE path = ?')
        .run(value, src, now, String(p).toLowerCase());
      return { updated: r2.changes || 0, via: 'path', cleared: value === null };
    }
    return { updated: 0, via: 'none' };
  },

  /** 清理：all = 清空全部；missing = 清掉源文件已不存在的记录 */
  async purge({ scope }) {
    if (scope === 'missing') {
      const rows = db.prepare('SELECT fingerprint, path FROM tracks').all();
      let removed = 0;
      const stmt = db.prepare('DELETE FROM tracks WHERE fingerprint = ?');
      db.exec('BEGIN');
      try {
        for (const r of rows) {
          if (!fs.existsSync(r.path)) { stmt.run(r.fingerprint); removed++; }
        }
        db.exec('COMMIT');
      } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
      return { removed };
    }
    db.exec('DELETE FROM tracks; DELETE FROM covers;');
    for (const f of await fsp.readdir(COVER_DIR).catch(() => [])) {
      await fsp.rm(path.join(COVER_DIR, f), { force: true }).catch(() => {});
    }
    return { removed: 'all' };
  },
};

/* ---------------- 消息协议 ---------------- */

parentPort.on('message', async (msg) => {
  const { id, op, args } = msg || {};
  if (!id) return;
  try {
    const fn = ops[op];
    if (!fn) throw new Error('UNKNOWN_OP:' + op);
    const result = await fn(args || {});
    parentPort.postMessage({ id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: (err && err.message) || String(err) });
  }
});

parentPort.postMessage({ id: 0, ok: true, result: { ready: true, schemaVersion: SCHEMA_VERSION } });
