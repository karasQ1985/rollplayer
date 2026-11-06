/**
 * 调度层：纯逻辑，不接触 DOM / 播放器。
 * 职责：Fisher-Yates 洗牌 → 按批(20)切分 → 维护本轮已播计数 → 整池一轮判定。
 * 支持 serialize()/restore() 以支持刷新断点恢复。
 */

export const BATCH_SIZE = 20;

/** Fisher-Yates 洗牌（返回新数组，不修改入参） */
export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function createScheduler(pool, opts = {}) {
  const mode = opts.mode === 'sequential' ? 'sequential' : 'random';
  let remaining = mode === 'sequential' ? [...pool] : shuffle([...pool]); // 本轮待播池（不放回）
  let batch = [];                     // 当前批（<= BATCH_SIZE）
  let batchIndex = -1;                // 当前批序号（0 起）
  let playedCount = 0;                // 本轮累计已播
  let partials = new Set();           // 当前批内"未完整播放"索引（被中断/换批放弃）

  /** 抽取下一批；池已空返回 null */
  function nextBatch() {
    if (remaining.length === 0) return null;
    batch = remaining.splice(0, BATCH_SIZE);
    batchIndex++;
    partials = new Set(); // 换批：新批无"未完整播放"
    return batch;
  }

  /** 标记当前批已播到第 idx 个文件（0 起）；partial=true 表示"未完整播放"（被中断/换批放弃） */
  function markPlayed(idx, { partial = false } = {}) {
    if (idx >= 0 && idx < batch.length) {
      playedCount++;
      if (partial) partials.add(idx);
    }
  }

  /** 标记当前批某索引为"未完整播放"（被跳转播放中断等） */
  function markPartial(idx) {
    if (idx >= 0 && idx < batch.length) partials.add(idx);
  }

  /** 当前批内"未完整播放"索引集合 */
  function partialsOf() {
    return [...partials];
  }

  function currentBatch() {
    return batch;
  }

  function hasMore() {
    return remaining.length > 0;
  }

  /** 剩余池是否为空（配合当前批播完即整池一轮） */
  function roundDone() {
    return remaining.length === 0;
  }

  /** 池总量（含已播与待播，不含已消费的批） */
  function totalCount() {
    return playedCount + batch.length + remaining.length;
  }

  function serialize() {
    return {
      remaining,
      batch,
      batchIndex,
      playedCount,
      partials: [...partials],
    };
  }

  /**
   * 从持久化的状态恢复。batch 与 remaining 已是路径数组。
   * 校验：数组字段必须合法，否则返回 null（调用方回退为新建一轮）。
   */
  function restore(data) {
    if (!data || !Array.isArray(data.remaining) || !Array.isArray(data.batch)) return false;
    remaining = data.remaining.filter((p) => typeof p === 'string');
    batch = data.batch.filter((p) => typeof p === 'string');
    batchIndex = Number.isInteger(data.batchIndex) ? data.batchIndex : -1;
    playedCount = Number.isInteger(data.playedCount) ? data.playedCount : 0;
    partials = new Set(Array.isArray(data.partials) ? data.partials.filter((n) => Number.isInteger(n)) : []);
    return true;
  }

  return {
    nextBatch,
    markPlayed,
    markPartial,
    partialsOf,
    currentBatch,
    hasMore,
    roundDone,
    totalCount,
    serialize,
    restore,
    BATCH_SIZE,
  };
}
