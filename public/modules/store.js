/**
 * 状态管理：单一事实来源（内存 Store）+ IndexedDB 持久化（节流写入）
 * UI 只订阅 state 渲染，任何模块通过 setState 修改，保证数据一致。
 */

const listeners = new Set();

let state = {
  dirs: [],            // 已添加的媒体库目录（绝对路径）
  scan: null,          // { requestId, status, scanned, total, skipped }
  pool: [],            // 去重后的音频文件绝对路径数组
  scheduler: null,     // 调度实例（含 serialize/restore）
  round: 0,            // 当前轮次
  playing: false,      // 播放引擎运行中
  currentFile: null,   // { path, name }
  batchFiles: [],      // 当前批（20 条路径）
  batchIndex: -1,      // 当前批内文件下标
  roundProgress: { played: 0, total: 0 }, // 本轮已播 / 池总量
};

export function getState() {
  return state;
}

export function setState(patch) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => {
    try {
      fn(state);
    } catch (e) {
      console.error('[store] listener error:', e);
    }
  });
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* ---------------- IndexedDB 基础封装 ---------------- */

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open('music-player-session', 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('kv')) {
        req.result.createObjectStore('kv');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function idbSet(key, val) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* ---------------- 会话持久化（节流） ---------------- */

let persistTimer = null;

/** 当前会话数据结构版本（P3 payload 版本迁移）：结构变更时递增并补对应迁移分支 */
const SESSION_VERSION = 1;

/**
 * 会话数据迁移：把旧版本存档结构升级到当前版本。
 * - v0（无 version 字段的早期存档）：规范化关键字段、补版本号；
 * - 未来结构变更时，在此追加 v1 → v2 … 的分支。
 */
function migrateSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw.version == null ? 0 : raw.version;
  if (v === SESSION_VERSION) return raw;
  let p = { ...raw, version: SESSION_VERSION };
  if (v < 1) {
    // v0 → v1：早期结构无版本号，仅规范化关键字段、补全缺失项
    p.dirs = Array.isArray(raw.dirs) ? raw.dirs : [];
    p.pool = Array.isArray(raw.pool) ? raw.pool : [];
    p.round = Number.isFinite(raw.round) ? raw.round : 0;
    p.scheduler = raw.scheduler && typeof raw.scheduler === 'object' ? raw.scheduler : null;
    p.roundProgress =
      raw.roundProgress && typeof raw.roundProgress === 'object'
        ? raw.roundProgress
        : { played: 0, total: Array.isArray(raw.pool) ? raw.pool.length : 0 };
    p.savedAt = raw.savedAt || Date.now();
  }
  // 未来 v1 → v2 … 的迁移分支写在这里
  return p;
}

/** 持久化整份会话（dirs / pool / scheduler / round），写入前合并多次调用 */
export function persistSession() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    const s = getState();
    const payload = {
      version: SESSION_VERSION,
      dirs: s.dirs,
      pool: s.pool,
      round: s.round,
      scheduler: s.scheduler ? s.scheduler.serialize() : null,
      roundProgress: s.roundProgress,
      savedAt: Date.now(),
    };
    try {
      await idbSet('session', payload);
    } catch (e) {
      console.error('[store] persist failed:', e);
    }
  }, 800);
}

export async function loadSession() {
  try {
    const raw = await idbGet('session');
    if (raw == null) return null;
    const migrated = migrateSession(raw);
    // 若发生结构迁移，回写持久化，避免下次读取重复迁移
    if (migrated && migrated.version !== raw.version) {
      try {
        await idbSet('session', migrated);
      } catch (e) {
        console.error('[store] migrate persist failed:', e);
      }
    }
    return migrated;
  } catch (e) {
    console.error('[store] load failed:', e);
    return null;
  }
}

/** 清除持久化会话（新开一轮时由调用方决定是否调用） */
export async function clearSession() {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').delete('session');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error('[store] clear failed:', e);
  }
}
