/**
 * meta-store.mjs —— 元数据本地库的门面（主线程唯一入口）
 *
 * 职责边界：
 *   · 业务代码只认这 6 个 async 方法：getTrack / getTracks / putTracks / putCover / getCover / stats / purge
 *   · 真正打开 SQLite、写盘、建表都在 meta-worker.mjs 里，主线程不碰数据库
 *   · 任何异常都以"降级"收场：worker 3 秒不响应或崩了，读操作返回 null、写操作直接丢弃，
 *     绝不让"缓存坏了"升级成"播放坏了"
 *
 * 另外承担两件事：
 *   · 单实例锁：data/meta/.lock 记 pid，第二个服务进程进来时只读（不写库），避免两个进程抢同一个 SQLite
 *   · 背压：待处理写请求超过队列上限就丢弃（缓存价值低于播放体验）
 */

import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data', 'meta');
const DB_PATH = path.join(DATA_DIR, 'library.sqlite');
const COVER_DIR = path.join(DATA_DIR, 'covers');
const LOCK_PATH = path.join(DATA_DIR, '.lock');

const CALL_TIMEOUT_MS = 3000;      // worker 超过 3 秒没回话 -> 判定不健康
const MAX_PENDING = 200;           // 待处理队列上限（背压）
const MAX_RESTART = 1;

/** 文件指纹：路径 + 大小 + mtime。文件一改，指纹就变，旧记录自然失效（读取时按 path 兜底仍在） */
export function fingerprintOf(filePath, size, mtime) {
  return crypto.createHash('sha1')
    .update(String(filePath || '').toLowerCase() + '|' + size + '|' + mtime)
    .digest('hex').slice(0, 20);
}

class MetaStore {
  constructor() {
    this.worker = null;
    this.seq = 0;
    this.pending = new Map();
    this.healthy = false;
    this.mode = 'rw';            // rw = 可写；ro = 另一个实例已在写，本进程只读
    this.ready = null;
    this.restarts = 0;
    this.stats_ = { dropped: 0, timeouts: 0, errors: 0 };
  }

  /** 启动：目录、单实例锁、worker、首轮握手 */
  async init() {
    try {
      fs.mkdirSync(COVER_DIR, { recursive: true });
      this.mode = this._acquireLock() ? 'rw' : 'ro';
      this._spawn();
      await this.ready;
      return { mode: this.mode, healthy: this.healthy, dbPath: DB_PATH };
    } catch (err) {
      this.healthy = false;
      return { mode: this.mode, healthy: false, error: err.message };
    }
  }

  /** 单实例锁：拿到写权返回 true；已有活着的实例则返回 false（只读） */
  _acquireLock() {
    const write = () => fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, at: Date.now() }), { encoding: 'utf8', flag: 'wx' });
    try { write(); return true; } catch {}
    // 文件已存在：判断占用者是否还活着
    try {
      const prev = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
      if (prev && Number.isFinite(prev.pid)) {
        try { process.kill(prev.pid, 0); /* 还活着 */ return false; }
        catch (e) {
          if (e.code === 'ESRCH') {   // 上个进程已死，接管
            fs.rmSync(LOCK_PATH, { force: true });
            write();
            return true;
          }
          return false;
        }
      }
    } catch {}
    return false;
  }

  _releaseLock() {
    try {
      const prev = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
      if (prev && prev.pid === process.pid) fs.rmSync(LOCK_PATH, { force: true });
    } catch {}
  }

  _spawn() {
    this.worker = new Worker(new URL('./meta-worker.mjs', import.meta.url), {
      workerData: { dbPath: DB_PATH, coverDir: COVER_DIR, mode: this.mode },
    });
    // 注意：worker 不 unref —— 一旦 unref，主线程处于"只等 worker 回话"时没有任何 ref 句柄，
    // Node 会直接退出事件循环（表现为进程莫名结束）。退出时用 dispose() 显式 terminate。
    this.ready = new Promise((resolve, reject) => {
      const onMsg = (msg) => {
        if (msg && msg.id === 0 && msg.ok) {
          this.healthy = true;
          cleanup();
          resolve(msg.result);
        }
      };
      const onErr = (err) => { cleanup(); reject(err); };
      const cleanup = () => {
        this.worker.off('message', onMsg);
        this.worker.off('error', onErr);
      };
      this.worker.on('message', onMsg);
      this.worker.on('error', onErr);
      setTimeout(() => { cleanup(); reject(new Error('WORKER_INIT_TIMEOUT')); }, CALL_TIMEOUT_MS).unref();
    });

    this.worker.on('message', (msg) => {
      if (!msg || msg.id === 0) return;
      const box = this.pending.get(msg.id);
      if (!box) return;
      this.pending.delete(msg.id);
      clearTimeout(box.timer);
      if (msg.ok) box.resolve(msg.result);
      else { this.stats_.errors++; box.reject(new Error(msg.error)); }
    });

    this.worker.on('error', (err) => this._degrade('WORKER_ERROR:' + (err && err.message)));
    this.worker.on('exit', (code) => {
      if (code !== 0) this._degrade('WORKER_EXIT:' + code);
      else this.healthy = false;
      this.ready = Promise.resolve(null);
    });
  }

  _degrade(reason) {
    this.healthy = false;
    this.stats_.errors++;
    for (const [, box] of this.pending) { clearTimeout(box.timer); box.resolve(null); }
    this.pending.clear();
    if (this.restarts < MAX_RESTART) {
      this.restarts++;
      try { this._spawn(); } catch { /* 起不来就彻底降级 */ }
    }
  }

  /** 发一条消息给 worker，超时/降级都返回 null 而不是抛错 */
  _call(op, args, { timeout = CALL_TIMEOUT_MS, dropIfBusy = false } = {}) {
    if (!this.healthy || !this.worker) return Promise.resolve(null);
    if (dropIfBusy && this.pending.size > MAX_PENDING) {
      this.stats_.dropped++;
      return Promise.resolve(null);
    }
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.stats_.timeouts++;
        resolve(null);                        // 超时即降级，不 reject
      }, timeout);
      timer.unref();
      this.pending.set(id, { resolve, timer });
      try { this.worker.postMessage({ id, op, args }); }
      catch { clearTimeout(timer); this.pending.delete(id); resolve(null); }
    });
  }

  /* ---------------- 对外接口 ---------------- */

  async getTrack(filePath, stat) {
    const fp = fingerprintOf(filePath, stat.size, Math.floor(stat.mtimeMs));
    return this._call('getTrack', { fingerprint: fp, path: filePath.toLowerCase() });
  }

  async getTracks(items) {
    const fps = items.map((it) => fingerprintOf(it.path, it.size, Math.floor(it.mtimeMs)));
    return this._call('getTracks', { fingerprints: fps });
  }

  async putTracks(rows) {
    if (this.mode === 'ro') return null;
    return this._call('putTracks', { rows }, { dropIfBusy: true });
  }

  async putCover(hash, data, ext, srcUrl) {
    if (this.mode === 'ro') return null;
    return this._call('putCover', { hash, ext, data, srcUrl }, { dropIfBusy: true, timeout: 8000 });
  }

  async getCover(hash) {
    return this._call('getCover', { hash });
  }

  async stats() {
    const s = await this._call('stats', {});
    return s ? { ...s, mode: this.mode, healthy: this.healthy, ...this.stats_ } : { mode: this.mode, healthy: false, ...this.stats_ };
  }

  /** 补流派队列（只读）：junk 0=只补空 1=含垃圾值 2=只挑垃圾值（回修） */
  async listGenreQueue(limit = 200, junk = 0) {
    return this._call('listGenreQueue', { limit, junk }, { timeout: 8000 });
  }

  /** 写单首流派（只改 genre/genreSource 两列，不覆盖其他字段） */
  async putGenre(row) {
    if (this.mode === 'ro') return null;
    return this._call('putGenre', row, { timeout: 8000 });
  }

  async purge(scope = 'all') {
    if (this.mode === 'ro') return null;
    return this._call('purge', { scope }, { timeout: 15000 });
  }

  dispose() {
    try { this.worker && this.worker.terminate(); } catch {}
    this._releaseLock();
  }
}

export const metaStore = new MetaStore();
export const META_PATHS = { DATA_DIR, DB_PATH, COVER_DIR, LOCK_PATH };
