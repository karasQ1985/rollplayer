// 一次性实测：对扫描得到的整库跑一遍 /api/scrape，统计命中率与耗时
// 用法：node tools/bench-scrape.mjs <requestId> [concurrency]
const BASE = 'http://127.0.0.1:9898';
const RID = process.argv[2];
const CONC = Number(process.argv[3] || 5);

const files = [];
let total = 0;
for (let off = 0; ; off += 100) {
  const r = await (await fetch(`${BASE}/api/files?requestId=${RID}&offset=${off}&limit=100`)).json();
  total = r.total;
  files.push(...r.files);
  if (off + 100 >= r.total) break;
}
console.log('[bench] 清单', files.length, '/', total);

const rows = [];
let cursor = 0;
async function worker() {
  while (cursor < files.length) {
    const i = cursor++;
    const p = files[i];
    const t0 = Date.now();
    let result = null, err = null;
    try {
      const res = await fetch(`${BASE}/api/scrape?path=${encodeURIComponent(p)}`);
      if (!res.ok) err = 'HTTP' + res.status;
      else result = await res.json();
    } catch (e) { err = 'NET:' + e.message; }
    const ms = Date.now() - t0;
    rows.push({
      i, ms, err,
      from: result ? (result.from || 'online') : null,
      lyrics: !!(result && result.lyrics && (result.lyrics.lines || result.lyrics.text)),
      cover: !!(result && result.cover && result.cover.url),
      coverLocal: !!(result && result.cover && result.cover.local),
      meta: !!(result && result.meta && result.meta.title),
    });
    if (rows.length % 20 === 0) console.log('[bench]', rows.length, '/', files.length);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
const q = (p) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))];
const stat = {
  total: rows.length,
  errors: rows.filter((r) => r.err).length,
  fromDb: rows.filter((r) => r.from === 'db').length,
  lyrics: rows.filter((r) => r.lyrics).length,
  cover: rows.filter((r) => r.cover).length,
  coverLocal: rows.filter((r) => r.coverLocal).length,
  meta: rows.filter((r) => r.meta).length,
  msAvg: Math.round(ms.reduce((a, b) => a + b, 0) / (ms.length || 1)),
  msP50: q(0.5), msP90: q(0.9), msMax: ms[ms.length - 1],
  wallSec: null,
};
const out = { stat, rows: rows.map(({ i, ms, err, from, lyrics, cover, meta }) => ({ i, ms, err, from, lyrics, cover, meta })) };
console.log('[bench] 结果', JSON.stringify(stat));
const fs = await import('node:fs/promises');
await fs.writeFile('tools/bench-scrape.json', JSON.stringify(out, null, 1), 'utf8');
