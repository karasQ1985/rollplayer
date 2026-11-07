/**
 * 播放引擎：封装 <audio>，负责 队列连播 / 错误跳转 / 自动播放兜底。
 * 不持有业务状态，通过回调把事件交给上层：
 *   onFilePlayed(file, idx)  单文件播放完成（ended / 解码错误 / 手动跳过）——用于"已播"计数
 *   onFileChange(file, idx)  切到某文件（idx 为本批内下标；file 为 null 表示本批结束）
 *   onBatchDone()            本批所有文件处理完成（含跳过）
 *   onFileError(file, why)   单文件播放失败（已跳过，可记录）
 *   onPlayState('playing'|'paused'|'blocked')
 *   onFuseBreak(count, file) 连续失败达阈值（熔断）：上层应停止推进并提示
 *
 * 鲁棒性（S-C3 / S-3 / S-C4）：
 *   - 代次 token（gen）：playAt 每次递增，所有异步回调校验代次，过期即丢弃，消除
 *     "play().catch 与 audio error 双触发推进" 与 "ended 与手动 next 撞车多跳" 的竞态。
 *   - 统一推进：play reject 只上报、由 error 事件或兜底 timer 统一 fail+advance 一次。
 *   - 失败熔断：连续失败达 FUSE 触发 onFuseBreak，不再无限跳过。
 *   - reset()：切池/停止时作废在途回调并清 audio，抑制残留 error/ended 干扰新轮。
 */

export function createPlayback(audioEl, { onFilePlayed, onFileChange, onBatchDone, onFileError, onPlayState, onFuseBreak, onAdvanceHold }) {
  /** 推进前的可注入停留：上层（UI）用它插入唱针抬起等仪式，返回需要延后的毫秒数。
      返回 0 或抛错都按"不延迟"处理，保证引擎不会因为 UI 异常卡住连播。 */
  function holdMs(reason, f, i) {
    if (typeof onAdvanceHold !== 'function') return 0;
    try {
      const v = onAdvanceHold(f, i, reason);
      return Number.isFinite(v) && v > 0 ? v : 0;
    } catch (e) {
      console.warn('[playback] onAdvanceHold 抛错，本次按不延迟处理：', e);
      return 0;
    }
  }
  let batchFiles = [];
  let idx = -1;
  let advancing = false;       // 防重复推进标志（同刻并发）
  let gen = 0;                 // 播放代次：每次 playAt 递增，用于丢弃过期异步回调
  let pendingFail = null;      // play reject 后的待接管项 { idx, gen, why, timer }
  let consecFail = 0;          // 连续失败计数（熔断）
  const FUSE = 10;             // 连续失败阈值

  function setBatch(files) {
    batchFiles = files;
    idx = -1;
    consecFail = 0;
  }

  function fileOf(i) {
    return batchFiles[i] || null;
  }

  /** 单文件失败：计数 + 上报；返回 false 表示已熔断（不再推进） */
  function _fail(f, i, why) {
    consecFail++;
    onFileError(f, why);
    onFilePlayed(f, i);
    if (consecFail >= FUSE) {
      if (onFuseBreak) onFuseBreak(consecFail, f);
      return false;
    }
    return true;
  }

  function playAt(i) {
    if (i < 0 || i >= batchFiles.length) return;
    idx = i;
    const f = fileOf(i);
    if (!f) return;
    onFileChange(f, i);
    onPlayState('playing');
    const myGen = ++gen;
    audioEl.src = f.url;
    audioEl.play().catch((err) => {
      if (myGen !== gen) return; // 已被随后 playAt 覆盖 → 静默让位
      if (err && err.name === 'NotAllowedError') {
        onPlayState('blocked');
        onFileError(f, 'autoplay-blocked');
        return;
      }
      // 其他 play() 错误（如解码失败）：只上报，推进统一交给 error 事件或兜底 timer，
      // 避免同一文件的 play reject 与 audio error 双触发导致跳两首。
      const why = (err && err.name) ? err.name : 'play-error';
      if (pendingFail && pendingFail.gen === myGen) clearTimeout(pendingFail.timer);
      pendingFail = {
        idx: i,
        gen: myGen,
        why,
        timer: setTimeout(() => {
          const pf = pendingFail;
          if (pf && pf.gen === myGen && idx === i) {
            pendingFail = null;
            if (_fail(f, i, why)) _advance();
          } else if (pf && pf.gen === myGen) {
            pendingFail = null; // 已推进到新曲，仅清理
          }
        }, 200),
      };
    });
  }

  /** 统一推进入口：宏任务延迟，让滞留的 error 事件优先接管，防双跳 */
  function _advance() {
    if (advancing) return;
    advancing = true;
    setTimeout(() => {
      advancing = false;
      if (idx >= batchFiles.length - 1) {
        onFileChange(null, -1);
        onBatchDone();
        return;
      }
      playAt(idx + 1);
    }, 0);
  }

  function play() {
    if (audioEl.paused) {
      audioEl.play().catch((err) => {
        if (err && err.name === 'NotAllowedError') onPlayState('blocked');
      });
    }
  }

  function pause() {
    audioEl.pause();
    onPlayState('paused');
  }

  /** 手动下一首：当前这首视为"已播"（跳过）并推进 */
  function next() {
    const f = fileOf(idx);
    if (f) onFilePlayed(f, idx);
    _advance();
  }

  /** 手动上一首：回退播放，不计入已播 */
  function prev() {
    if (idx > 0) playAt(idx - 1);
    else playAt(0);
  }

  /** 直接跳转到本批第 i 首播放（跳转本身不计已播） */
  function jumpTo(i) {
    if (i >= 0 && i < batchFiles.length) playAt(i);
  }

  function currentIndex() {
    return idx;
  }

  function toggle() {
    if (audioEl.paused) play();
    else pause();
  }

  // 事件监听
  audioEl.addEventListener('ended', () => {
    const f = fileOf(idx);
    if (!f) return;
    consecFail = 0; // 正常播完复位失败计数
    onFilePlayed(f, idx);
    // 自然结束的仪式窗口：UI 在此刻抬针并延后推进；期间若用户手动切歌，idx 已变，本次推进作废
    const myIdx = idx;
    const hold = holdMs('ended', f, myIdx);
    if (hold > 0) {
      setTimeout(() => { if (idx === myIdx) _advance(); }, hold);
    } else {
      _advance();
    }
  });
  audioEl.addEventListener('error', () => {
    const f = fileOf(idx);
    if (!f) return;
    const code = audioEl.error ? audioEl.error.code : 'unknown';
    // play reject 已上报过该文件：此处接管推进（防双跳）
    if (pendingFail && pendingFail.idx === idx) {
      const why = pendingFail.why;
      clearTimeout(pendingFail.timer);
      pendingFail = null;
      if (_fail(f, idx, why)) _advance();
      return;
    }
    // 正常播放中的 error（play 成功后的加载/解码失败）
    if (_fail(f, idx, 'media-error-code-' + code)) _advance();
  });
  audioEl.addEventListener('pause', () => onPlayState('paused'));
  audioEl.addEventListener('play', () => onPlayState('playing'));

  /** 切池/停止时调用：作废在途回调并清 audio，抑制残留 error/ended 干扰新轮（S-C4） */
  function reset() {
    gen++;
    if (pendingFail) { clearTimeout(pendingFail.timer); pendingFail = null; }
    consecFail = 0;
    advancing = false;
    idx = -1;
    try {
      audioEl.pause();
      audioEl.removeAttribute('src');
      audioEl.load();
    } catch (e) {}
  }

  return {
    setBatch,
    playAt,
    play,
    pause,
    next,
    prev,
    jumpTo,
    toggle,
    currentIndex,
    currentFile: () => fileOf(idx),
    reset,
  };
}
