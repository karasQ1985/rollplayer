/**
 * 调度层纯逻辑冒烟测试（无 DOM 依赖，可在 Node 直接运行）
 * 运行: node tools/scheduler_test.mjs
 */
import { createScheduler } from '../public/modules/scheduler.js';

let pass = true;
const log = (cond, msg) => {
  if (!cond) pass = false;
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
};

// 45 个文件 -> 期望批次 20/20/5
const pool = Array.from({ length: 45 }, (_, i) => 'f' + i);
const s = createScheduler(pool);
const batches = [];
let b;
while ((b = s.nextBatch()) !== null) batches.push(b);

log(JSON.stringify(batches.map((x) => x.length)) === '[20,20,5]', '批次切分 45 -> ' + JSON.stringify(batches.map((x) => x.length)));
log(s.roundDone(), '整池播完后 roundDone=true');
log(s.hasMore() === false, '剩余池为空 hasMore=false');

// 一轮内不重复 + 覆盖全池
const all = batches.flat();
const uniq = new Set(all);
log(uniq.size === 45 && all.length === 45, '一轮内无重复且全覆盖（45/45）');

// serialize / restore 往返
const s2 = createScheduler(pool);
const b1 = s2.nextBatch();
const snap = s2.serialize();
const s3 = createScheduler([]);
log(s3.restore(snap), 'restore 成功');
log(JSON.stringify(s3.serialize().remaining) === JSON.stringify(snap.remaining), 'restore 后 remaining 一致');
log(s3.currentBatch().length === b1.length, 'restore 后当前批长度一致');

// 边界：空池
const sEmpty = createScheduler([]);
log(sEmpty.nextBatch() === null, '空池 nextBatch 返回 null');
log(sEmpty.roundDone(), '空池 roundDone=true');

console.log('\n调度层测试: ' + (pass ? '全部通过' : '存在失败'));
process.exit(pass ? 0 : 1);
