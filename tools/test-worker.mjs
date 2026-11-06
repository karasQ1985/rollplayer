import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const w = new Worker(new URL('../meta-worker.mjs', import.meta.url), {
  workerData: { dbPath: path.join(here, '..', 'data', 'meta', 'library.sqlite'), coverDir: path.join(here, '..', 'data', 'meta', 'covers'), mode: 'rw' },
});
w.on('message', (m) => { console.log('MSG', JSON.stringify(m)); });
w.on('error', (e) => { console.log('ERR', e && e.message); });
w.on('exit', (c) => { console.log('EXIT', c); });
setTimeout(() => { console.log('done'); w.terminate(); }, 2500);
