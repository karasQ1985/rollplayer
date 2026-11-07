/**
 * 装配入口：绑定 UI 与各层模块。
 * 流程：添加目录 → 扫描 → 统计 → 开始播放（调度层切批 → 播放引擎连播）
 *      → 整池一轮 → 弹窗 → 再来一轮 / 停止
 * 支持刷新断点恢复（IndexedDB 持久化）。
 */

import {
  getState,
  setState,
  subscribe,
  persistSession,
  loadSession,
  clearSession,
} from './modules/store.js';
import { createScheduler } from './modules/scheduler.js';
import { createPlayback } from './modules/playback.js';
import { createVisualizer } from './modules/visualizer.js';
import * as provider from './modules/providers/nas-provider.js';

/* ---------------- DOM 引用 ---------------- */

const $ = (id) => document.getElementById(id);
const el = {
  dirInput: $('dirInput'),
  addDirBtn: $('addDirBtn'),
  browseBtn: $('browseBtn'),
  dirList: $('dirList'),
  scanBtn: $('scanBtn'),
  resumeBtn: $('resumeBtn'),
  refreshTopBtn: $('refreshTopBtn'),
  scanProgress: $('scanProgress'),
  scanProgressBar: $('scanProgressBar'),
  scanProgressText: $('scanProgressText'),
  drawerInfo: $('drawerInfo'),
  poolTotal: $('poolTotal'),
  dirCount: $('dirCount'),
  extDist: $('extDist'),
  planBox: $('planBox'),
  restoreBanner: $('restoreBanner'),
  playerPlaceholder: $('playerPlaceholder'),
  player: $('player'),
  nowTitle: $('nowTitle'),
  nowMeta: $('nowMeta'),
  audioEl: $('audioEl'),
  prevBtn: $('prevBtn'),
  playPauseBtn: $('playPauseBtn'),
  nextBtn: $('nextBtn'),
  batchText: $('batchText'),
  batchProgressBar: $('batchProgressBar'),
  roundPos: $('roundPos'),
  playError: $('playError'),
  batchList: $('batchList'),
  roundInfo: $('roundInfo'),
  roundProgressText: $('roundProgressText'),
  roundProgressBar: $('roundProgressBar'),
  roundModal: $('roundModal'),
  roundSummary: $('roundSummary'),
  newRoundBtn: $('newRoundBtn'),
  stopBtn: $('stopBtn'),
  roundDoneOverlay: $('roundDoneOverlay'),
  roundDoneStats: $('roundDoneStats'),
  rdAgainBtn: $('rdAgainBtn'),
  rdRescanBtn: $('rdRescanBtn'),
  rdCollapseBtn: $('rdCollapseBtn'),
  pickerModal: $('pickerModal'),
  pickerPath: $('pickerPath'),
  pickerGoBtn: $('pickerGoBtn'),
  pickerRootBtn: $('pickerRootBtn'),
  pickerList: $('pickerList'),
  pickerCur: $('pickerCur'),
  pickerUpBtn: $('pickerUpBtn'),
  pickerUseBtn: $('pickerUseBtn'),
  pickerCancelBtn: $('pickerCancelBtn'),
  coverBox: $('coverBox'),
  coverImg: $('coverImg'),
  coverBlur: $('coverBlur'),
  coverReveal: $('coverReveal'),
  coverRevealImg: $('coverRevealImg'),
  curTime: $('curTime'),
  totalTime: $('totalTime'),
  seekBar: $('seekBar'),
  seekFill: $('seekFill'),
  muteBtn: $('muteBtn'),
  volHit: $('volHit'),
  volTrack: $('volTrack'),
  volFill: $('volFill'),
  volThumb: $('volThumb'),
  volValue: $('volValue'),
  volumeBox: $('volumeBox'),
  seekThumb: $('seekThumb'),
  skipBatchBtn: $('skipBatchBtn'),
  confirmModal: $('confirmModal'),
  confirmTitle: $('confirmTitle'),
  confirmMsg: $('confirmMsg'),
  confirmOkBtn: $('confirmOkBtn'),
  confirmCancelBtn: $('confirmCancelBtn'),
  seqMode: $('seqMode'),
  lyricsLine: $('lyricsLine'),
  hd: $('hd'),
  hdLyrics: $('hdLyrics'),
  hdLyricMain: $('hdLyricMain'),
  hdLyricSub: $('hdLyricSub'),
};

/* ---------------- 用户配置（localStorage 持久化） ---------------- */

function loadUserPrefs() {
  const p = { welcome: { title: '欢迎使用RollPlay播放器', meta: '导入媒体库并扫描后，随机轮播开始' }, titleFx: { enabled: false, intensity: 0.5, mode: 'both', amplitude: 0.8, curve: 0.5 } };
  try {
    const w = JSON.parse(localStorage.getItem('mp.welcomeText') || 'null');
    if (w && typeof w === 'object') {
      p.welcome.title = w.title ?? p.welcome.title;
      p.welcome.meta = w.meta ?? p.welcome.meta;
    }
  } catch {}
  try {
    const t = JSON.parse(localStorage.getItem('mp.titleFx') || 'null');
    if (t && typeof t === 'object') {
      p.titleFx.enabled = !!t.enabled;
      if (typeof t.intensity === 'number' && t.intensity >= 0.1 && t.intensity <= 1) p.titleFx.intensity = t.intensity;
      if (t.mode === 'hue' || t.mode === 'light' || t.mode === 'both') p.titleFx.mode = t.mode;
      if (typeof t.amplitude === 'number' && t.amplitude >= 0.1 && t.amplitude <= 1) p.titleFx.amplitude = t.amplitude;
      if (typeof t.curve === 'number' && t.curve >= 0.1 && t.curve <= 1) p.titleFx.curve = t.curve;
    }
  } catch {}
  return p;
}
const userPrefs = loadUserPrefs();

/* 播放顺序模式：random=随机洗牌；sequential=按全路径自然排序顺序抽取 */
let playMode = 'random';
try {
  const m = localStorage.getItem('mp.playMode');
  if (m === 'sequential' || m === 'random') playMode = m;
} catch {}
const naturalCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

/* ---------------- 播放引擎 ---------------- */

const visualizer = createVisualizer($('viz'));

/* ---------------- 标题动效引擎（歌名随节奏随机变色/闪动） ---------------- */
let fxHue = 42, fxEnergy = 0, fxLastBeat = 0, fxRaf = 0, fxRunning = false;
function resetTitleStyle() {
  el.nowTitle.style.color = '';
  el.nowTitle.style.textShadow = '';
}
function titleFxFrame() {
  if (!fxRunning || !userPrefs.titleFx.enabled) return;
  const b = visualizer.getBeat();
  if (b > 0.35 && fxLastBeat <= 0.35) fxHue = (fxHue + 60 + Math.random() * 240) % 360;
  fxLastBeat = b;
  const { intensity, amplitude, curve, mode } = userPrefs.titleFx;
  const amp = amplitude;
  // 强度曲线：curve 0.1~1 → 指数 1~3（越大越陡：低能量更抑制、高能量更爆发）
  const pow = 1 + curve * 2;
  const shaped = Math.pow(Math.min(1, b), pow);
  // 色相随能量连续漂移（强节奏 b 大 → 快速旋转，增强闪烁感；幅度控制转速）
  fxHue = (fxHue + b * (2 + 12 * amp)) % 360;
  // 亮度：动态范围随变化幅度缩放
  const light = 58 + shaped * 24 * amp;
  const glow = shaped * intensity * 18 * amp;
  if (mode === 'light') {
    el.nowTitle.style.color = `hsl(0,0%,${light}%)`;
  } else {
    el.nowTitle.style.color = `hsla(${fxHue},90%,${light}%,1)`;
  }
  el.nowTitle.style.textShadow = (mode === 'hue') ? 'none' : `0 0 ${glow}px hsla(${fxHue},90%,${light}%,.8)`;
  fxRaf = requestAnimationFrame(titleFxFrame);
}
function startTitleFx() {
  if (fxRunning) return;
  fxRunning = true;
  fxEnergy = 0; fxLastBeat = 0;
  if (userPrefs.titleFx.enabled) fxRaf = requestAnimationFrame(titleFxFrame);
}
function stopTitleFx() {
  fxRunning = false;
  if (fxRaf) { cancelAnimationFrame(fxRaf); fxRaf = 0; }
  resetTitleStyle();
}

/* ---------------- 盘心音符动效 ----------------
   与歌名标题用**同一套配色算法**（同样的每拍随机换相、同样的 intensity/amplitude/curve 塑形），
   所以两者颜色演进是一致的。但独立驱动：标题动效默认关闭（titleFx.enabled=false），
   音符不该跟着一起哑掉 —— 只要在播放就亮起来。
   再叠一层 3.4s 正弦"辉光呼吸"，让它在拍与拍之间也有持续的光晕起伏。
   染色链路：音符原图是**白描边**（不是深色），所以不能加 invert —— sepia 把白打成浅褐、
   saturate 把饱和度放大、hue-rotate 上色、brightness 提亮，最后 drop-shadow 打同色辉光。
   hue-rotate 必须排在 drop-shadow 之前，否则已生成的阴影颜色会被再旋一次。 */
let noteEl = null, noteHue = 42, noteLastBeat = 0, noteRaf = 0, noteOn = false;
const NOTE_BREATH_SEC = 3.4;
function noteNode() {
  if (!noteEl) noteEl = el.player && el.player.querySelector('.disc-music');
  return noteEl;
}
function noteFxFrame(ts) {
  noteRaf = 0;
  if (!noteOn) return;
  /* 护栏：以音频引擎实际状态为准。欢迎页/自动播放被拦/点了播放但没音源时，
     audio.paused 可能是 false（UI 已切到"暂停"图标）却没有媒体，音符不该自己在那儿呼吸。 */
  if (el.audioEl.paused || !el.audioEl.currentSrc) { stopNoteFx(); return; }
  const n = noteNode();
  if (!n) return;
  let b = 0;
  try { b = visualizer.getBeat() || 0; } catch {}
  const { intensity, amplitude, curve } = userPrefs.titleFx;
  const pow = 1 + curve * 2;
  const shaped = Math.pow(Math.min(1, b), pow);
  /* 标题动效开着时，音符直接取标题的 fxHue —— 两边同色同相，肉眼是一套颜色。
     标题动效关着时（默认），音符自己按同一套规则演进，不至于一动不动。 */
  if (userPrefs.titleFx.enabled && fxRunning) {
    noteHue = fxHue;
    noteLastBeat = fxLastBeat;
  } else {
    if (b > 0.35 && noteLastBeat <= 0.35) noteHue = (noteHue + 60 + Math.random() * 240) % 360;
    noteLastBeat = b;
    noteHue = (noteHue + b * (2 + 12 * amplitude)) % 360;
  }
  const breathe = 0.5 + 0.5 * Math.sin((ts / 1000) * (Math.PI * 2 / NOTE_BREATH_SEC));
  /* brightness 上限压在 1.4 以内：实测 1.6 以上会把染色冲成接近白，音符又变回"白音符" */
  const bright = 1.02 + breathe * 0.14 + shaped * 0.20;
  const halo = 6 + breathe * 10 + shaped * intensity * 26;
  const alpha = Math.min(1, 0.34 + breathe * 0.24 + shaped * 0.36);
  const hue = Math.round(((noteHue % 360) + 360) % 360);   // 兜底归一，避免出现 581deg 这种值
  /* invert(.5) 先把纯白压成中灰 —— 否则 sepia 对 #fff 几乎无输出，saturate 也放不出颜色 */
  n.style.filter = `invert(0.5) sepia(1) saturate(6.2) hue-rotate(${hue}deg) brightness(${bright.toFixed(3)})`
    + ` drop-shadow(0 0 ${halo.toFixed(1)}px hsla(${hue},95%,62%,${alpha.toFixed(2)}))`;
  noteRaf = requestAnimationFrame(noteFxFrame);
}
function startNoteFx() {
  if (noteOn) return;
  noteOn = true;
  noteLastBeat = 0;
  if (!noteRaf) noteRaf = requestAnimationFrame(noteFxFrame);
}
function stopNoteFx() {
  noteOn = false;
  if (noteRaf) { cancelAnimationFrame(noteRaf); noteRaf = 0; }
  const n = noteNode();
  if (n) n.style.filter = '';
}

const playback = createPlayback(el.audioEl, {
  onFilePlayed: (file, idx) => {
    const s = getState();
    s.scheduler && s.scheduler.markPlayed(idx);
    setState({
      roundProgress: { ...s.roundProgress, played: s.scheduler ? s.scheduler.serialize().playedCount : s.roundProgress.played },
    });
    persistSession();
  },
  onFileChange: renderNowPlaying,
  onBatchDone: handleBatchDone,
  onFileError: (file, why) => {
    // 自动播放被浏览器拦截不是"损坏文件"，不计入跳过，由 onPlayState 引导点击 ▶
    if (why === 'autoplay-blocked') return;
    skipCount++;
    const box = el.playError;
    box.textContent = `已跳过 ${skipCount} 个无法播放的文件 · 最近：${provider.baseName(file.path)}（${why}）`;
    box.classList.remove('hidden');
  },
  onPlayState: (state) => {
    if (state === 'blocked') {
      showPlayError('浏览器拦截了自动播放，请点击中间 ▶ 开始播放当前第一首。');
      el.playPauseBtn.classList.add('pulse');
    } else {
      el.playPauseBtn.classList.remove('pulse');
    }
    // 音效可视化门控：仅播放中绘制，暂停/拦截立即停止（省 CPU）
    if (state === 'playing') { visualizer.start(el.audioEl); startTitleFx(); }
    else { visualizer.pause(); stopTitleFx(); }
    updatePlayBtnText();
  },
  onFuseBreak: (count, file) => {
    // 连续失败熔断（S-3）：停推进，提示用户而非无限跳过
    el.audioEl.pause();
    showPlayError(`连续 ${count} 首无法播放（最近：${provider.baseName(file.path)}），可能路径失效或格式不支持。已停止自动跳过，请刷新媒体库或停止。`);
    enableControls(false);
  },
  // 自然播完的仪式：与手动切歌同一条时序（抬针 → 停声 → 收拢），收拢走完再由引擎换片
  onAdvanceHold: (file, idx, reason) => {
    if (reason !== 'ended') return 0;      // 解码失败等异常跳转不做仪式，保持快速跳过
    const hold = runCueRitual(playerHasCover());
    switchSettleUntil = performance.now() + hold;   // 仪式期间同样吞掉连点，手感与按钮切歌一致
    setTimeout(() => { switchSettleUntil = 0; }, hold);
    return hold;
  },
});

/** 播放按钮图标：▶=当前暂停可播，⏸=正在播放可暂停；on 态由播放状态驱动（持久） */
function updatePlayBtnText() {
  const playing = !el.audioEl.paused;
  // SVG 元素没有 hidden 属性反射，必须操作 attribute
  el.playPauseBtn.querySelector('.ic-play').toggleAttribute('hidden', playing);
  el.playPauseBtn.querySelector('.ic-pause').toggleAttribute('hidden', !playing);
  el.playPauseBtn.classList.toggle('on', playing);
}

/** 瞬时 on：普通按钮点击瞬间高亮，约 220ms 后复原（播放按钮除外） */
function flashOn(btn) {
  btn.classList.add('on');
  setTimeout(() => btn.classList.remove('on'), 220);
}

/* ---------------- 渲染 ---------------- */

function renderDirs() {
  const dirs = getState().dirs;
  el.dirList.innerHTML = dirs.length
    ? dirs
        .map(
          (d, i) =>
            `<li class="path-item" data-path="${escapeHtml(d)}" title="${escapeHtml(d)}">` +
            `<span class="glow"></span><span class="dot"></span>` +
            `<span class="name">${escapeHtml(d)}</span>` +
            `<button class="rm" data-i="${i}" title="从列表移除（不删除磁盘文件）">✕</button></li>`,
        )
        .join('')
    : '<li style="color:var(--muted)">尚未添加目录</li>';
  el.dirCount.textContent = dirs.length ? dirs.length : 'X';
  el.scanBtn.disabled = dirs.length === 0;
}

let _scanInfo = null;   // 扫描状态缓存（供底部信息栏综合状态渲染）
function renderScanStatus(s) {
  if (!s || s.status === 'idle') {
    // 空闲：进度条隐藏，信息栏回到常规状态
    _scanInfo = null;
    el.scanProgress.classList.add('hidden');
  } else if (s.status === 'scanning') {
    const inc = s.mode === 'incremental';
    _scanInfo = { status: 'scanning', text: inc ? '正在收录新目录…（播放不受影响）' : '正在刷新媒体库…（播放不受影响）' };
    el.scanProgress.classList.remove('hidden');
    el.scanProgressBar.style.width = 'auto';
    el.scanProgressText.textContent = `已遍历 ${s.scanned} 个条目`;
  } else if (s.status === 'done') {
    el.scanProgress.classList.add('hidden');
    const skipped = (s.skipped || []).length;
    _scanInfo = { status: 'done', text: `扫描完成：${s.total} 个音频文件${skipped ? `（${skipped} 条跳过）` : ''}` };
  } else if (s.status === 'error') {
    el.scanProgress.classList.add('hidden');
    _scanInfo = { status: 'error', text: '扫描出错：' + (s.error || '未知') };
  }
  updateDrawerInfo();
}

/* 底部状态信息栏综合状态：媒体库统计摘要 + 扫描/播放状态（标注 Frame 77） */
function updateDrawerInfo() {
  const s = getState();
  const pool = s.pool || [];
  const dirs = s.dirs || [];
  const lines = [];
  if (pool.length || dirs.length) {
    const ext = {};
    for (const p of pool) {
      const e = p.split('.').pop().toLowerCase();
      ext[e] = (ext[e] || 0) + 1;
    }
    const topExt = Object.entries(ext).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k} ×${v}`).join(' · ');
    lines.push(`共 ${pool.length} 首 · ${dirs.length} 个目录${topExt ? ` · ${topExt}` : ''}`);
  }
  if (_scanInfo && _scanInfo.status === 'scanning') {
    lines.push(_scanInfo.text);
  } else if (_scanInfo && (_scanInfo.status === 'done' || _scanInfo.status === 'error')) {
    lines.push(_scanInfo.text);
  } else if (s.round > 0) {
    const rp = s.roundProgress || {};
    lines.push(`第 ${s.round} 轮 · 本批 ${rp.played || 0} / ${rp.total || 0}`);
  } else {
    lines.push('就绪');
  }
  el.drawerInfo.innerHTML = lines.map((l) => `<div class="di-line">${l}</div>`).join('');
}

function renderPoolStats(pool) {
  const dirs = getState().dirs || [];
  const noData = !pool || !pool.length || !dirs.length;
  el.poolTotal.textContent = noData ? 'X' : pool.length;
  const lb = $('libCount');
  if (lb) lb.textContent = noData ? 'X' : pool.length;
  const ext = {};
  for (const p of pool) {
    const e = p.split('.').pop().toLowerCase();
    ext[e] = (ext[e] || 0) + 1;
  }
  const parts = Object.entries(ext)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ×${v}`);
  el.extDist.textContent = noData ? 'X' : (parts.join(' · ') || 'X');
  const spb = $('startPlayBtn');
  if (spb) spb.disabled = noData;
  updateDrawerInfo();
}

function renderPlan(pool) {
  const n = pool.length;
  if (n === 0) {
    el.planBox.classList.add('hidden');
    return;
  }
  const batches = Math.ceil(n / 20);
  const tail = n % 20 || 20;
  el.planBox.classList.remove('hidden');
  el.planBox.innerHTML =
    `共 <b>${n}</b> 首，按每批 20 首划分为 <b>${batches}</b> 批` +
    `（尾批 ${tail} 首）。预计每批播完自动轮换，整池播完为一轮。`;
}

/* 轮次中文数字（标注标题栏显示“第一轮”） */
function cnNum(n) {
  const CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (n <= 10) return CN[n] || String(n);
  if (n < 20) return '十' + (n % 10 ? CN[n % 10] : '');
  return String(n);
}

function renderRoundInfo() {
  const s = getState();
  const p = s.roundProgress;
  el.roundInfo.textContent = s.round > 0 ? `第${cnNum(s.round)}轮` : '未开始';
  el.roundProgressText.textContent = p.total > 0 ? `${p.played} / ${p.total}` : '—';
  el.roundProgressBar.style.width = p.total > 0 ? `${Math.round((p.played / p.total) * 100)}%` : '0%';
  updateDrawerInfo();
}

let showingWelcome = true;
function renderNowPlaying(file, idx) {
  const s = getState();
  if (!file) {
    showingWelcome = true;
    activePath = null; // 清当前曲，作废在途封面/歌词（S-C2）
    el.nowTitle.textContent = userPrefs.welcome.title;
    el.nowMeta.textContent = userPrefs.welcome.meta;
    applyCover(null);
    lyricsPath = null;
    currentLyrics = null;
    el.lyricsLine.classList.add('hidden');
    return;
  }
  showingWelcome = false;
  activePath = file ? file.path : null; // 当前曲 path（S-C2 竞态防护：丢弃过期刮削/封面结果）
  el.nowTitle.textContent = provider.baseName(file.path);
  const batchLen = s.batchFiles.length;
  el.nowMeta.textContent = parentDirName(file.path);
  el.roundPos.textContent = s.round > 0 ? `本轮第 ${s.roundProgress.played + 1} 首` : '本轮第 — 首';
  el.batchProgressBar.style.width = batchLen ? `${Math.round(((idx + 1) / batchLen) * 100)}%` : '0%';
  el.batchText.textContent = `本批 ${idx + 1} / ${batchLen}`;
  renderBatchList();
  renderRoundInfo();
  loadCover(file.path, file);
  loadLyrics(file.path);
  updateMediaSession(file);
}

/* ---------------- 封面与媒体会话 ---------------- */

const coverCache = new Map(); // path -> { url, mime }，LRU 上限 300 防内存泄漏
let activePath = null;        // 当前正在播放的文件路径（S-C2 竞态防护）

function parentDirName(p) {
  const parts = p.split(/[\\/]/);
  return parts.length >= 2 ? parts[parts.length - 2] : '—';
}

function cacheCover(path, url, mime) {
  if (coverCache.size >= 300) {
    const oldestKey = coverCache.keys().next().value;
    const old = coverCache.get(oldestKey);
    if (old && old.url) URL.revokeObjectURL(old.url);
    coverCache.delete(oldestKey);
  }
  coverCache.set(path, { url, mime });
}

/* 封面层（标注 Music_Player_变体 B 版）：等封面真正解码完成（100%）后再从唱片底下滑出 */
function playCoverSlide() {
  const rev = el.coverReveal;
  if (!rev) return;
  rev.classList.remove('replay');
  void rev.offsetWidth;          // 强制回流，保证同一封面连播时动画能重来
  rev.classList.add('replay');
  clearTimeout(playCoverSlide._t);
  playCoverSlide._t = setTimeout(() => rev.classList.remove('replay'), 2000);
}

function revealCover(url) {
  const img = el.coverRevealImg;
  img.hidden = false;
  const same = img.getAttribute('src') === url;
  let done = false;   // onload 与缓存兜底可能同时命中，保证只跑一次
  const go = () => {
    if (done) return;
    done = true;
    const wasOpen = el.player.classList.contains('has-cover');
    el.player.classList.add('has-cover');
    playerApplyWidth();
    // 已经展开时只换图不会有位移，补一次「滑出 + 淡入」，缓存命中同样播
    if (!same && wasOpen) playCoverSlide();
  };
  if (same && el.player.classList.contains('has-cover')) { go(); return; }
  img.onload = () => go();
  img.onerror = () => { el.player.classList.remove('has-cover'); playerApplyWidth(); };
  img.src = url;
  // 命中缓存（同一帧内已 decode）时 onload 不会再触发
  if (img.complete && img.naturalWidth > 0) go();
}

/* ---------- 封面区点击切换（开 ⇄ 关，可无限次）+ 防连点 ---------- */
const COVER_LOCK_MS = 1300;       // 与 1.2s 过渡对齐：动画期间点击一律吞掉
const COVER_BOUNCE_LIMIT = 6;     // 冷却期内被拦 6 次 → 判定为狂点，强制静默 2s
let coverLockUntil = 0;
let coverBounce = 0;
let coverPenaltyUntil = 0;
let coverTapOrigin = null;
let switchSettleUntil = 0;   // 切歌收拢窗口：期间吞掉再次点上一首/下一首

function coverTapGuard() {
  const now = performance.now();
  if (now < coverPenaltyUntil) return true;          // 惩罚冷却中，直接丢弃
  if (now < coverLockUntil) {
    coverBounce++;
    if (coverBounce >= COVER_BOUNCE_LIMIT) {         // 连续撞锁 → 阻断
      coverPenaltyUntil = now + 2000;
      coverLockUntil = coverPenaltyUntil;
      coverBounce = 0;
    }
    return true;
  }
  coverBounce = 0;
  return false;
}

function toggleCover() {
  if (performance.now() < switchSettleUntil) return;   // 切歌收拢中，不接管
  if (coverTapGuard()) return;
  el.coverReveal.classList.remove('replay');   // 手动切换接管，避免淡入动画压住收起
  const on = !el.player.classList.contains('has-cover');
  el.player.classList.toggle('has-cover', on);
  playerApplyWidth();
  coverLockUntil = performance.now() + COVER_LOCK_MS;
}

/* 唱针仪式：切歌时先抬针（.6s 过渡）、针离盘面后再停转；新歌起播时盘先转、针随后落回。
   目的：把"换片"这件事做出来，而不是唱片一直转、歌突然被换掉。 */
/* 切歌节拍表（全部相对"点击下一首/上一首"的时刻）
   0ms               点击
   0 ~ 300ms         【留白】什么都不动，让"按下"和"抬针"分成两个动作
   300ms             抬针开始（过渡 .48s）+ 展开态同时开始收拢
   500ms             针已离盘 → 停转 + 停声（先抬针再停，避免"盘停了声音还在"）
   300ms + 1500ms    展开态换片（新歌起播）；收起态是 300ms + 520ms
   换片 + 200ms      盘起转后针开始落
   换片 + 680ms      针落回盘面
   设计意图：留白给"我按了"一个呼吸，抬针/停转/落针三段各自可辨认，而不是一按就糊在一起 */
const CUE_PRE_MS = 300;          // 点击 → 抬针 的留白
const CUE_LIFT_SETTLE_MS = 200;  // 抬针 → 停转 的间隔（针先离盘，再停）
const CUE_DROP_DELAY_MS = 200;   // 起播 → 落针 的间隔（盘先起转，针再落）
const CUE_SWITCH_MS = 520;       // 无封面路径：抬针 → 换片
const CUE_COLLAPSE_MS = 1500;    // 有封面路径：收拢复位时长
let cueSpinTimer = 0;
let cuePauseTimer = 0;
let cuePreTimer = 0;
function armCueUp() {
  const p = el.player;
  if (!p) return;
  p.classList.add('cue-up');
  clearTimeout(cueSpinTimer);
  cueSpinTimer = setTimeout(() => { if (p) p.classList.add('cue-still'); }, CUE_LIFT_SETTLE_MS);
}
function armCueDown() {
  const p = el.player;
  if (!p) return;
  clearTimeout(cueSpinTimer);
  p.classList.remove('cue-still');                                                 // 盘先起转
  discWake();                                                                      // 盘从 0 渐加速（可能已被滑停收掉）
  setTimeout(() => { if (p) p.classList.remove('cue-up'); }, CUE_DROP_DELAY_MS);   // 针随后落回盘面
}

/* 切歌前的收拢：已展开时先把宽度 / 内容左缘 / 封面收回（1.5s），确认复位后再切歌，
   这样新歌的封面加载动画一定从一个干净收起的版面上开始，不会在旧版面上直接弹新图 */
function beginCollapse() {
  const p = el.player;
  el.coverReveal.classList.remove('replay');                // 入场动画 fill:both 会压住淡出
  p.classList.add('settling');                              // 宽度/左缘这条过渡放慢到 1.5s
  p.classList.remove('has-cover');                          // 触发收回：宽度、内容左移、封面缩回淡出
  playerApplyWidth();
  setTimeout(() => { p.classList.remove('settling'); }, CUE_COLLAPSE_MS);
}

/* 换片前的整套仪式：留白 → 抬针 → 停声 →（有封面时）收拢，返回"可以换片"要等的毫秒数。
   手动切歌和自然播完共用这一条时序，区别只在于最后是谁来换片。 */
function runCueRitual(hasCover) {
  const total = CUE_PRE_MS + (hasCover ? CUE_COLLAPSE_MS + 30 : CUE_SWITCH_MS);
  clearTimeout(cuePreTimer);
  clearTimeout(cuePauseTimer);
  cuePreTimer = setTimeout(() => {                           // 留白结束才开始抬针/收拢
    armCueUp();
    if (hasCover) beginCollapse();
    cuePauseTimer = setTimeout(() => {                       // 针离盘面后再停声
      try { if (!el.audioEl.paused) el.audioEl.pause(); } catch {}
    }, CUE_LIFT_SETTLE_MS);
  }, CUE_PRE_MS);
  return total;
}

function switchWithCollapse(fn) {
  const now = performance.now();
  if (now < switchSettleUntil) return;                       // 节拍窗口内：忽略连点
  const hasCover = playerHasCover();
  const swapAt = runCueRitual(hasCover);                     // 与自然播完同一条时序
  switchSettleUntil = now + swapAt;                          // 留白期也算在门内，防止连点打断节拍

  setTimeout(() => {
    switchSettleUntil = 0;
    const p = el.player;
    // 展开态：期间若被别处（列表点击/自动轮播）抢先切歌并重新展开，就放弃这次按钮切歌
    const settled = !hasCover || (!p.classList.contains('settling') && !p.classList.contains('has-cover'));
    if (settled) fn();                                       // 新歌起播时由 play 事件落针
  }, swapAt);
}

/* 只在「唱片位 + 封面块」内、且没有拖动位移时才当作点击（拖动是挪窗口/调宽度） */
el.player.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) { coverTapOrigin = null; return; }
  const t = e.target;
  coverTapOrigin = (t && (t.closest('.poster') || t.closest('.cover-reveal')))
    ? { x: e.clientX, y: e.clientY } : null;
}, true);

el.player.addEventListener('pointerup', (e) => {
  if (!coverTapOrigin) return;
  const dx = e.clientX - coverTapOrigin.x;
  const dy = e.clientY - coverTapOrigin.y;
  coverTapOrigin = null;
  if (Math.abs(dx) > 5 || Math.abs(dy) > 5) return;
  toggleCover();
});

el.player.addEventListener('pointercancel', () => { coverTapOrigin = null; });

const posterHit = el.coverBox ? el.coverBox.closest('.poster') : null;
if (posterHit) posterHit.title = '点击展开 / 收起封面';

function applyCover(url) {
  if (url) {
    // 变体 B 版：左侧唱片位常驻（继续转动），真实封面只在右侧封面层显示
    el.coverImg.hidden = true;
    el.coverBlur.hidden = true;
    el.coverBox.classList.add('has-art');
    revealCover(url);
  } else {
    el.coverImg.hidden = true;
    el.coverBlur.hidden = true;
    el.coverBox.classList.remove('has-art');
    el.coverRevealImg.hidden = true;
    el.coverRevealImg.removeAttribute('src');
    el.coverReveal.classList.remove('replay');
    el.player.classList.remove('has-cover');
    playerApplyWidth();
  }
}

async function loadCover(filePath, file) {
  const cached = coverCache.get(filePath);
  if (cached) {
    applyCover(cached.url);
    if (file && cached.url) updateMediaSession(file);
    return;
  }
  try {
    const res = await fetch(provider.coverUrl(filePath));
    if (filePath !== activePath) return; // 已切歌，丢弃过期封面（S-C2）
    if (!res.ok) {
      cacheCover(filePath, null, null);
      // 本地无封面：先保留当前展开状态（不清图、不缩回），等在线刮削结果决定
      // 有数据 → 换图 + 滑出；无数据 → 由刮削分支统一收起（避免切歌时封面先缩回再滑出）
      maybeScrape(filePath);
      return;
    }
    const mime = res.headers.get('Content-Type') || 'image/jpeg';
    const blob = await res.blob();
    if (filePath !== activePath) { URL.revokeObjectURL(URL.createObjectURL(blob)); return; } // 已切歌，丢弃
    const objUrl = URL.createObjectURL(blob);
    cacheCover(filePath, objUrl, mime);
    applyCover(objUrl);
    if (file) updateMediaSession(file);
  } catch {
    if (filePath === activePath) applyCover(null);
  }
}

function updateMediaSession(file) {
  if (!('mediaSession' in navigator) || !file) return;
  const cached = coverCache.get(file.path);
  const meta = {
    title: provider.baseName(file.path),
    artist: parentDirName(file.path),
  };
  if (cached && cached.url) {
    meta.artwork = [{ src: cached.url, sizes: '512x512', type: cached.mime || 'image/jpeg' }];
  }
  navigator.mediaSession.metadata = new MediaMetadata(meta);
}

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.setActionHandler('play', () => playback.play());
  navigator.mediaSession.setActionHandler('pause', () => playback.pause());
  navigator.mediaSession.setActionHandler('previoustrack', () => switchWithCollapse(() => playback.prev()));
  navigator.mediaSession.setActionHandler('nexttrack', () => switchWithCollapse(() => playback.next()));
  navigator.mediaSession.setActionHandler('seekto', (d) => {
    if (d && d.seekTime != null) el.audioEl.currentTime = d.seekTime;
  });
}

/* ---------------- 歌词走马灯 ---------------- */

const lyricsCache = new Map(); // path -> { source, lines?, text? }
let lyricsPath = null;         // 当前应显示歌词的文件路径（竞态防护）
let currentLyrics = null;      // 当前歌词数据

function loadLyrics(filePath) {
  lyricsPath = filePath;
  const cached = lyricsCache.get(filePath);
  if (cached) {
    applyLyrics(cached, filePath);
    if (cached.source === 'none') maybeScrape(filePath);
    return;
  }
  el.lyricsLine.classList.add('hidden');
  fetch(provider.lyricsUrl(filePath))
    .then((r) => (r.ok ? r.json() : { source: 'none' }))
    .then((data) => {
      lyricsCache.set(filePath, data);
      applyLyrics(data, filePath);
      if (data.source === 'none') maybeScrape(filePath);
    })
    .catch(() => {
      lyricsCache.set(filePath, { source: 'none' });
    });
}

function applyLyrics(data, filePath) {
  if (filePath !== lyricsPath) return; // 已切到别的文件，丢弃过期结果
  if (!data || data.source === 'none' || (!Array.isArray(data.lines) && !data.text)) {
    currentLyrics = null;
    lyricIdx = -1; lastK = -1; lyricAnimating = false;
    el.lyricsLine.classList.add('hidden');
    // 播放中不撤顶部歌词：可能还在等在线刮削，撤了会闪
    if (el.audioEl.paused) hdRestore();
    return;
  }
  currentLyrics = {
    source: data.source,
    text: data.text,
    lines: normalizeLyricLines(data.lines),
  };
  lyricIdx = -1; lastK = -1; lyricAnimating = false;
  el.lyricsLine.classList.remove('hidden');
  updateLyrics(el.audioEl.currentTime);
  // 歌词比 play 事件晚到：补排一次（复用起播时摇好的目标时刻，仍是 ≤3s 内）
  if (!el.audioEl.paused && !hdEnterTimer && !el.hd.classList.contains('lyrics-mode')) hdArmRandom();}

/* 歌词行规范化：把「同一时间戳紧邻两行」合并成 原文 + 译文（双语 lrc 的常见写法）。
   服务端已带 trans 字段的行原样保留。 */
function normalizeLyricLines(lines) {
  if (!Array.isArray(lines) || !lines.length) return lines;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i];
    const nxt = lines[i + 1];
    if (
      nxt && cur.text && nxt.text &&
      cur.text !== nxt.text &&
      Math.abs(nxt.time - cur.time) <= 0.06
    ) {
      out.push({ time: cur.time, text: cur.text, trans: nxt.text });
      i++;
      continue;
    }
    const item = { time: cur.time, text: cur.text };
    if (cur.trans) item.trans = cur.trans;
    out.push(item);
  }
  return out;
}

/* ---------- 歌词：两行滚动 + 当前句逐字高亮 + 低频呼吸 ---------- */
const lyricUI = {
  stack: $('lyricStack'),
  cur: $('lyricRowCur'),
  next: $('lyricRowNext'),
  curInner: $('lyricRowCur').querySelector('.lyric-inner'),
  nextInner: $('lyricRowNext').querySelector('.lyric-inner'),
};
let lyricIdx = -1;          // 当前行索引（-1 = 还没到第一句）
let lyricAnimating = false; // 正在做上推动画
let lastK = -1;             // 上次写入的逐字进度，避免重复重绘

function updateLyrics(time) {
  if (!currentLyrics) return;
  if (Array.isArray(currentLyrics.lines) && currentLyrics.lines.length) {
    const lines = currentLyrics.lines;
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].time <= time) idx = i;
      else break;
    }
    if (idx !== lyricIdx) {
      lyricIdx = idx;
      renderLyricRow(idx);
      hdShowLine(idx);
    } else {
      updateKaraoke(time);
    }
  } else if (currentLyrics.text) {
    setLyricText(currentLyrics.text.replace(/\s+/g, ' ').trim());
  }
}

/* 把第 idx 句放进上行；前一行动画结束后把「下一句」升为当前 */
function renderLyricRow(idx) {
  const lines = currentLyrics.lines;
  const cur = idx >= 0 ? lines[idx] : null;
  const nxt = lines[idx + 1] || null;

  if (!cur || lyricAnimating) {
    // 首句 / 拖动进度跳转：直接落位，不做滚动
    lyricAnimating = false;
    lyricUI.stack.style.transition = 'none';
    lyricUI.stack.style.transform = 'translateY(0)';
    lyricUI.curInner.textContent = cur ? cur.text : '♪';
    lyricUI.nextInner.textContent = nxt ? nxt.text : '';
    lastK = -1;
    fitCurRow();
    updateKaraoke(el.audioEl.currentTime);
    return;
  }
  // 正常切句：下行本来就写着这一句，整体上移一行即可
  if (lyricUI.nextInner.textContent !== cur.text) lyricUI.nextInner.textContent = cur.text;
  lyricAnimating = true;
  lyricUI.stack.style.transition = 'transform .38s cubic-bezier(.25,.8,.3,1)';
  lyricUI.stack.style.transform = 'translateY(-36px)';
}

lyricUI.stack.addEventListener('transitionend', (e) => {
  if (e.propertyName !== 'transform' || !lyricAnimating) return;
  lyricAnimating = false;
  // 复位：上行 ← 下行内容（视觉完全衔接），下行换成再下一句
  lyricUI.curInner.textContent = lyricUI.nextInner.textContent;
  const lines = currentLyrics && currentLyrics.lines ? currentLyrics.lines : null;
  lyricUI.nextInner.textContent = (lines && lines[lyricIdx + 2]) ? lines[lyricIdx + 2].text : '';
  lyricUI.stack.style.transition = 'none';
  lyricUI.stack.style.transform = 'translateY(0)';
  lastK = -1;
  fitCurRow();
  updateKaraoke(el.audioEl.currentTime);
});

/* 当前句按句内时间推进渐变位置；1% 步进，最多 101 次写入/句 */
function updateKaraoke(time) {
  if (!currentLyrics || !Array.isArray(currentLyrics.lines) || lyricIdx < 0) return;
  const lines = currentLyrics.lines;
  const cur = lines[lyricIdx];
  if (!cur) return;
  const nxt = lines[lyricIdx + 1];
  const span = Math.max(0.35, (nxt ? nxt.time : cur.time + 4) - cur.time);
  const p = Math.max(0, Math.min(1, (time - cur.time) / span));
  const k = Math.round(p * 100);
  if (k !== lastK) {
    lastK = k;
    lyricUI.curInner.style.setProperty('--k', k + '%');
  }
}

/* 当前句超宽 → 横向缓慢往返（渐变跟着文字走） */
function fitCurRow() {
  const avail = el.lyricsLine.clientWidth;
  const w = lyricUI.curInner.scrollWidth;
  const over = w > avail + 2;
  lyricUI.cur.classList.toggle('marquee', over);
  if (over) {
    const dist = w - avail + 8;
    lyricUI.curInner.style.setProperty('--mq-x', (-dist) + 'px');
    lyricUI.curInner.style.setProperty('--mq-dur', Math.max(7, Math.round(dist / 55)) + 's');
  }
}

function setLyricText(text) {
  if (lyricUI.curInner.textContent === text) return;
  lyricIdx = -1;
  lyricUI.stack.style.transition = 'none';
  lyricUI.stack.style.transform = 'translateY(0)';
  lyricUI.curInner.textContent = text;
  lyricUI.nextInner.textContent = '';
  lyricUI.cur.classList.remove('marquee');
  lastK = -1;
  hdShowText(text);
}

/* ---------------- 顶部菜单：文字信息 ⇄ 歌词滚屏 ----------------
   播放开始后 0~3s 内随机时刻，header 文字向左滑出淡出 → 换歌词两行从右往左滚过；
   曲终（ended）恢复文字信息，下一首起播再随机进入。 */
const HD_SCROLL_SPEED = 190;     // 横向速度（px/s）
const HD_MIN_MS = 4500;          // 单句最短滚动时长（短句别一闪而过）
const HD_MAX_MS = 7500;          // 上限（超长句略加速，别慢到凝固）
const HD_RANDOM_MS = 2700;       // 播放开始后 0~2.7s 随机（留 300ms 余量，实测事件派发有 ~240ms 抖动）
const HD_END_HOLD_MS = 3000;     // 曲终后文字信息至少露 3 秒，再进入下一个轮回

let hdEnterTimer = 0;
let hdArmedPath = null;          // 已排好随机计时的曲目路径
let hdTargetAt = 0;              // 本次起播的目标切换时刻（performance.now 基准）
let hdHoldUntil = 0;             // 曲终后的保底展示窗口终点（新曲起播不得早于它切歌词）
const hdState = { idx: -9, main: '', sub: '' };

function hdHasLines() {
  return !!(currentLyrics && Array.isArray(currentLyrics.lines) && currentLyrics.lines.length);
}

/* 单行滚动：换文本 + 按文字宽算时长 + 重播动画 */
function hdTrackRun(node, text) {
  if (!node) return;
  const has = !!text;
  node.textContent = has ? text : '';
  node.style.visibility = has ? 'visible' : 'hidden';
  if (!has) return;
  // getBoundingClientRect 拿到的是原始文字宽（动画位移不影响布局宽）
  const w = node.getBoundingClientRect().width || 0;
  const vw = window.innerWidth || 1200;
  const dur = Math.min(HD_MAX_MS, Math.max(HD_MIN_MS, ((w + vw) / HD_SCROLL_SPEED) * 1000)) / 1000;
  node.style.setProperty('--hd-dur', dur.toFixed(2) + 's');
  // 改 --hd-dur 不会重播：清一次 animation-name 再强制 reflow，让新一句从右缘重新进场
  node.style.animationName = 'none';
  void node.offsetWidth;
  node.style.animationName = '';
}

/* 第 idx 句写进顶部两行（上行原文，下行译文） */
function hdShowLine(idx, force) {
  if (!hdHasLines()) return;
  if (!force && !el.hd.classList.contains('lyrics-mode')) return; // 还没上场就不写
  const ln = idx >= 0 ? currentLyrics.lines[idx] : null;
  const main = ln && ln.text ? ln.text : '♪';
  const sub = ln && ln.trans ? ln.trans : '';
  if (!force && hdState.idx === idx && hdState.main === main && hdState.sub === sub) return;
  hdState.idx = idx; hdState.main = main; hdState.sub = sub;
  hdTrackRun(el.hdLyricMain, main);
  hdTrackRun(el.hdLyricSub, sub);
}

/* 纯文本歌词（无时间轴）走这里 */
function hdShowText(text) {
  const t = text || '♪';
  if (hdState.idx === -2 && hdState.main === t) return;
  hdState.idx = -2; hdState.main = t; hdState.sub = '';
  hdTrackRun(el.hdLyricMain, t);
  hdTrackRun(el.hdLyricSub, '');
}

function hdEnterLyrics() {
  const hasLines = hdHasLines();
  const hasText = !!(currentLyrics && currentLyrics.text);
  if (!hasLines && !hasText) return;
  el.hd.classList.add('lyrics-mode');
  el.hdLyrics.classList.remove('is-paused');
  if (hasLines) hdShowLine(lyricIdx, true);
  else hdShowText((currentLyrics.text || '').replace(/\s+/g, ' ').trim());
}

/* 恢复顶部文字信息（清掉随机计时） */
function hdRestore() {
  clearTimeout(hdEnterTimer);
  hdEnterTimer = 0;
  hdArmedPath = null;
  hdTargetAt = 0;
  hdState.idx = -9; hdState.main = ''; hdState.sub = '';
  el.hd.classList.remove('lyrics-mode');
  el.hdLyrics.classList.remove('is-paused');
}

/* 起播：先露出文字信息，再在 0~3s 内随机一个时刻切到歌词。
   目标时刻只摇一次（起播那刻算），歌词晚到也复用同一个目标，保证不超过 3s。
   force=true 才会打断已有计时（切歌/新曲）；补排一律不打断，避免歌词态被反复撤掉又进入造成闪烁。 */
function hdArmRandom(force) {
  if (!force && (hdEnterTimer || el.hd.classList.contains('lyrics-mode'))) {
    if (el.hd.classList.contains('lyrics-mode')) hdArmedPath = lyricsPath;
    return;
  }
  clearTimeout(hdEnterTimer);
  hdEnterTimer = 0;
  hdState.idx = -9; hdState.main = ''; hdState.sub = '';
  el.hd.classList.remove('lyrics-mode');
  el.hdLyrics.classList.remove('is-paused');
  // 歌词还没到：先记曲目，等 applyLyrics 再排（目标时刻已由 hdNotePlayStart 摇好）
  if (!hdHasLines() && !(currentLyrics && currentLyrics.text)) {
    hdArmedPath = null;
    return;
  }
  hdArmedPath = lyricsPath;
  const now = performance.now();
  if (!hdTargetAt || hdTargetAt < now - HD_RANDOM_MS - 2000) hdTargetAt = now + Math.random() * HD_RANDOM_MS;
  const delay = Math.max(0, hdTargetAt - now);
  hdEnterTimer = setTimeout(() => {
    hdEnterTimer = 0;
    hdEnterLyrics();
  }, delay);
}

/* 起播那一刻摇一次随机目标时刻（若处于曲终 3 秒保底窗口内，则不得早于窗口结束） */
function hdNotePlayStart() {
  const now = performance.now();
  const randomAt = now + Math.random() * HD_RANDOM_MS;
  hdTargetAt = hdHoldUntil > now ? Math.max(randomAt, hdHoldUntil) : randomAt;
}

let hdSrcKey = ''; // 上一次记录的音源（同一音源内不重摇随机时刻）

el.audioEl.addEventListener('play', () => {
  const key = el.audioEl.currentSrc || '';
  const sameTrack = key && key === hdSrcKey;
  if (key && !sameTrack) hdSrcKey = key;

  // 同一音源续播（暂停后恢复）：保持歌词态，只解冻滚动
  if (sameTrack && el.hd.classList.contains('lyrics-mode') && hdArmedPath === lyricsPath) {
    el.hdLyrics.classList.remove('is-paused');
    return;
  }
  // 已在等随机点
  if (sameTrack && hdEnterTimer && hdArmedPath === lyricsPath) {
    el.hdLyrics.classList.remove('is-paused');
    return;
  }
  hdNotePlayStart(); // 新曲 / 首次起播：重新摇目标时刻
  hdArmRandom(true);
});

el.audioEl.addEventListener('pause', () => {
  if (el.hd.classList.contains('lyrics-mode')) el.hdLyrics.classList.add('is-paused');
});

el.audioEl.addEventListener('ended', () => {
  // 曲终：顶部文字信息至少露 HD_END_HOLD_MS（下一首再快也不提前切走）
  hdHoldUntil = performance.now() + HD_END_HOLD_MS;
  hdRestore();
});

/* ---------------- 顶部菜单：文字信息 ⇄ 歌词滚屏（完） ---------------- */

/* 播放中每 100ms 推进一次（比 timeupdate 的 4Hz 顺滑，又不会每帧重绘文字） */
let lastLyricTick = 0;
(function lyricLoop() {
  requestAnimationFrame(lyricLoop);
  if (!currentLyrics || !document.getElementById('player').classList.contains('playing')) return;
  const now = performance.now();
  if (now - lastLyricTick < 100) return;
  lastLyricTick = now;
  updateLyrics(el.audioEl.currentTime);
})();

/* ---------------- 在线刮削（设置开关 + 切歌补刮削） ---------------- */

let scrapeEnabled = false;

function loadScrapePref() {
  try { scrapeEnabled = !!((JSON.parse(localStorage.getItem('mp.scrape') || 'null') || {}).enabled); } catch { scrapeEnabled = false; }
  const cb = $('scrapeEnabled');
  if (cb) cb.checked = scrapeEnabled;
}

function bindScrapePref() {
  const cb = $('scrapeEnabled');
  if (!cb) return;
  cb.addEventListener('change', (e) => {
    scrapeEnabled = e.target.checked;
    try { localStorage.setItem('mp.scrape', JSON.stringify({ enabled: scrapeEnabled })); } catch {}
  });
}

/** 本地无歌词/封面时，若开关开启则联网刮削当前曲目（复用现有歌词/封面渲染） */
const scrapeLog = []; // 最近刮削记录（内存级，最多 5 条）
let scrapeBusy = false; // 防并发：同一时刻只刮削一曲

function setScrapeStatus(text, cls) {
  const line = $('scrapeStatusLine');
  if (!line) return;
  line.textContent = text;
  line.className = 'scrape-status' + (cls ? ' ' + cls : '');
}

function renderScrapeLog() {
  const ul = $('scrapeLogList');
  if (!ul) return;
  ul.innerHTML = '';
  for (const it of scrapeLog) {
    const li = document.createElement('li');
    const res = [];
    if (it.lyrics === 'ok') res.push('歌词✓');
    else if (it.lyrics === 'fail') res.push('歌词✗');
    if (it.cover === 'ok') res.push('封面✓');
    else if (it.cover === 'fail') res.push('封面✗');
    const song = document.createElement('span');
    song.className = 'lg-song'; song.textContent = it.song;
    const r = document.createElement('span');
    r.className = 'lg-res'; r.textContent = res.join(' ');
    li.className = (it.lyrics === 'ok' || it.cover === 'ok') ? 'ok' : 'fail';
    li.appendChild(song); li.appendChild(r);
    ul.appendChild(li);
  }
}

function pushScrapeLog(entry) {
  scrapeLog.unshift(entry);
  if (scrapeLog.length > 5) scrapeLog.pop();
  renderScrapeLog();
}

async function maybeScrape(filePath) {
  if (!scrapeEnabled) return;
  if (scrapeBusy) return;
  scrapeBusy = true;
  const name = provider.baseName(filePath) || filePath;
  // pending 反馈：封面占位音符微动 + 歌词行显示搜索文案
  el.coverBox.classList.add('scraping');
  el.lyricsLine.classList.remove('hidden');
  setLyricText('正在搜索歌词…');
  setScrapeStatus('正在刮削：' + name, 'busy');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch('/api/scrape?path=' + encodeURIComponent(filePath), { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    el.coverBox.classList.remove('scraping');
    const log = { song: name, lyrics: 'fail', cover: 'fail' };
    if (data.lyrics && (data.lyrics.lines || data.lyrics.text)) {
      lyricsCache.set(filePath, data.lyrics);
      applyLyrics(data.lyrics, filePath);
      log.lyrics = 'ok';
    } else {
      el.lyricsLine.classList.add('hidden');
    }
    if (data.cover && data.cover.url) {
      const img = new Image();
      img.onload = () => {
        cacheCover(filePath, data.cover.url, 'image/jpeg');
        applyCover(data.cover.url);
        updateMediaSession({ path: filePath });
      };
      img.onerror = () => { cacheCover(filePath, null, null); applyCover(null); };
      img.src = data.cover.url;
      log.cover = 'ok';
    } else {
      log.cover = 'fail';
      if (filePath === activePath) applyCover(null);   // 线上也没有封面 → 这时才收起
    }
    if (log.lyrics === 'ok' || log.cover === 'ok') setScrapeStatus('已完成：' + name, 'ok');
    else setScrapeStatus('未找到：' + name, 'fail');
    pushScrapeLog(log);
  } catch (err) {
    clearTimeout(timer);
    el.coverBox.classList.remove('scraping');
    el.lyricsLine.classList.add('hidden');
    if (filePath === activePath) applyCover(null);   // 刮削失败 → 无封面数据，收起
    setScrapeStatus('刮削失败：' + name, 'fail');
    pushScrapeLog({ song: name, lyrics: 'fail', cover: 'fail' });
  } finally {
    scrapeBusy = false;
  }
}

function renderBatchList() {
  const s = getState();
  const files = s.batchFiles;
  const curIdx = playback.currentIndex();
  const partials = s.scheduler ? new Set(s.scheduler.partialsOf()) : new Set();
  const qc = $('queueCount');
  if (qc) qc.textContent = files.length;
  const qt = $('queueTitle');
  if (qt) qt.textContent = files.length ? `（${curIdx + 1} / ${files.length}）` : '';
  el.batchList.innerHTML = files
    .map((f, i) => {
      let cls = 'pending';
      if (i === curIdx) cls = 'playing';
      else if (partials.has(i)) cls = 'partial';
      else if (i < curIdx) cls = 'played';
      return `<div class="batch-item${cls === 'playing' ? ' active' : ''}${cls === 'partial' ? ' partial-item' : ''}" data-i="${i}" title="点击跳转到这首">` +
        `<span class="pt"></span>` +
        `<span class="name" title="${escapeHtml(f.path)}">${String(i + 1).padStart(2, '0')}. ${escapeHtml(provider.baseName(f.path))}</span>` +
        `<span class="st ${cls}">${cls === 'playing' ? '▶' : cls === 'played' ? '✓' : cls === 'partial' ? '◐' : ''}</span></div>`;
    })
    .join('');
  const active = el.batchList.querySelector('.batch-item.active');
  // 抽屉关闭时其位移区域仍算 main 的可滚动溢出，scrollIntoView 会把 main 横向拖偏——仅抽屉可见时才滚动
  if (active && $('queueDrawer').classList.contains('open')) {
    active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function showPlayError(msg) {
  el.playError.textContent = msg;
  el.playError.classList.remove('hidden');
}

function hidePlayError() {
  el.playError.classList.add('hidden');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ---------------- 提示与状态机 ---------------- */

let toastTimer = null;
let skipCount = 0; // 本轮累计跳过的损坏文件数
let roundStartTime = 0; // 本轮起始时间戳（完成态统计"用时"）

function toast(msg) {
  let t = document.getElementById('toastBox');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toastBox';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

/** 应用状态机模式：idle / has_dirs / scanning / scanned / playing */
function appMode() {
  const s = getState();
  if (s.scan && s.scan.status === 'scanning') return 'scanning';
  if (s.scheduler) return 'playing';
  if (s.pool && s.pool.length) return 'scanned';
  if (s.dirs && s.dirs.length) return 'has_dirs';
  return 'idle';
}

/** 按状态统一刷新所有按钮可用性与悬停提示（配合 subscribe 自动触发） */
function updateControls() {
  const s = getState();
  const playing = !!(s.scheduler); // 是否有进行中的轮次
  const scanning = !!(s.scan && s.scan.status === 'scanning'); // 是否有后台刷新
  const hasDirs = Array.isArray(s.dirs) && s.dirs.length > 0;

  // 添加目录：仅扫描中禁用；播放中允许（添加后自动增量收录，不打断当前轮次）
  el.addDirBtn.disabled = scanning;
  el.addDirBtn.title = scanning
    ? '媒体库刷新中，请稍候'
    : playing
      ? '播放中可添加目录（自动收录，下一轮生效）'
      : '浏览本机盘符或输入 UNC 路径，选择媒体库目录';

  // 刷新媒体库：仅扫描中禁用；播放中允许（后台进行，不打断播放，下一轮生效）
  el.scanBtn.disabled = scanning || !hasDirs;
  el.scanBtn.title = scanning
    ? '媒体库刷新中…（当前播放不受影响）'
    : playing
      ? '刷新媒体库：可「立即切换到新池重播」或「仅后台更新，下一轮生效」'
      : hasDirs
        ? '递归扫描所选目录中的音频（mp3/wav/flac/aac/ogg/m4a/opus）'
        : '请先添加至少一个目录';

  // 左侧「开始轮播」：播放中禁用，避免误重建当前轮
  const sp = $('startPlayBtn');
  if (sp) {
    sp.disabled = playing;
    const modeDesc = playMode === 'sequential' ? '按目录顺序抽取 20 首' : '随机抽取 20 首';
    sp.title = playing
      ? '播放中，请先「停止」再开始新一轮'
      : `从媒体库${modeDesc}，启动一轮轮播`;
  }

  const atFirst = playing && playback.currentIndex() <= 0;
  el.prevBtn.disabled = !playing || atFirst;
  el.prevBtn.title = playing
    ? atFirst
      ? '本批第一首，无上一首'
      : '回到本批上一首（不计入已播）'
    : '未开始播放';
  el.nextBtn.disabled = !playing;
  el.nextBtn.title = playing ? '跳过当前曲目（计入已播）' : '未开始播放';
  el.playPauseBtn.disabled = !playing;
  el.playPauseBtn.title = playing ? '播放 / 暂停（快捷键：空格）' : '未开始播放';

  el.skipBatchBtn.disabled = !playing;
  el.skipBatchBtn.title = playing ? '放弃本批剩余，计入已播，提前进入下一批' : '未开始播放';
}

/* ---------------- 目录管理 ---------------- */

function addDir(p) {
  const v = (p != null ? p : el.dirInput.value).trim();
  if (!v) {
    toast('请输入媒体库路径');
    return;
  }
  if (getState().scan && getState().scan.status === 'scanning') {
    toast('媒体库刷新中，稍后再添加');
    return;
  }
  const dirs = getState().dirs;
  const norm = v.replace(/[\\/]+$/, '');
  if (dirs.some((d) => d.toLowerCase() === norm.toLowerCase())) {
    toast('该目录已添加');
    el.dirInput.value = '';
    return;
  }
  const pool = getState().pool;
  const hasPool = Array.isArray(pool) && pool.length > 0;
  setState({ dirs: [...dirs, norm] });
  el.dirInput.value = '';
  persistSession();
  renderDirs();
  if (hasPool) {
    // 已有媒体库：自动只扫描新目录并入池，不打断当前播放
    toast('正在收录新目录…');
    startScan([norm], 'incremental');
  } else {
    toast('已添加目录，点「刷新媒体库」扫描收录');
  }
}

function removeDir(i) {
  const mode = appMode();
  if (mode === 'scanning') {
    toast('扫描中，无法移除目录');
    return;
  }
  const target = getState().dirs[i];
  if (target == null) return;
  // S-2 危险操作确认：移除目录需二次确认，防止误删列表项
  confirmDialog(
    '移除目录',
    `从播放列表移除「<b>${escapeHtml(target)}</b>」？<br>仅从列表移除，不会删除磁盘文件。`,
    {
      okText: '移除',
      cancelText: '取消',
      ok: () => {
        const dirs = getState().dirs.slice();
        dirs.splice(i, 1);
        setState({ dirs });
        persistSession();
        renderDirs();
        if (appMode() === 'playing') {
          toast('已移除目录。点「刷新媒体库」可立即切换到新池重播，或仅后台更新');
        } else {
          toast('已移除目录。点「刷新媒体库」应用变更');
        }
      },
    },
  );
}

/* ---------------- 目录浏览弹窗 ---------------- */

let pickerPath = null; // 当前浏览的路径；null 表示"本机盘符"根视图

function plEmpty(msg) {
  return `<div class="pl-empty">${escapeHtml(msg)}</div>`;
}
function plErr(msg) {
  return `<div class="pl-err">${escapeHtml(msg)}</div>`;
}

function openPicker() {
  el.pickerModal.classList.remove('hidden');
  el.pickerPath.value = '';
  loadPickerRoot();
  placeModal(el.pickerModal, '#libDrawer');
}

function closePicker() {
  el.pickerModal.classList.add('hidden');
  resetModal(el.pickerModal);
}

async function loadPickerRoot() {
  pickerPath = null;
  el.pickerPath.value = '';
  el.pickerCur.textContent = '本机盘符 / 网络驱动器';
  try {
    const r = await provider.listDrives();
    if (!r.ok) {
      el.pickerList.innerHTML = plErr(r.error || '无法枚举盘符');
      return;
    }
    const drives = r.drives || [];
    el.pickerList.innerHTML = drives.length
      ? drives
          .map(
            (d) =>
              `<div class="pl-item" data-path="${escapeHtml(d.path)}"><span class="ico drive">💿</span><span class="lbl drive">本地盘 ${escapeHtml(d.name)}</span></div>`,
          )
          .join('')
      : plEmpty('未发现可用盘符');
  } catch (e) {
    el.pickerList.innerHTML = plErr(e.message);
  }
}

async function loadPickerDir(path) {
  pickerPath = path;
  el.pickerPath.value = path;
  el.pickerCur.textContent = path;
  try {
    const r = await provider.listDir(path);
    if (!r.ok) {
      el.pickerList.innerHTML = plErr(r.error + (r.hint ? '；' + r.hint : ''));
      return;
    }
    if (!r.readable) {
      el.pickerList.innerHTML = plErr('目录不可读，请检查共享权限。');
      return;
    }
    const dirs = (r.dirs || [])
      .map((n) => `<div class="pl-item" data-path="${escapeHtml(path + '\\' + n)}"><span class="ico">📁</span><span class="lbl">${escapeHtml(n)}</span></div>`)
      .join('');
    const files = (r.files || [])
      .map((n) => `<div class="pl-item file"><span class="ico">🎵</span><span class="lbl">${escapeHtml(n)}</span></div>`)
      .join('');
    el.pickerList.innerHTML = (dirs + files) || plEmpty('（该目录为空，可直接「选择文件夹」）');
  } catch (e) {
    el.pickerList.innerHTML = plErr(e.message);
  }
}

function parentPath(p) {
  if (!p) return null;
  const norm = p.replace(/[\\/]+$/, '');
  const m = /^(.*[\\/])([^\\/]+)$/.exec(norm);
  if (!m) return null;
  const par = m[1].replace(/[\\/]+$/, '');
  if (/^[a-zA-Z]:$/i.test(par)) return null; // 盘符根 -> 回到根视图
  return par || null;
}

function usePicker() {
  const target = pickerPath || el.pickerPath.value.trim();
  if (!target) return;
  addDir(target);
  closePicker();
}

el.addDirBtn.addEventListener('click', () => addDir());   // 直接添加（直觉：输入即录）
el.browseBtn.addEventListener('click', openPicker);        // 浏览目录（网络路径可视化，可选）
el.seqMode.checked = playMode === 'sequential';
el.seqMode.addEventListener('change', () => {
  playMode = el.seqMode.checked ? 'sequential' : 'random';
  try { localStorage.setItem('mp.playMode', playMode); } catch {}
});
el.pickerList.addEventListener('click', (e) => {
  const it = e.target.closest('.pl-item');
  if (it && it.dataset.path) loadPickerDir(it.dataset.path);
});
el.pickerGoBtn.addEventListener('click', () => {
  const v = el.pickerPath.value.trim();
  if (v) loadPickerDir(v);
});
el.pickerPath.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const v = el.pickerPath.value.trim();
    if (v) loadPickerDir(v);
  }
});
el.pickerRootBtn.addEventListener('click', loadPickerRoot);
el.pickerUpBtn.addEventListener('click', () => {
  const par = parentPath(pickerPath);
  if (par === null) loadPickerRoot();
  else loadPickerDir(par);
});
el.pickerUseBtn.addEventListener('click', usePicker);
el.pickerCancelBtn.addEventListener('click', closePicker);

/* ---------------- 扫描 ---------------- */

const pollTimers = new Map(); // 按 requestId 绑定轮询定时器（S-C1：扫描任务唯一性，防并发轮询错乱）
let pendingApply = 'update'; // 本轮刷新完成后如何生效：'switch' 立即切换 / 'update' 下一轮生效

/** 停止并移除指定 requestId 的轮询定时器 */
function stopPoll(requestId) {
  const t = pollTimers.get(requestId);
  if (t) clearInterval(t);
  pollTimers.delete(requestId);
}

/** 判断是否为盘符根目录（C:\ 等）或路径根（\\ 或 /）——S-5 根目录强警告 */
function isRootDir(p) {
  if (typeof p !== 'string' || !p) return false;
  return /^[A-Za-z]:[\\/]?$/.test(p.trim()) || p.trim() === '\\' || p.trim() === '/';
}

/** confirmDialog 的 Promise 封装（S-5 扫描前确认等） */
function confirmAsync(title, msg, opts = {}) {
  return new Promise((resolve) => {
    confirmDialog(title, msg, { ...opts, ok: () => resolve(true), cancel: () => resolve(false) });
  });
}

async function startScan(paths, mode = 'full', apply = 'update') {
  pendingApply = apply;
  if (!paths || !paths.length) return;
  // 根目录/盘符强警告（S-5）：默认需确认才扫，防全盘递归
  const roots = paths.filter(isRootDir);
  if (roots.length) {
    const ok = await confirmAsync(
      '扫描根目录',
      `您添加了根目录/盘符：<b>${escapeHtml(roots.join('、'))}</b>。<br>递归扫描可能包含海量文件、耗时很长。是否继续？`,
      { okText: '仍要扫描', cancelText: '取消' },
    );
    if (!ok) return;
  }
  setState({ scan: { status: 'scanning', mode, scanned: 0, total: 0, skipped: [] } });
  if (mode === 'full') {
    // 全量刷新时收起旧统计，避免"旧库"与"新库"信息混淆
    el.planBox.classList.add('hidden');
    el.restoreBanner.classList.add('hidden');
  }
  renderScanStatus(getState().scan);
  try {
    const { requestId } = await provider.startScan(paths);
    setState({ scan: { ...getState().scan, requestId } });
    pollTimers.set(requestId, setInterval(() => pollScan(requestId), 600));
  } catch (e) {
    setState({ scan: { status: 'error', mode, error: e.message } });
    renderScanStatus(getState().scan);
  }
}

async function pollScan(requestId) {
  let s;
  try {
    s = await provider.scanStatus(requestId);
  } catch (e) {
    stopPoll(requestId);
    setState({ scan: { ...getState().scan, status: 'error', error: e.message } });
    renderScanStatus(getState().scan);
    return;
  }
  setState({ scan: { ...getState().scan, status: s.status, scanned: s.scanned, total: s.total, skipped: s.skipped } });
  renderScanStatus(s);
  if (s.status === 'done') {
    stopPoll(requestId);
    await loadPool(requestId, getState().scan.mode || 'full', pendingApply);
    if (s.truncated) toast('扫描超限或超时，仅收录部分文件。建议将超大目录拆分为具体子目录后再扫描');
  } else if (s.status === 'error') {
    stopPoll(requestId);
    setState({ scan: { status: 'error', error: s.error, mode: getState().scan.mode } });
    renderScanStatus(getState().scan);
  }
}

async function loadPool(requestId, mode = 'full', apply = 'update') {
  const all = [];
  let offset = 0;
  for (;;) {
    const r = await provider.fetchFiles(requestId, offset, 2000);
    all.push(...r.files);
    if (all.length >= r.total) break;
    offset = all.length;
  }
  // 全路径自然排序：目录按名称、目录内文件按自然序（track2 < track10），保证顺序模式确定
  all.sort((a, b) => naturalCollator.compare(a, b));
  if (mode === 'incremental') {
    // 增量收录：只把新目录的文件并入现有池，不替换、不打断当前轮次
    const merged = getState().pool.slice();
    const seen = new Set(merged);
    let added = 0;
    for (const f of all) {
      if (!seen.has(f)) {
        seen.add(f);
        merged.push(f);
        added++;
      }
    }
    // 增量合并后重新自然排序，保证顺序模式下全局仍按目录/文件名有序
    merged.sort((a, b) => naturalCollator.compare(a, b));
    const playing = !!(getState().scheduler);
    // 播放中：只更新池，当前轮进度（旧池快照）保持不变
    if (playing) setState({ pool: merged });
    else setState({ pool: merged, roundProgress: { ...getState().roundProgress, total: merged.length } });
    renderPoolStats(merged);
    renderRoundInfo();
    setState({ scan: { status: 'idle', mode, scanned: 0, total: 0, skipped: [] } });
    renderScanStatus(getState().scan);
    toast(added ? `已收录新目录：新增 ${added} 首（下一轮生效，当前轮次不受影响）` : '该目录已在媒体库中（无新增）');
  } else {
    // 全量刷新：替换为最新池
    const prevTotal = getState().pool.length;
    const playing = !!(getState().scheduler);
    // 播放中保留当前轮进度（旧池快照），未播放则重置
    setState({ pool: all, roundProgress: playing ? getState().roundProgress : { played: 0, total: all.length } });
    renderPoolStats(all);
    setState({ scan: { status: 'idle', mode, scanned: 0, total: 0, skipped: [] } });
    renderScanStatus(getState().scan);
    const delta = all.length - prevTotal;
    const diff = delta ? `（${delta > 0 ? '+' : ''}${delta}）` : '';

    if (apply === 'switch' && playing) {
      // 强制切换媒体池：丢弃当前轮，立即用新媒体池重新开始一轮播放
      toast(`已切换到新媒体池：共 ${all.length} 首${diff}，重新开始新一轮`);
      startRound(getState().round + 1);
      return; // persistSession 由 startRound 内部完成
    }
    renderPlan(all);
    renderRoundInfo();
    toast(`媒体库已刷新：共 ${all.length} 首${diff}。下一轮生效，当前轮次不受影响`);
  }
  persistSession();
}

/* ---------------- 播放控制 ---------------- */

function materializeBatch(paths) {
  return paths.map((p) => ({ path: p, name: provider.baseName(p), url: provider.streamUrl(p) }));
}

function startFirstRound() {
  startRound(1);
}

function startRound(round) {
  const pool = getState().pool;
  if (!pool.length) return;
  skipCount = 0; // 新一轮重置跳过计数（完成态统计准确性）
  roundStartTime = Date.now(); // 记录本轮起始时间（完成态统计"用时"）
  playback.reset(); // 切轮/切池前作废在途回调、清 audio，抑制残留 error/ended（S-C4）
  const sched = createScheduler(pool, { mode: playMode });
  setState({
    scheduler: sched,
    round,
    roundProgress: { played: 0, total: pool.length },
    batchFiles: [],
  });
  hidePlayError();
  el.playerPlaceholder.classList.add('hidden');
  el.player.classList.remove('hidden');
  enableControls(true);
  beginNextBatch();
}

function beginNextBatch() {
  const s = getState();
  if (!s.scheduler) return;
  const batchPaths = s.scheduler.nextBatch();
  if (!batchPaths) {
    handleRoundDone();
    return;
  }
  const batchFiles = materializeBatch(batchPaths);
  const bi = s.scheduler.serialize().batchIndex;
  setState({ batchFiles, batchIndex: bi });
  renderBatchList();
  playback.setBatch(batchFiles);
  playback.playAt(0);
  renderRoundInfo();
  persistSession();
  if (bi > 0) toast(`已进入第 ${bi + 1} 批 · 本批 ${batchFiles.length} 首`);
}

function handleBatchDone() {
  const s = getState();
  if (s.scheduler && s.scheduler.roundDone()) {
    handleRoundDone();
  } else {
    beginNextBatch();
  }
}

function fmtDur(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function roundStatsText() {
  const s = getState();
  const played = s.roundProgress.played || 0;
  const total = s.roundProgress.total || 0;
  const elapsed = roundStartTime ? Math.max(0, Math.round((Date.now() - roundStartTime) / 1000)) : 0;
  const mode = playMode === 'seq' ? '顺序' : '随机';
  return `播放 ${played} / ${total} 首 · 跳过 ${skipCount} 首 · 用时 ${fmtDur(elapsed)} · ${mode}模式`;
}

function handleRoundDone() {
  const s = getState();
  el.roundSummary.textContent = `本轮已播完（${roundStatsText()}）。可再来一轮或查看结果。`;
  el.roundModal.classList.remove('hidden');
  placeModal(el.roundModal, '.player');
}

/* 轮播完成态停驻（主方案）：停止/查看结果后播放界面不消失，
   海报半透明保留 + 统计横幅 + 三出口（再来一轮 / 重新扫描 / 收起播放器）。 */
function enterRoundDone() {
  el.roundModal.classList.add('hidden');
  playback.reset(); // 停驻前作废在途回调、清 audio（S-C4）
  el.audioEl.pause();
  el.audioEl.currentTime = 0;
  el.seekFill.style.width = '0%';
  el.seekThumb.style.left = '0%';
  el.curTime.textContent = '0:00';
  el.totalTime.textContent = '0:00';
  enableControls(false);
  el.roundDoneStats.textContent = roundStatsText();
  el.roundDoneOverlay.classList.remove('hidden');
}

function collapsePlayer() {
  el.roundDoneOverlay.classList.add('hidden');
  el.roundModal.classList.add('hidden');
  playback.reset();
  el.audioEl.pause();
  enableControls(false);
  el.player.classList.add('hidden');
  el.playerPlaceholder.classList.remove('hidden');
  const s = getState();
  el.playerPlaceholder.textContent = `本轮已播完（${s.roundProgress.played || 0} 首）。点「开始轮播」再来一轮`;
  setState({ scheduler: null, round: 0, batchFiles: [], roundProgress: { played: 0, total: 0 } });
  renderRoundInfo();
  persistSession();
}

function newRound() {
  el.roundModal.classList.add('hidden');
  el.roundDoneOverlay.classList.add('hidden');
  startRound(getState().round + 1);
}

function enableControls(on) {
  el.prevBtn.disabled = !on;
  el.playPauseBtn.disabled = !on;
  el.nextBtn.disabled = !on;
  el.skipBatchBtn.disabled = !on;
  el.playPauseBtn.classList.remove('on');
  el.playPauseBtn.querySelector('.ic-play').toggleAttribute('hidden', false);
  el.playPauseBtn.querySelector('.ic-pause').toggleAttribute('hidden', true);
}

/* ---------------- 播放交互：时间 / seek / 音量 / 换批 ---------------- */

function formatTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function updateTrackProgress() {
  const a = el.audioEl;
  const pct = a.duration && isFinite(a.duration) && a.duration > 0
    ? `${Math.min(100, (a.currentTime / a.duration) * 100)}%`
    : '0%';
  el.seekFill.style.width = pct;
  el.seekThumb.style.left = pct;
  if (pct === '0%') {
    el.curTime.textContent = '0:00';
    el.totalTime.textContent = '0:00';
    return;
  }
  el.curTime.textContent = formatTime(a.currentTime);
  el.totalTime.textContent = formatTime(a.duration);
}

function seekRatio(r) {
  const a = el.audioEl;
  if (!a.duration || !isFinite(a.duration)) return;
  a.currentTime = Math.max(0, Math.min(1, r)) * a.duration;
  updateTrackProgress();
}

function setVolume(v) {
  el.audioEl.volume = Math.max(0, Math.min(1, v));
  if (el.audioEl.volume > 0) el.audioEl.muted = false;
  renderVolume();
}

function toggleMute() {
  el.audioEl.muted = !el.audioEl.muted;
  renderVolume();
}

/** 渲染自绘竖向音量滑块（vol-fill 高度 / vol-thumb 位置），静音时归零 */
function renderVolume() {
  const pct = Math.round((el.audioEl.muted ? 0 : el.audioEl.volume) * 100);
  el.volFill.style.height = `${pct}%`;
  el.volThumb.style.top = `${100 - pct}%`;
  // 音量数字固定三位（000 → 100），配合 tabular-nums 居中不跳动
  if (el.volValue) el.volValue.textContent = String(pct).padStart(3, '0');
  updateMuteIcon();
}

function updateMuteIcon() {
  const muted = el.audioEl.muted || el.audioEl.volume === 0;
  el.muteBtn.classList.toggle('muted', muted);
  el.muteBtn.title = muted ? '取消静音' : '静音 / 恢复';
}

/* ---- 弹窗定位：让弹窗居中于「触发它的功能面板」，而不是屏幕正中 ---- */
let lastPointerAt = 0;
let lastPointerTarget = null;
let modalClosedAt = 0;   // 最近一次弹窗关闭的时刻（ms），供"点外部收起"的宽限期判定使用
document.addEventListener('pointerdown', (e) => {
  lastPointerAt = performance.now();
  lastPointerTarget = e.target;
}, true);

/* 视为「功能面板」的容器：左媒体库抽屉、右曲目抽屉、频谱设置面板、播放器本体 */
const MODAL_PANEL_SEL = '#libDrawer, .queue-panel, .viz-panel, .player';
function panelOf(node) {
  let n = node;
  while (n && n !== document.body) {
    if (n.matches && n.matches(MODAL_PANEL_SEL)) return n;
    n = n.parentElement;
  }
  return null;
}
/* 把弹窗卡片移到锚点面板的中心（视口坐标系，做边界钳制）；无锚点时退回屏幕居中。
   内容异步加载会改变卡片高度，所以用 ResizeObserver 在尺寸变化后重算一次。 */
const modalAnchorMap = new WeakMap();
const modalObserverMap = new WeakMap();
function placeModal(modalEl, explicitAnchor) {
  const card = modalEl && modalEl.querySelector('.modal-card');
  if (!card) return;
  resetModal(modalEl);
  let anchor = explicitAnchor ? (typeof explicitAnchor === 'string' ? document.querySelector(explicitAnchor) : explicitAnchor) : null;
  if (!anchor && lastPointerTarget && performance.now() - lastPointerAt < 2500) anchor = panelOf(lastPointerTarget);
  if (!anchor) return; // 退回 CSS 的 flex 居中
  const apply = () => {
    const r = anchor.getBoundingClientRect();
    const w = card.offsetWidth, h = card.offsetHeight;
    if (!r.width || !r.height || !w || !h) return;
    let x = r.left + r.width / 2 - w / 2;
    let y = r.top + r.height / 2 - h / 2;
    x = Math.max(12, Math.min(window.innerWidth - w - 12, x));
    y = Math.max(12, Math.min(window.innerHeight - h - 12, y));
    card.style.position = 'fixed';
    card.style.margin = '0';
    card.style.transform = 'none';
    card.style.left = Math.round(x) + 'px';
    card.style.top = Math.round(y) + 'px';
  };
  modalAnchorMap.set(modalEl, anchor);
  apply();
  const old = modalObserverMap.get(modalEl);
  if (old) old.disconnect();
  const ob = new ResizeObserver(apply);
  ob.observe(card);
  modalObserverMap.set(modalEl, ob);
}
/* 清掉 placeModal 写的行内定位，恢复默认的屏幕居中 */
function resetModal(modalEl) {
  const card = modalEl && modalEl.querySelector('.modal-card');
  if (!card) return;
  modalClosedAt = performance.now();   // 供"点外部收起"的宽限期判定使用
  const ob = modalObserverMap.get(modalEl);
  if (ob) { ob.disconnect(); modalObserverMap.delete(modalEl); }
  modalAnchorMap.delete(modalEl);
  card.style.position = '';
  card.style.margin = '';
  card.style.transform = '';
  card.style.left = '';
  card.style.top = '';
}

/* 通用确认弹窗（确认/取消可各带动作，用于二选一场景） */
let confirmCb = null;
function confirmDialog(title, msg, opts = {}) {
  el.confirmTitle.textContent = title;
  el.confirmMsg.innerHTML = msg;
  el.confirmOkBtn.textContent = opts.okText || '确认';
  el.confirmCancelBtn.textContent = opts.cancelText || '取消';
  el.confirmModal.classList.remove('hidden');
  placeModal(el.confirmModal, opts.anchor || null);
  confirmCb = { ok: opts.ok || null, cancel: opts.cancel || null };
}
function resolveConfirm(ok) {
  el.confirmModal.classList.add('hidden');
  resetModal(el.confirmModal);
  const cb = confirmCb;
  confirmCb = null;
  if (ok && cb && cb.ok) cb.ok();
  else if (!ok && cb && cb.cancel) cb.cancel();
}

/* 点击本批曲目：快速跳转播放（原曲被中断标记为"未完整播放"） */
function jumpTo(i) {
  const s = getState();
  if (!s.scheduler || !s.batchFiles.length) return;
  const cur = playback.currentIndex();
  if (i === cur || i < 0 || i >= s.batchFiles.length) return;
  // 与上一首/下一首同一套节奏：已展开则先收拢 1.5s，复位后再切
  switchWithCollapse(() => {
    if (cur >= 0 && cur < s.batchFiles.length) s.scheduler.markPartial(cur);
    playback.jumpTo(i);
    persistSession();
  });
}

/* 提前换批：放弃本批剩余，计入已播，进入下一批 */
function skipBatch() {
  const s = getState();
  if (!s.scheduler) return;
  const cur = playback.currentIndex();
  const batchLen = s.batchFiles.length;
  if (cur < 0 || cur >= batchLen) return;
  const remain = batchLen - cur;
  confirmDialog('提前换批', `将放弃本批剩余 ${remain} 首（计入已播），立即进入下一批。`, {
    okText: '确认换批',
    ok: () => {
      for (let i = cur; i < batchLen; i++) s.scheduler.markPlayed(i, { partial: true }); // 未完整播放
      const now = s.scheduler.serialize().playedCount;
      setState({ roundProgress: { ...s.roundProgress, played: now } });
      el.playError.classList.add('hidden');
      beginNextBatch();
    },
  });
}

/* ---------------- 会话恢复 ---------------- */

async function restoreSession() {
  const sess = await loadSession();
  if (!sess) return;
  // S-4：总是先恢复目录列表 —— pool 为空（上次只加了目录未扫描）也不丢 dirs；
  // 且与当前已有 dirs 合并去重，避免无条件覆盖当前配置
  if (Array.isArray(sess.dirs) && sess.dirs.length) {
    const cur = getState().dirs || [];
    const seen = new Set(cur.map((d) => String(d).toLowerCase()));
    const merged = cur.slice();
    for (const d of sess.dirs) {
      const k = String(d).toLowerCase();
      if (!seen.has(k)) {
        merged.push(d);
        seen.add(k);
      }
    }
    setState({ dirs: merged });
    renderDirs();
  }
  if (!Array.isArray(sess.pool) || !sess.pool.length) {
    // 无媒体库：仅保留目录，隐藏恢复按钮，不建调度
    el.resumeBtn.hidden = true;
    renderDirs();
    return;
  }
  setState({
    pool: sess.pool,
    round: sess.round || 0,
    roundProgress: sess.roundProgress || { played: 0, total: sess.pool.length },
  });
  renderPoolStats(sess.pool);

  if (sess.scheduler && Array.isArray(sess.scheduler.remaining) && sess.scheduler.remaining.length) {
    // 有未完成的一轮：恢复调度状态，显示常驻「恢复播放」按钮。
    // 提示不再压在"默认排序"下面（字号太小、与面板排版不搭），改由工具栏按钮的悬停说明承担。
    const sched = createScheduler([]);
    if (sched.restore(sess.scheduler)) {
      setState({ scheduler: sched });
      staleRemaining = sess.scheduler.remaining.length;
      el.restoreBanner.classList.add('hidden');
      el.resumeBtn.hidden = false;
    }
  } else {
    staleRemaining = 0;
    // 无未完成轮次：隐藏恢复按钮，重新规划（不自动开始）
    el.resumeBtn.hidden = true;
    renderPlan(sess.pool);
  }
}

async function resumePlayback(sess) {
  const s = getState();
  if (!s.scheduler) return;
  playback.reset(); // 恢复前作废在途回调（S-C4）
  let batchPaths = s.scheduler.currentBatch();
  // 断点恢复时若当前批为空（上一批已播完、尚未抽新批），抽取下一批继续
  if (!batchPaths || !batchPaths.length) batchPaths = s.scheduler.nextBatch() || [];
  // 恢复前校验路径存在性，预过滤失效文件（S-3/S-4），避免恢复即疯狂跳过
  let validPaths = batchPaths;
  let missingCount = 0;
  if (batchPaths && batchPaths.length) {
    const { missing } = await provider.checkPaths(batchPaths);
    if (missing && missing.length) {
      missingCount = missing.length;
      const missingSet = new Set(missing);
      validPaths = batchPaths.filter((p) => !missingSet.has(p));
    }
  }
  if (!validPaths.length) {
    showPlayError(`恢复播放失败：本批 ${batchPaths.length} 个文件均已失效（可能已移动或删除）。请刷新媒体库或停止。`);
    return;
  }
  const batchFiles = materializeBatch(validPaths);
  setState({ batchFiles, batchIndex: s.scheduler.serialize().batchIndex });
  hidePlayError();
  el.playerPlaceholder.classList.add('hidden');
  el.player.classList.remove('hidden');
  enableControls(true);
  renderBatchList();
  playback.setBatch(batchFiles);
  // 从已播到的下一位继续
  const resumeIdx = s.scheduler.serialize().batchIndex < 0 ? 0 : s.scheduler.serialize().batchIndex;
  playback.playAt(resumeIdx >= batchFiles.length ? 0 : resumeIdx);
  renderRoundInfo();
  persistSession();
  if (missingCount) toast(`恢复播放：已跳过 ${missingCount} 个失效文件，继续播放 ${batchFiles.length} 首`);
}

/* ---------------- 事件绑定 ---------------- */

// 任何状态变化后自动刷新按钮可用性与提示
subscribe(() => updateControls());

/* 当前曲目进度与时长 */
el.audioEl.addEventListener('timeupdate', updateTrackProgress);
el.audioEl.addEventListener('loadedmetadata', updateTrackProgress);
el.audioEl.addEventListener('durationchange', updateTrackProgress);
el.audioEl.addEventListener('timeupdate', () => updateLyrics(el.audioEl.currentTime));

/* 唱片动效联动：播放时唱片旋转、唱臂落到盘面；暂停/停止/结束则停转、唱臂抬起 */
const playerEl = $('player');
/* ---------- 唱片转速引擎 ----------
   原先用 CSS `animation: discSpin 14s linear infinite`，转速写死、只能 running/paused 开关，
   所以"起播"和"停止"没有任何速度过渡。改成 JS 逐帧写 rotate：
     · 目标转速 = 满速 6 圈/秒 × 四档递进（40% 触顶）× 节拍微调制
     · 四档分界：0–10% / 10–20% / 20–30% / 30–40% → 1.5 / 3 / 4.5 / 6 圈每秒，40% 之后保持满速
     · 曲末 8 秒不做档位，改按"剩余秒 / 8"线性刹车到 0（τ=0.45s 紧跟 ramp，8 秒内真正停下）
     · 实际转速用一阶惯性追目标：加速 τ=0.42s（起手约 1s 到速）、减速 τ=1.15s（滑停约 2.5s 停稳）
     · 节拍增益取 visualizer.getBeat()（前 12 bins ≈ 0~500Hz 低频，覆盖底鼓/贝斯），再慢平滑，避免转速抖
   停稳后主动收掉 rAF，不在后台空转。 */
const DISC_RPS_MAX = 2.0;                 // 满速：每秒 2 圈（一圈 0.5s，目测最协调）
const DISC_GEAR_FULL_AT = 0.40;           // 到达满速的进度点
const DISC_GEAR_COUNT = 4;                // 0→40% 之间分 4 档：0.5 / 1.0 / 1.5 / 2.0 圈每秒
const DISC_BEAT_GAIN = 0.06;              // 满速后节拍残差很小，只留一点呼吸
const DISC_BRAKE_SEC = 8;
const DISC_TAU_UP = 0.42;
const DISC_TAU_DOWN = 1.15;
const DISC_TAU_BRAKE = 0.45;              // 曲末刹车紧跟线性 ramp，8 秒内真正落到 0
const DISC_MIN_STOP = 0.002;
let discAngle = 0, discRps = 0, discBeat = 0, discRaf = 0, discPrevTs = 0;

/** 当前档位基础转速（圈/秒，不含节拍调制）；40% 到满速，曲末 8 秒按剩余比例线性衰减到 0 */
function discGearRps() {
  const a = el.audioEl;
  const dur = a && isFinite(a.duration) && a.duration > 0 ? a.duration : 0;
  if (!dur) return DISC_RPS_MAX / DISC_GEAR_COUNT;
  const progress = Math.min(1, Math.max(0, a.currentTime / dur));
  const band = Math.min(1, progress / DISC_GEAR_FULL_AT);                 // 0..1（到 40% 时满）
  const idx = Math.min(DISC_GEAR_COUNT - 1, Math.floor(band * DISC_GEAR_COUNT));
  let rps = DISC_RPS_MAX * (idx + 1) / DISC_GEAR_COUNT;
  const remain = dur - a.currentTime;
  if (remain <= DISC_BRAKE_SEC) rps *= Math.max(0, Math.min(1, remain / DISC_BRAKE_SEC));
  return rps;
}

/** 是否处于曲末刹车区（只在真正播放时算） */
function discBraking() {
  const a = el.audioEl;
  const p = el.player;
  if (!a || !p || !p.classList.contains('playing') || p.classList.contains('cue-still')) return false;
  const dur = isFinite(a.duration) ? a.duration : 0;
  return dur > 0 && (dur - a.currentTime) <= DISC_BRAKE_SEC;
}

function discTargetRps() {
  const p = el.player;
  if (!p || !p.classList.contains('playing')) return 0;
  if (p.classList.contains('cue-still')) return 0;          // 抬针后停转
  return discGearRps() * (1 + DISC_BEAT_GAIN * discBeat);
}
function discPlate() { return el.player && el.player.querySelector('.disc-plate'); }
function discTick(ts) {
  discRaf = 0;
  const dt = discPrevTs ? Math.min(0.05, (ts - discPrevTs) / 1000) : 0.016;
  discPrevTs = ts;
  let beat = 0;
  try { beat = visualizer.getBeat() || 0; } catch {}
  discBeat += (beat - discBeat) * Math.min(1, dt * 5);      // 慢平滑：能量高低都不过冲
  const target = discTargetRps();
  const tau = target > discRps ? DISC_TAU_UP : (discBraking() ? DISC_TAU_BRAKE : DISC_TAU_DOWN);
  discRps += (target - discRps) * Math.min(1, dt / tau);
  discAngle = (discAngle + discRps * 360 * dt) % 360;
  const plate = discPlate();
  if (plate) plate.style.transform = `rotate(${discAngle.toFixed(2)}deg)`;
  if (discRps < DISC_MIN_STOP && target === 0) { discRps = 0; discBeat = 0; discPrevTs = 0; return; }
  discRaf = requestAnimationFrame(discTick);
}
function discWake() {
  if (discRaf) return;
  discPrevTs = 0;
  discRaf = requestAnimationFrame(discTick);
}
function setDiscPlaying(on) {
  if (playerEl) playerEl.classList.toggle('playing', on);
  discWake();                                              // 起播渐加速 / 暂停惯性滑停都由 target 驱动
  if (on) startNoteFx(); else stopNoteFx();                // 盘心音符：播放时彩色+辉光呼吸，停下即复位
}
el.audioEl.addEventListener('play', () => { setDiscPlaying(true); armCueDown(); });
/* 以音频引擎的实际状态为准：任何来源（滚轮/滑块/静音键/系统/媒体键）改了 volume 或 muted，UI 都跟随 */
el.audioEl.addEventListener('volumechange', renderVolume);
el.audioEl.addEventListener('playing', () => setDiscPlaying(true));
el.audioEl.addEventListener('pause', () => setDiscPlaying(false));
el.audioEl.addEventListener('ended', () => setDiscPlaying(false));
el.audioEl.addEventListener('emptied', () => setDiscPlaying(false));

/* 进度条 seek：点击 + 拖动 */
let seeking = false;
function seekFromEvent(e) {
  const rect = el.seekBar.getBoundingClientRect();
  if (rect.width <= 0) return;
  seekRatio((e.clientX - rect.left) / rect.width);
}
el.seekBar.addEventListener('pointerdown', (e) => {
  seeking = true;
  try { el.seekBar.setPointerCapture(e.pointerId); } catch {}
  seekFromEvent(e);
});
el.seekBar.addEventListener('pointermove', (e) => {
  if (seeking) seekFromEvent(e);
});
el.seekBar.addEventListener('pointerup', (e) => {
  seeking = false;
  seekFromEvent(e);
});
el.seekBar.addEventListener('pointercancel', () => {
  seeking = false;
});

/* 音量：自绘竖向滑块（vol-hit 命中区，pointer events + 拖拽捕获） */
let volDrag = false;
function volumeFromEvent(e) {
  const r = el.volTrack.getBoundingClientRect();
  if (r.height <= 0) return;
  setVolume((r.bottom - e.clientY) / r.height);
}
el.volHit.addEventListener('pointerdown', (e) => {
  e.preventDefault(); // 阻止原生文本选择/拖拽/触摸滚动抢占手势
  volDrag = true;
  try { el.volHit.setPointerCapture(e.pointerId); } catch {} // 捕获失败也不影响：move/up 已挂 document 兜底
  volumeFromEvent(e);
});
// move/up/cancel 挂 document（而非 28px 命中条），捕获失效或指针移出命中条时仍能跟手，消除拖拽卡住
document.addEventListener('pointermove', (e) => {
  if (!volDrag) return;
  e.preventDefault();
  volumeFromEvent(e);
});
document.addEventListener('pointerup', (e) => {
  if (!volDrag) return;
  volDrag = false;
  volumeFromEvent(e);
});
document.addEventListener('pointercancel', () => {
  volDrag = false;
});
el.muteBtn.addEventListener('click', toggleMute);

/* 音量区滚轮调音：按住 Ctrl + 滚轮，向上滚增大 / 向下滚减小，每格 2%。
   为什么要加 Ctrl 这个前缀：
   - 普通滚轮完全交还给页面与列表，滚列表就是滚列表，不再被"全页调音量"抢走；
   - Ctrl + 滚轮是浏览器缩放的原生手势，等于借用一个人人都懂的"临时模式"语义，
     不会和 Shift（等比缩放拖拽）这类快捷键抢；
   - 松手即回到普通滚轮，没有残留模式。
   驱动方式仍对齐主流播放器（Deezer / VLC / KDE）：看方向不看位移大小，一个滚轮事件一步，
   每帧最多消费一步，多出来的排队进下一帧，既不丢事件、也不会一次跳多格。 */
const VOL_WHEEL_STEP = 0.02;
const volTip = (() => {
  const s = document.createElement('span');
  s.className = 'vol-tip';
  el.volumeBox.appendChild(s);
  return s;
})();
let volPending = 0;        // 排队待消费的步数（方向由 volPendingDir 决定）
let volPendingDir = 0;
let volRafId = 0;
let volTipTimer = null;
/* ---- 滚轮输入诊断（真实鼠标取证用，不影响播放逻辑） ----
   高精度/自由滚轮单事件 deltaY 与事件频率只能实测，不能靠猜：
   开启：document.body.dataset.wheelLog = '1'
   记录：音量区最近 200 个 wheel 原始参数（deltaY / deltaMode / 时间戳）
   输出：隐藏节点 #wheelLogDump 的 textContent（走 DOM，任何上下文都能读到） */
let volLog = [];
let volLogTimer = 0;
function dumpWheelLog() {
  volLogTimer = 0;
  let box = document.getElementById('wheelLogDump');
  if (!box) {
    box = document.createElement('div');
    box.id = 'wheelLogDump';
    box.style.display = 'none';
    document.body.appendChild(box);
  }
  box.textContent = JSON.stringify(volLog);
}
function wheelLogPush(dy, mode) {
  volLog.push({ dy, mode, t: Math.round(performance.now()) });
  if (volLog.length > 200) volLog.shift();
  if (!volLogTimer) volLogTimer = setTimeout(dumpWheelLog, 150);
}
function showVolumeTip(suffix = '') {
  const pct = Math.round((el.audioEl.muted ? 0 : el.audioEl.volume) * 100);
  volTip.textContent = pct + '%' + suffix;
  volTip.classList.add('on');
  clearTimeout(volTipTimer);
  volTipTimer = setTimeout(() => volTip.classList.remove('on'), 1300);
}
/* 一帧消费一步：棘轮模式每次滚轮立刻可见；高频自由滚轮按帧率连续推进，观感是滑块在快速滑动 */
function flushVolumeStep() {
  volRafId = 0;
  if (!volPending) return;
  const dir = volPendingDir;
  volPending -= 1;
  const base = el.audioEl.muted ? 0 : el.audioEl.volume;
  const target = base + dir * VOL_WHEEL_STEP;          // deltaY<0（向上滚）→ 音量增大
  const hitTop = target > 1.0001;
  const hitBottom = target < -0.0001;
  setVolume(target);
  showVolumeTip(hitTop ? '（已最大）' : hitBottom ? '（已最小）' : '');
  if ((hitTop || hitBottom) && volPendingDir === dir) volPending = 0;  // 撞到边界：清空剩余队列，停手即停
  if (volPending) volRafId = requestAnimationFrame(flushVolumeStep);   // 余下步数下一帧继续
}
/* 按住 Ctrl + 滚轮调音量：任意位置生效（指针不必先进入音量区）。
   冲突处理：① 没有 Ctrl → 直接不动，滚轮交给页面和可滚列表；② 叠了 Meta / Shift / Alt → 让行，
   不与系统的横向滚动、等比缩放快捷键抢；③ 只在 Ctrl 单独按下时接管，并 preventDefault 拦住浏览器缩放。 */
window.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;                                         // 普通滚轮：不接管，页面/列表照常滚
  if (e.metaKey || e.shiftKey || e.altKey) return;                // 叠了别的修饰键：让行
  if (e.deltaMode === 2) return;                                  // 整页滚动单位：一次就可能跨到底，忽略
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;            // 横向滚轮 / 触控板水平手势：不接管
  if (seeking || volDrag) return;                                 // 正在拖进度条或音量滑块：滚轮不叠加
  e.preventDefault();                                             // 拦住浏览器 Ctrl+滚轮 的页面缩放
  const dy = e.deltaY;
  if (document.body.dataset.wheelLog === '1') wheelLogPush(dy, e.deltaMode);   // 诊断记录，不改判定
  if (!Number.isFinite(dy) || dy === 0) return;        // 异常/空值不进队列，避免 NaN 污染
  const dir = dy < 0 ? 1 : -1;
  if (volPendingDir && volPendingDir !== dir) volPending = 0;   // 方向反转：丢弃排队，立即响应
  volPendingDir = dir;
  volPending += 1;                                     // 每个事件记一步，不丢
  if (volPending > 30) volPending = 30;                // 上限只防极端爆发后长时间"停手还在涨"，不影响正常滚速
  if (!volRafId) volRafId = requestAnimationFrame(flushVolumeStep);
}, { passive: false });

/* 提前换批（瞬时 on 高亮后复原） */
el.skipBatchBtn.addEventListener('click', () => {
  flashOn(el.skipBatchBtn);
  skipBatch();
});

/* 确认弹窗 */
el.confirmOkBtn.addEventListener('click', () => resolveConfirm(true));
el.confirmCancelBtn.addEventListener('click', () => resolveConfirm(false));

/* 键盘快捷键：空格=播/停，←→=上一/下一首，↑↓=音量 */
window.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (!el.playPauseBtn.disabled) playback.toggle();
  } else if (e.key === 'ArrowLeft') {
    if (!el.prevBtn.disabled) switchWithCollapse(() => playback.prev());
  } else if (e.key === 'ArrowRight') {
    if (!el.nextBtn.disabled) switchWithCollapse(() => playback.next());
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    setVolume(el.audioEl.volume + 0.1);
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    setVolume(el.audioEl.volume - 0.1);
  } else if (e.key === 'Escape') {
    closeVizPanel();
    $('vizMenu').classList.add('hidden');
  }
});

/* 系统媒体键 / 媒体浮层 */
setupMediaSession();

/* 初始化音量 */
setVolume(0.1); // 初始音量 10%，避免惊扰

/* 切后台停止可视化绘制（省 CPU），回前台且正在播放则恢复 */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    visualizer.setVisible(false);
  } else if (getState().scheduler && !el.audioEl.paused) {
    visualizer.start(el.audioEl);
  }
});

el.dirInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addDir();
});
el.dirList.addEventListener('click', (e) => {
  const btn = e.target.closest('.rm');
  if (btn) { removeDir(Number(btn.dataset.i)); return; }
  const li = e.target.closest('.path-item');
  if (!li) return;
  /* 点击态：单选高亮（与歌单列表同一套三态视觉） */
  el.dirList.querySelectorAll('.path-item.active').forEach((n) => { if (n !== li) n.classList.remove('active'); });
  li.classList.add('active');
});
/* 刷新媒体库：未播放直接全量刷新；播放中让用户二选一（立即切换 / 仅后台更新） */
function onRefreshClick() {
  if (getState().scheduler) {
    confirmDialog('刷新媒体库', '媒体库刷新后如何生效？<br><br>'
      + '<b>「立即切换」</b>：放弃当前轮进度，立即用新媒体池重新开始一轮播放。'
      + '适合刚移除了目录、想马上播新库的场景。<br>'
      + '<b>「仅后台更新」</b>：当前轮不受影响，下一轮才使用新媒体池。', {
      okText: '立即切换',
      cancelText: '仅后台更新',
      ok: () => startScan(getState().dirs, 'full', 'switch'),
      cancel: () => startScan(getState().dirs, 'full', 'update'),
    });
  } else {
    startScan(getState().dirs, 'full', 'update');
  }
}

el.scanBtn.addEventListener('click', onRefreshClick);
el.refreshTopBtn.addEventListener('click', onRefreshClick);

/* 左右抽屉：边缘热区 hover 自动弹出 + 移出延迟收回 + 内部固定/收起开关
   同时联动频谱绘制区（条柱避让抽屉，不重叠） */
const pinned = { lib: false, queue: false };
const closeTimer = { lib: null, queue: null };
/* 边缘热区节奏：检测预留 150ms + 弹出动画 800ms = 950ms 完成整个弹出
   弹出后锁定 5s（期间不做任何检测），5s 到点若鼠标不在菜单范围内则收起
   收起（800ms）完成后再等 2s 才恢复检测，避免收起途中又被触发 */
const EDGE_DWELL_MS = 150;
const SLIDE_MS = 800;
const HOLD_MS = 5000;
const RESUME_AFTER_MS = 2000;
const hoverTimer = { lib: null, queue: null };
const holdUntil = { lib: 0, queue: 0 };
const resumeAt = { lib: 0, queue: 0 };
const insideDrawer = { lib: false, queue: false };
const watchTimer = { lib: null, queue: null };   // 抽屉开启期间的低频巡检（不依赖 mouseenter/mouseleave）
/* 指针位置：抽屉是「滑到指针下方」而不是「指针移进抽屉」，所以 mouseenter 不一定补发，
   判断是否还在菜单范围一律以实时指针坐标 + 面板矩形为准 */
const pointer = { x: null, y: null };
const DRAWER_PAD = 12;                            // 面板边缘容差：贴着边框仍算在菜单内
document.addEventListener('mouseover', (e) => { pointer.x = e.clientX; pointer.y = e.clientY; }, true);
document.addEventListener('pointermove', (e) => { pointer.x = e.clientX; pointer.y = e.clientY; }, { capture: true, passive: true });
function drawerEl(k) { return $(k === 'lib' ? 'libDrawer' : 'queueDrawer'); }
function isPointerInDrawer(k) {
  const d = drawerEl(k);
  if (!d.classList.contains('open')) return false;
  if (pointer.x === null || pointer.y === null) return insideDrawer[k];
  const r = d.getBoundingClientRect();
  return pointer.x >= r.left - DRAWER_PAD && pointer.x <= r.right + DRAWER_PAD
      && pointer.y >= r.top - DRAWER_PAD && pointer.y <= r.bottom + DRAWER_PAD;
}

function refreshVizMargins() {
  /* 抽屉宽度按 web viewr 标注：左 530 / 右 410 */
  const l = $('libDrawer').classList.contains('open') ? 530 : 0;
  const r = $('queueDrawer').classList.contains('open') ? 410 : 0;
  visualizer.setMargins(l, r);
}
function syncPinBtn(k) {
  const btn = $(k === 'lib' ? 'libPin' : 'queuePin');
  if (btn) btn.classList.toggle('pinned', pinned[k]);
}
function cancelClose(k) {
  if (closeTimer[k]) { clearTimeout(closeTimer[k]); closeTimer[k] = null; }
}
function scheduleClose(k) {
  if (pinned[k]) return;
  cancelClose(k);
  closeTimer[k] = setTimeout(() => {
    closeTimer[k] = null;
    /* 到点再复核一次几何：指针已回到面板内（含边缘容差）就不收，避免边缘抖动误收 */
    if (isPointerInDrawer(k)) return;
    closeDrawer(k);
  }, 600);
}
function openDrawer(k) {
  clearHoverTimer(k);                            // 正在弹出：抹掉尚未触发的检测计时
  drawerEl(k).classList.add('open');
  cancelClose(k);
  holdUntil[k] = performance.now() + HOLD_MS;   // 弹出即锁定 5s，期间不再做检测
  startWatch(k);
  refreshVizMargins();
}
/* 抽屉开启后按 250ms 巡检：5s 锁定期满，只要指针仍在面板矩形（外扩 12px）内就保留，
   指针离开后自动收起。不再依赖 mouseenter / mouseleave 是否被派发 */
function stopWatch(k) {
  if (watchTimer[k]) { clearInterval(watchTimer[k]); watchTimer[k] = null; }
}
function startWatch(k) {
  stopWatch(k);
  watchTimer[k] = setInterval(() => {
    const d = drawerEl(k);
    if (!d.classList.contains('open')) { stopWatch(k); return; }
    if (pinned[k]) return;                       // 按钮打开的抽屉钉住，不受悬停收回影响
    if (performance.now() < holdUntil[k]) return; // 5s 锁定期内不判定
    if (isPointerInDrawer(k)) return;             // 指针仍在菜单范围 -> 保留
    stopWatch(k);
    closeDrawer(k);
  }, 250);
}
function closeDrawer(k) {
  drawerEl(k).classList.remove('open');
  pinned[k] = false;
  syncPinBtn(k);
  stopWatch(k);
  insideDrawer[k] = false;
  cancelClose(k);
  /* 收起动画 800ms 走完，再等 2s 才恢复边缘检测 */
  resumeAt[k] = performance.now() + SLIDE_MS + RESUME_AFTER_MS;
  refreshVizMargins();
}
/* 右上角按钮显式 toggle 抽屉：点开即固定（不受 hover 自动收回影响），再点关闭 */
function toggleDrawer(k) {
  const el = $(k === 'lib' ? 'libDrawer' : 'queueDrawer');
  if (el.classList.contains('open')) {
    closeDrawer(k);
  } else {
    openDrawer(k);
    pinned[k] = true; /* 按钮打开的抽屉视为钉住，需再点按钮才收起 */
    syncPinBtn(k);
  }
}
/* 全屏模式：隐藏浏览器界面，仅显示应用界面本身 + 背景频谱动效（全屏整个文档，非只播放器面板） */
function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else if (document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(() => {});
  }
}
/* 边缘热区：鼠标经过即判定一次（不管之后是否停留），5s 内只判定一次 */
function armOpen(k) {
  const now = performance.now();
  if (hoverTimer[k]) return;                    // 已有判定在计时
  if (now < resumeAt[k]) return;                // 收起后 2s 静默期内不做检测
  if (now < holdUntil[k]) return;               // 5s 锁定期内不重复判定
  hoverTimer[k] = setTimeout(() => {
    hoverTimer[k] = null;
    if (performance.now() < resumeAt[k]) return;
    openDrawer(k);                               // 检测预留 150ms 到点 -> 弹出（800ms 动画）
  }, EDGE_DWELL_MS);
}
function clearHoverTimer(k) {
  clearTimeout(hoverTimer[k]);
  hoverTimer[k] = null;
}
document.querySelector('.edge-left').addEventListener('mouseenter', () => armOpen('lib'));
document.querySelector('.edge-right').addEventListener('mouseenter', () => armOpen('queue'));
/* 抽屉内悬停：立即取消待收起；离开时立刻复核一次（巡检另有 250ms 兜底，事件丢了也不会误收/不收） */
function checkHoldNow(k) {
  if (pinned[k]) return;
  const d = drawerEl(k);
  if (!d.classList.contains('open')) return;
  if (performance.now() < holdUntil[k]) return;
  if (isPointerInDrawer(k)) { cancelClose(k); return; }
  scheduleClose(k);
}
$('libDrawer').addEventListener('mouseenter', () => { insideDrawer.lib = true; cancelClose('lib'); });
$('libDrawer').addEventListener('mouseleave', () => {
  insideDrawer.lib = false;
  checkHoldNow('lib');
});
$('queueDrawer').addEventListener('mouseenter', () => { insideDrawer.queue = true; cancelClose('queue'); });
$('queueDrawer').addEventListener('mouseleave', () => {
  insideDrawer.queue = false;
  checkHoldNow('queue');
});
/* 收起 / 固定 */
$('libClose').addEventListener('click', () => closeDrawer('lib'));
$('queueClose').addEventListener('click', () => closeDrawer('queue'));
$('libPin').addEventListener('click', () => {
  pinned.lib = !pinned.lib; syncPinBtn('lib');
  if (pinned.lib) cancelClose('lib'); else scheduleClose('lib');
});
$('queuePin').addEventListener('click', () => {
  pinned.queue = !pinned.queue; syncPinBtn('queue');
  if (pinned.queue) cancelClose('queue'); else scheduleClose('queue');
});

/* 点抽屉外面就收回 —— 不理会 5s 锁定，也不理会固定态（点外面就是想关）。
   排除以下"不算外面"的情形:
   ① 点在抽屉内部（选目录、点曲目）；
   ② 点在它自己的开关按钮（交给 toggleDrawer，否则先收后开变成"点了没反应"）；
   ③ 点在左右边缘热区（那是悬停唤出的入口，不是"离开"）；
   ④ 点在模态弹窗内（弹窗是抽屉派生的操作层，在里面选/取消后必须回到抽屉原状）；
   ⑤ 有弹窗开着的时候（模态优先，任何按下都属于跟弹窗交互）；
   ⑥ 弹窗刚关闭的 260ms 内（防止"点按钮关掉弹窗"被连带的按下判定当成点外部）；
   ⑦ 二级右键菜单（正常已挂进抽屉，兜底防止脱离抽屉时被误判）。 */
// modalClosedAt 已在上方「弹窗定位」段声明（勿在此重复声明）
const OUTSIDE_GRACE_MS = 260;
document.addEventListener('pointerdown', (e) => {
  const t = e.target;
  if (!t || !t.closest) return;
  if (t.closest('.modal')) return;                                   // ④
  if (document.querySelector('.modal:not(.hidden)')) return;         // ⑤
  if (performance.now() - modalClosedAt < OUTSIDE_GRACE_MS) return;  // ⑥
  for (const k of ['lib', 'queue']) {
    const d = drawerEl(k);
    if (!d || !d.classList.contains('open')) continue;
    if (d.contains(t)) continue;
    if (t.closest('#menuLayer')) continue;                           // ⑦
    const btnId = k === 'lib' ? '#folderAddBtn' : '#playlistBtn';
    if (t.closest(btnId)) continue;
    if (t.closest('.edge-left') || t.closest('.edge-right')) continue;
    closeDrawer(k);
  }
}, true);
refreshVizMargins();

/* 右上角新功能按钮（Music Player.svg 布局）：添加目录→左抽屉、播放列表→右抽屉、全屏 toggle */
$('folderAddBtn').addEventListener('click', () => toggleDrawer('lib'));
$('playlistBtn').addEventListener('click', () => toggleDrawer('queue'));
$('fullscreenBtn').addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', () => {
  $('fullscreenBtn').classList.toggle('active', !!document.fullscreenElement);
});

/* 点击本批曲目：快速跳转播放 */
el.batchList.addEventListener('click', (e) => {
  const item = e.target.closest('.batch-item');
  if (item) jumpTo(Number(item.dataset.i));
});

/* 右键菜单（曲目行 / 目录路径行共用）：显示、定位、按目标类型分派 */
const menuLayer = $('menuLayer');
const trackMenu = $('trackMenu');
const trackMenuRevealBtn = $('trackMenuReveal');
let menuKind = 'track';        // 'track' 本批曲目 | 'dir' 媒体库目录
let menuTargetIndex = -1;      // 曲目索引
let menuTargetPath = '';       // 目录路径
let menuDrawerKey = 'lib';     // 当前把二级菜单挂到哪个抽屉

/* 二级菜单挂进所属抽屉内部并居中显示：既不会越出主面板边界，
   也不会被"点抽屉外即收回"的判定误当成外部点击而反复开关抽屉。 */
function showTrackMenu(drawerKey) {
  menuDrawerKey = drawerKey;
  const d = drawerEl(drawerKey);
  if (!d) return;
  if (menuLayer.parentElement !== d) d.appendChild(menuLayer);
  menuLayer.classList.remove('hidden');
  // 右侧抽屉层级低于播放器浮层，菜单打开期间临时抬高，避免被压在下面
  d.classList.add('menu-open');
}
function hideTrackMenu() {
  menuLayer.classList.add('hidden');
  if (menuLayer.parentElement) menuLayer.parentElement.classList.remove('menu-open');
}

/* 曲目行：在文件夹中显示 */
el.batchList.addEventListener('contextmenu', (e) => {
  const item = e.target.closest('.batch-item');
  if (!item) return;
  e.preventDefault();
  menuKind = 'track';
  menuTargetIndex = Number(item.dataset.i);
  menuTargetPath = '';
  trackMenuRevealBtn.textContent = '在文件夹中显示';
  showTrackMenu('queue');
});

/* 目录路径行：打开该目录 */
el.dirList.addEventListener('contextmenu', (e) => {
  const li = e.target.closest('.path-item');
  if (!li) return;
  e.preventDefault();
  menuKind = 'dir';
  menuTargetIndex = -1;
  menuTargetPath = li.dataset.path || '';
  if (!menuTargetPath) return;
  trackMenuRevealBtn.textContent = '打开这个目录';
  showTrackMenu('lib');
});

trackMenuRevealBtn.addEventListener('click', async () => {
  hideTrackMenu();
  try {
    if (menuKind === 'dir') {
      if (!menuTargetPath) return;
      const r = await provider.openPath(menuTargetPath);
      if (r && r.ok === false) showPlayError('打开目录失败：' + (r.error || '未知原因'));
    } else {
      const f = getState().batchFiles[menuTargetIndex];
      if (!f) return;
      await provider.revealInFolder(f.path);
    }
  } catch (err) {
    showPlayError(err.message);
  }
});

/* 复制路径：目录行复制目录路径，曲目行复制文件完整路径 */
$('trackMenuCopy').addEventListener('click', async () => {
  hideTrackMenu();
  const text = menuKind === 'dir'
    ? menuTargetPath
    : (getState().batchFiles[menuTargetIndex] || {}).path || '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制路径');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    toast(ok ? '已复制路径' : '复制失败，请手动选中复制');
  }
});

/* 点抽屉内其它位置（遮罩层上）关闭二级菜单；点菜单按钮走各自的业务回调 */
document.addEventListener('click', (e) => {
  if (menuLayer.classList.contains('hidden')) return;
  if (trackMenu.contains(e.target)) return;
  hideTrackMenu();
});

el.playPauseBtn.addEventListener('click', () => {
  playback.toggle();
  updatePlayBtnText();
});
el.nextBtn.addEventListener('click', () => { flashOn(el.nextBtn); switchWithCollapse(() => playback.next()); });
el.prevBtn.addEventListener('click', () => { flashOn(el.prevBtn); switchWithCollapse(() => playback.prev()); });
el.newRoundBtn.addEventListener('click', newRound);
el.stopBtn.addEventListener('click', enterRoundDone);
el.rdAgainBtn.addEventListener('click', newRound);
el.rdCollapseBtn.addEventListener('click', collapsePlayer);
el.rdRescanBtn.addEventListener('click', () => {
  collapsePlayer(); // 收起完成态回媒体库
  onRefreshClick(); // 触发媒体库刷新确认（立即切换 / 仅后台更新）
});
// 抽屉"开始轮播"（静态，扫描钮右侧，复用扫描钮底板）→ 启动一轮轮播
const startPlayBtnEl = $('startPlayBtn');
if (startPlayBtnEl) startPlayBtnEl.addEventListener('click', startFirstRound);
if (el.resumeBtn) el.resumeBtn.addEventListener('click', () => {
  el.restoreBanner.classList.add('hidden');
  el.resumeBtn.hidden = true;
  resumePlayback();
});

/* ---------------- 目录列表下方的折叠工具栏（整理与清理） ----------------
   用 document 级事件委托：抽屉内部会由后续渲染重建，
   直接给按钮挂监听会随元素替换一起消失（实测点击无反应）。
   按钮说明不常驻占位，统一走 #hoverTip 悬停气泡。 */

/** 上一轮未播完的剩余首数（由 restoreSession 写入，供悬停说明用） */
let staleRemaining = 0;

/** 清空扫描记录：丢掉这份扫描结果与上一轮进度，目录列表保留，不动磁盘 */
function clearScanRecordsFlow() {
  const s = getState();
  const poolLen = (s.pool || []).length;
  if (!poolLen && !s.scheduler) { toast('当前没有扫描记录'); return; }
  const parts = [];
  if (poolLen) parts.push(`这份扫描结果（${poolLen} 首）`);
  if (staleRemaining) parts.push(`上一轮还剩 ${staleRemaining} 首的播放进度`);
  confirmDialog(
    '清空扫描记录',
    `清掉${parts.join('和')}？<br>目录列表会保留，磁盘上的音频文件一个都不会动，之后重新点「开始扫描」即可恢复。`,
    {
      okText: '清空',
      cancelText: '取消',
      ok: () => {
        setState({
          pool: [],
          scheduler: null,
          batchFiles: [],
          batchIndex: -1,
          round: 0,
          roundProgress: { played: 0, total: 0 },
        });
        staleRemaining = 0;
        playback.reset();
        el.restoreBanner.classList.add('hidden');
        el.resumeBtn.hidden = true;
        el.playerPlaceholder.classList.remove('hidden');
        el.player.classList.add('hidden');
        enableControls(false);
        renderPoolStats([]);
        renderRoundInfo();
        renderPlan([]);
        persistSession();
        toast('已清空扫描记录（目录列表保留，磁盘文件未受影响）');
      },
    },
  );
}

function clearDirListFlow() {
  const dirs = getState().dirs || [];
  if (!dirs.length) { toast('目录列表已经是空的'); return; }
  confirmDialog(
    '清空目录列表',
    `清空列表里的 ${dirs.length} 个目录？<br>只清空这份列表，磁盘上的音频文件一个都不会动。`,
    {
      okText: '清空',
      cancelText: '取消',
      ok: () => {
        setState({ dirs: [], pool: [] });
        persistSession();
        renderDirs();
        renderPoolStats([]);
        toast('目录列表已清空（磁盘文件未受影响）');
      },
    },
  );
}

document.addEventListener('click', (e) => {
  const head = e.target.closest && e.target.closest('#dirToolsHead');
  if (head) {
    const d = $('libDrawer');
    const open = !d.classList.contains('tools-open');
    d.classList.toggle('tools-open', open);
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    return;
  }
  if (e.target.closest && e.target.closest('#toolClearScans')) { clearScanRecordsFlow(); return; }
  if (e.target.closest && e.target.closest('#toolClearDirs')) { clearDirListFlow(); }
});

/* ---------------- 悬停说明气泡 ----------------
   工具栏按钮（含折叠标题）鼠标停留 220ms 后浮出一句说明，移开即收。
   文案按当前状态现算：有扫描结果/残留就给具体数量，没有就说没有。 */
const hoverTip = $('hoverTip');
let tipShowTimer = null;

function tipTextFor(target) {
  if (!target) return '';
  if (target.id === 'dirToolsHead') {
    return '收纳整理与清理动作：清空扫描记录、清空目录列表。展开后抽屉会整体向下延长。';
  }
  if (target.id === 'toolClearScans') {
    const s = getState();
    const poolLen = (s.pool || []).length;
    if (staleRemaining) {
      return `上一轮还剩 ${staleRemaining} 首未播。清空会丢掉这份扫描结果和播放进度，目录列表保留，磁盘文件不受影响。`;
    }
    if (poolLen) {
      return `当前扫描结果共 ${poolLen} 首。清空后目录列表仍保留，重新点「开始扫描」即可再扫回来，磁盘文件不受影响。`;
    }
    return '当前没有扫描记录。';
  }
  if (target.id === 'toolClearDirs') {
    const n = (getState().dirs || []).length;
    return n
      ? `清空左侧媒体库里的 ${n} 个目录（只清列表，不删磁盘文件）。`
      : '目录列表已经是空的。';
  }
  return '';
}

function placeTip(target, text) {
  if (!hoverTip || !text) return;
  hoverTip.textContent = text;
  hoverTip.classList.remove('hidden');
  const r = target.getBoundingClientRect();
  const tw = hoverTip.offsetWidth;
  const th = hoverTip.offsetHeight;
  let left = r.left + r.width / 2 - tw / 2;
  let top = r.top - th - 8;
  if (top < 8) top = r.bottom + 8;
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
  hoverTip.style.left = Math.round(left) + 'px';
  hoverTip.style.top = Math.round(top) + 'px';
}

function hideTip() {
  if (tipShowTimer) { clearTimeout(tipShowTimer); tipShowTimer = null; }
  if (hoverTip) hoverTip.classList.add('hidden');
}

document.addEventListener('pointerover', (e) => {
  const t = e.target.closest && e.target.closest('#dirToolsHead, .tools-btn');
  if (!t) return;
  hideTip();
  tipShowTimer = setTimeout(() => placeTip(t, tipTextFor(t)), 220);
});
document.addEventListener('pointerout', (e) => {
  const t = e.target.closest && e.target.closest('#dirToolsHead, .tools-btn');
  if (!t) return;
  hideTip();
});
// 面板收起 / 抽屉关闭时气泡别留着
['pointerdown', 'wheel'].forEach((ev) => document.addEventListener(ev, hideTip, { capture: true, passive: true }));

/* ---------------- 启动 ---------------- */

renderDirs();
renderScanStatus(getState().scan);
renderRoundInfo();
restoreSession();

/* ---------------- 频谱设置面板（右下角齿轮 + 独立浮窗 + 右键菜单） ---------------- */

function vizSave() { try { localStorage.setItem('vizParams', JSON.stringify(visualizer.getParams())); } catch {} }

/** 面板数值格式化：比例类显示 %，像素类显示 px */
function fmtVizVal(k, v) {
  if (k === 'ringDiameter' || k === 'ringLength') return `${Math.round(v * 100)}%`;
  if (k === 'ringWidth' || k === 'barGap') return `${v}px`;
  return `${v}`;
}

function syncVizUI() {
  const p = visualizer.getParams();
  const isRing = p.displayMode === 'ring';
  document.querySelectorAll('.viz-rows [data-param]').forEach((ctl) => {
    const k = ctl.dataset.param;
    if (!(k in p)) return;
    if (ctl.type === 'checkbox') ctl.checked = !!p[k];
    else ctl.value = p[k];
    const val = document.querySelector(`.viz-val[data-for="${k}"]`);
    if (val) val.textContent = fmtVizVal(k, p[k]);
  });
  // 模式专属控件显隐
  document.querySelectorAll('.viz-ring-only').forEach((n) => n.classList.toggle('hidden', !isRing));
  document.querySelectorAll('.viz-bars-only').forEach((n) => n.classList.toggle('hidden', isRing));
  // 条数标签：条柱=条数，环形=线条数量
  const countLabel = document.querySelector('#vizCountLabel');
  if (countLabel) countLabel.textContent = isRing ? '线条数量' : '条数';
  // 环形提示：双圈镜像 / 单圈环绕
  const ringHint = document.querySelector('#vizRingHint');
  if (ringHint) {
    ringHint.textContent = p.ringMirror === false
      ? '单圈环绕 · 首尾颜色无缝，长度按相邻频段自然衔接'
      : '双圈镜像 · 首尾长度/颜色自动无缝';
  }
  // 渐变四角色块 + 选中态
  const corners = p.gradientCorners || {};
  document.querySelectorAll('.viz-corner').forEach((btn) => {
    const k = btn.dataset.corner;
    btn.style.background = (corners[k] && corners[k]) || '#000';
    btn.classList.toggle('sel', k === appCorner);
  });
  // 模式显隐：渐变区仅 gradient；色环仅 gradient/single
  const gradRow = document.querySelector('#vizGradRow');
  if (gradRow) gradRow.classList.toggle('hidden', p.colorMode !== 'gradient');
  const hsbRow = document.querySelector('#vizHsbRow');
  if (hsbRow) hsbRow.classList.toggle('hidden', p.colorMode === 'hueCycle' || p.colorMode === 'spectrum');
  // 显示模式按钮高亮
  document.querySelectorAll('.viz-mode-btn').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.mode === p.displayMode);
  });
  // 渐变四角语义标签与提示（条柱=上下/左右；环形=0/90/180/270 度）
  const cLabel = document.querySelector('#vizCornerLabel');
  if (cLabel) {
    cLabel.textContent = isRing
      ? '渐变四角 · 0° / 90° / 180° / 270°'
      : '渐变四角 · 单柱上下 / 柱间左右';
  }
  const cornerTitles = isRing
    ? { tl: '0°（正上方）', tr: '90°（右侧）', br: '180°（正下方）', bl: '270°（左侧）' }
    : { tl: '左上：最左柱顶部色', tr: '右上：最右柱顶部色', bl: '左下：最左柱底部色', br: '右下：最右柱底部色' };
  document.querySelectorAll('.viz-corner').forEach((btn) => {
    btn.title = cornerTitles[btn.dataset.corner] || '';
  });
}

function clearPresetActive() {
  document.querySelectorAll('.viz-preset-btn').forEach((b) => b.classList.remove('is-active'));
}

function vizApply(patch) {
  visualizer.setParams(patch);
  vizSave();
  syncVizUI();
  clearPresetActive(); // 自定义参数后取消预设高亮
}

const vizPanel = $('vizPanel');
/* 抽屉定位：面板与播放器同宽、紧贴播放器底部边缘（拖拽播放器时实时跟随） */
function updateVizPanelPos() {
  const r = $('player').getBoundingClientRect();
  vizPanel.style.top = r.bottom + 'px';
  vizPanel.style.left = r.left + 'px';
  vizPanel.style.width = r.width + 'px';
  vizPanel.style.maxHeight = Math.max(120, window.innerHeight - r.bottom - 12) + 'px';
}
/* 抽屉式：从播放器本体底部边缘向下弹出，不遮挡播放器 */
function openVizPanel() {
  updateVizPanelPos();
  vizPanel.classList.remove('hidden');
  requestAnimationFrame(() => vizPanel.classList.add('viz-open'));
  $('vizGear').classList.add('active');
}
function closeVizPanel() {
  vizPanel.classList.remove('viz-open');
  $('vizGear').classList.remove('active');
  setTimeout(() => vizPanel.classList.add('hidden'), 280);
}

/* 齿轮开关 */
$('vizGear').addEventListener('click', () => (vizPanel.classList.contains('hidden') ? openVizPanel() : closeVizPanel()));
$('vizClose').addEventListener('click', closeVizPanel);

/* HSB <-> Hex 颜色工具（色环三轴） */
function hsbToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return '#' + [0, 8, 4].map((n) => Math.round(f(n) * 255).toString(16).padStart(2, '0')).join('');
}
function hexToHsb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = Math.round((h * 60 + 360) % 360);
  const l = (max + min) / 2;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  return { h, s: Math.round(s * 100), l: Math.round(l * 100) };
}

const CORNER_KEYS = ['tl', 'tr', 'bl', 'br'];
let appCorner = 'tl'; // 当前编辑的渐变四角（tl/tr/bl/br）

/* 色环：把 HSB 写到目标（gradient -> 选中角；single -> 主色） */
function vizHsbToTarget(h, s, l) {
  const hex = hsbToHex(h, s, l);
  const p = visualizer.getParams();
  if (p.colorMode === 'gradient') {
    const corners = Object.assign({}, p.gradientCorners || {});
    corners[appCorner] = hex;
    visualizer.setParams({ gradientCorners: corners, colorHue: h, colorSat: s, colorLight: l });
  } else {
    visualizer.setParams({ colorBase: hex, colorHue: h, colorSat: s, colorLight: l });
  }
  vizSave();
  syncVizUI();
}

function onVizCtl(ctl) {
  const k = ctl.dataset.param;
  const val = ctl.type === 'checkbox'
    ? ctl.checked
    : (ctl.tagName === 'SELECT' ? ctl.value : Number(ctl.value));
  if (k === 'colorHue' || k === 'colorSat' || k === 'colorLight') {
    vizHsbToTarget(
      Number(document.querySelector('[data-param="colorHue"]').value),
      Number(document.querySelector('[data-param="colorSat"]').value),
      Number(document.querySelector('[data-param="colorLight"]').value)
    );
    return;
  }
  vizApply({ [k]: val });
}

/* 控件实时联动（range 拖动实时 / select / checkbox；色环三轴走 vizHsbToTarget） */
document.querySelectorAll('.viz-rows [data-param]').forEach((ctl) => {
  ctl.addEventListener('input', () => onVizCtl(ctl));
  ctl.addEventListener('change', () => onVizCtl(ctl));
});

/* 渐变四角选中 */
document.querySelectorAll('.viz-corner').forEach((btn) => {
  btn.addEventListener('click', () => {
    appCorner = btn.dataset.corner;
    const p = visualizer.getParams();
    const c = (p.gradientCorners && p.gradientCorners[appCorner]) || p.colorBase;
    const hsb = hexToHsb(c);
    visualizer.setParams({ colorHue: hsb.h, colorSat: hsb.s, colorLight: hsb.l });
    vizSave();
    syncVizUI();
  });
});

/* 显示模式切换（条柱 / 环形） */
document.querySelectorAll('.viz-mode-btn').forEach((b) => {
  b.addEventListener('click', () => vizApply({ displayMode: b.dataset.mode }));
});

/* 预设按钮 */
document.querySelectorAll('.viz-preset-btn').forEach((b) => {
  b.addEventListener('click', () => {
    visualizer.setPreset(b.dataset.preset);
    vizSave();
    syncVizUI();
    document.querySelectorAll('.viz-preset-btn').forEach((x) => x.classList.toggle('is-active', x === b));
  });
});

/* 恢复默认 */
$('vizReset').addEventListener('click', () => {
  visualizer.setPreset('default');
  vizSave();
  syncVizUI();
  document.querySelectorAll('.viz-preset-btn').forEach((x) => x.classList.toggle('is-active', x.dataset.preset === 'default'));
});

/* 右键频谱 -> 上下文菜单 */
const vizMenu = $('vizMenu');
$('viz').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  vizMenu.classList.remove('hidden');
  vizMenu.style.left = Math.min(e.clientX, window.innerWidth - 130) + 'px';
  vizMenu.style.top = e.clientY + 'px';
});
$('vizMenuOpen').addEventListener('click', () => { vizMenu.classList.add('hidden'); openVizPanel(); });
document.addEventListener('click', (e) => { if (!vizMenu.contains(e.target)) vizMenu.classList.add('hidden'); });

/* ===== 播放器宽度与等比缩放（标注 Music_Player_变体：封面展开 +312；放不下时整体等比缩小） ===== */
const PLAYER_MIN_W = 1160, PLAYER_MAX_W = 2560;
const PLAYER_COVER_EXTRA = 312;      // 变体 B 版：1522 - 1210
const PLAYER_ZOOM_MIN = 0.55, PLAYER_ZOOM_MAX = 1.6;   // 安全阀：过小看不清、过大撑爆
let playerBaseW = 1160;              // 用户设定的横向宽度（不含封面扩展）
let playerZoomUser = 1;              // 用户设定的等比缩放（Shift 拖拽得到）
let playerZoom = 1;                  // 实际生效的缩放 = min(用户值, 视口可容纳上限)

function playerHasCover() { return $('player').classList.contains('has-cover'); }
function playerTargetWidth() { return Math.round(playerBaseW + (playerHasCover() ? PLAYER_COVER_EXTRA : 0)); }

function playerApplyZoom() {
  const el = $('player');
  el.style.transform = playerZoom === 1 ? '' : 'scale(' + playerZoom.toFixed(4) + ')';
  el.style.transformOrigin = 'left top';
}

function playerApplyWidth() {
  const el = $('player');
  el.style.width = playerTargetWidth() + 'px';
  // 安全阀：显示尺寸放不下时整体等比缩小（用户值仍保留，窗口变大后自动还原）
  const avail = Math.max(320, window.innerWidth - 40);
  const availH = Math.max(200, window.innerHeight - 40);
  const fit = Math.min(avail / playerTargetWidth(), availH / 350);
  playerZoom = Math.max(PLAYER_ZOOM_MIN, Math.min(playerZoomUser, fit, PLAYER_ZOOM_MAX));
  playerApplyZoom();
  clampPlayerToViewport();
}

/* 播放器位置保护：面板必须完整留在可视区内，左右各留 20px 边距；
   窗口比面板还窄时左缘固定贴 20px（右侧溢出，可拖右缘缩小面板解决）。
   触发时机：打开页面恢复记忆位置后、恢复宽度后、窗口尺寸变化、拖动结束落位。
   注意：宽度/高度一律取 getBoundingClientRect（等比缩放后 rect 才是真实显示尺寸），
   位置取 style.left/top（transform-origin 为 left top，缩放不影响左缘坐标）。 */
function clampPlayerToViewport() {
  const el = $('player');
  const SPACE = 20;
  const box = el.getBoundingClientRect();
  const w = box.width || el.offsetWidth;
  const h = box.height || el.offsetHeight;
  // 位置由 style.left/top 驱动；offsetLeft 会受定位祖先影响，不能用于此判断
  const curLeft = parseInt(el.style.left, 10) || 0;
  const curTop = parseInt(el.style.top, 10) || 0;
  const maxL = window.innerWidth - w - SPACE;
  const maxT = window.innerHeight - h - SPACE;
  const left = maxL >= SPACE ? Math.max(SPACE, Math.min(maxL, curLeft)) : SPACE;
  const top = maxT >= 8 ? Math.max(8, Math.min(maxT, curTop)) : Math.max(0, maxT);
  el.style.left = Math.round(left) + 'px';
  el.style.top = Math.round(top) + 'px';
  updateVizPanelPos();
}
window.addEventListener('resize', () => { playerApplyWidth(); });

/* 播放器可拖拽浮动面板（桌面应用式）：按住标题/空白区拖动移动；设置抽屉跟随播放器底部 */
(function initPlayerDrag() {
  const el = $('player');
  // 初始定位：优先恢复记忆位置，否则视口居中
  const saved = (() => { try { return JSON.parse(localStorage.getItem('mp.playerPos') || 'null'); } catch (e) { return null; } })();
  if (saved && typeof saved.x === 'number') {
    el.style.left = saved.x + 'px';
    el.style.top = saved.y + 'px';
  } else {
    el.style.left = Math.round((window.innerWidth - el.offsetWidth) / 2) + 'px';
    el.style.top = Math.max(8, Math.round((window.innerHeight - el.offsetHeight) / 2)) + 'px';
  }
  // 位置校正放到宽度恢复之后（initPlayerResize 末尾统一夹取，避免按 CSS 默认宽度误算）
  let drag = false, sx = 0, sy = 0, ox = 0, oy = 0;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, select, a, .bar, .vol-track, .vol-thumb, .vol-hit, .corner-btn, .mute-btn, .resize-l, .resize-r')) return;
    drag = true;
    sx = e.clientX; sy = e.clientY;
    ox = el.getBoundingClientRect().left;
    oy = el.getBoundingClientRect().top;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const x = Math.max(-el.offsetWidth + 100, Math.min(window.innerWidth - 100, ox + e.clientX - sx));
    const y = Math.max(0, Math.min(window.innerHeight - 60, oy + e.clientY - sy));
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    if (!vizPanel.classList.contains('hidden')) updateVizPanelPos();
  });
  const end = () => {
    if (!drag) return;
    drag = false;
    clampPlayerToViewport();   // 落位即校正，避免把越界坐标存进记忆
    try { localStorage.setItem('mp.playerPos', JSON.stringify({ x: parseInt(el.style.left, 10), y: parseInt(el.style.top, 10) })); } catch (err) {}
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
})();

/* 播放窗口缩放：默认拖左/右边缘改「横向拉伸」宽度；
   按住 Shift 拖边缘 = 整体等比缩放（宽高同比，含 0.55~1.6 安全阀）。 */
(function initPlayerResize() {
  const el = $('player');
  const savedW = parseInt(localStorage.getItem('mp.playerWidth'), 10);
  if (!isNaN(savedW)) playerBaseW = Math.max(PLAYER_MIN_W, Math.min(PLAYER_MAX_W, savedW));
  const savedZ = parseFloat(localStorage.getItem('mp.playerZoom'));
  if (!isNaN(savedZ)) playerZoom = Math.max(PLAYER_ZOOM_MIN, Math.min(PLAYER_ZOOM_MAX, savedZ));
  playerApplyWidth();   // 宽度（含封面扩展）+ 等比适配视口 + 位置夹取
  let side = null, startW = 0, startX = 0, initRight = 0, startZoom = 1, startShowW = 0;
  const persist = () => {
    const extra = playerHasCover() ? PLAYER_COVER_EXTRA : 0;
    playerBaseW = Math.round(el.offsetWidth - extra);
    try {
      localStorage.setItem('mp.playerWidth', String(playerBaseW));
      localStorage.setItem('mp.playerZoom', String(playerZoomUser));
    } catch (err) {}
    el.style.transition = '';
    clampPlayerToViewport();
  };
  const bind = (sel) => {
    const h = el.querySelector(sel);
    h.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();   // 避免触发播放器整体移动拖拽
      e.preventDefault();
      side = sel;
      startW = el.offsetWidth;
      startX = e.clientX;
      startZoom = playerZoom;
      startShowW = el.getBoundingClientRect().width;   // 缩放后的真实显示宽度
      initRight = el.getBoundingClientRect().right;
      el.style.transition = 'none';   // 拖拽时禁用过渡，避免拖影滞后
      try { h.setPointerCapture(e.pointerId); } catch {}
    });
    h.addEventListener('pointermove', (e) => {
      if (side !== sel) return;
      const dx = e.clientX - startX;
      if (e.shiftKey) {
        // 等比缩放：按显示宽度比例换算缩放系数，布局宽度不动
        const nextShow = Math.max(200, (sel === '.resize-r' ? startShowW + dx : startShowW - dx));
        let z = startZoom * (nextShow / startShowW);
        z = Math.max(PLAYER_ZOOM_MIN, Math.min(PLAYER_ZOOM_MAX, z));
        playerZoomUser = Math.round(z * 1000) / 1000;
        playerApplyWidth();
        if (sel === '.resize-l') {
          const shownNow = startShowW * (playerZoom / startZoom);
          const x = Math.max(-shownNow + 100, Math.min(window.innerWidth - 100, initRight - shownNow));
          el.style.left = Math.round(x) + 'px';
        }
        clampPlayerToViewport();
        return;
      }
      let w = (sel === '.resize-r') ? startW + dx : startW - dx;
      w = Math.max(PLAYER_MIN_W, Math.min(PLAYER_MAX_W, Math.round(w)));
      playerBaseW = w;
      el.style.width = (w + (playerHasCover() ? PLAYER_COVER_EXTRA : 0)) + 'px';
      if (sel === '.resize-l') {
        const x = Math.max(-w + 100, Math.min(window.innerWidth - 100, initRight - w));
        el.style.left = Math.round(x) + 'px';
      }
      clampPlayerToViewport();
    });
    const end = () => { if (side === sel) { side = null; persist(); } };
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);
  };
  bind('.resize-l');
  bind('.resize-r');
  // 无记忆位置时，按真实宽度重新居中（initPlayerDrag 执行时宽度还是 CSS 默认值，不能用来居中）
  if (!localStorage.getItem('mp.playerPos')) {
    el.style.left = Math.round((window.innerWidth - el.getBoundingClientRect().width) / 2) + 'px';
  }
  clampPlayerToViewport();   // 宽度已确定，此处统一按真实宽度夹取位置（左右各留 20px）
})();

/* 初始化：恢复已保存参数 + 同步控件 */
try {
  const saved = localStorage.getItem('vizParams');
  if (saved) {
    const p = JSON.parse(saved);
    // 旧存档升级：缺少环形 attack/release 时补齐新默认值（峰值保持同时提升到 ~400ms）
    if (!('ringAttack' in p)) {
      const d = visualizer.getParams();
      p.ringAttack = d.ringAttack;
      p.ringRelease = d.ringRelease;
      if (!p.peakHold || p.peakHold <= 6) p.peakHold = d.peakHold;
    }
    visualizer.setParams(p);
  }
} catch {}
syncVizUI();

/* 在线刮削开关：加载持久化偏好 + 绑定切页内控件 */
loadScrapePref();
bindScrapePref();

/* ---------------- 设置面板切页 ---------------- */
/** 本地元数据库概况：切到"在线刮削"页时刷新一次（失败就显示"不可用"，不影响其它功能） */
async function refreshMetaStats() {
  const el = $('metaStatsLine');
  if (!el) return;
  try {
    const r = await fetch('/api/meta/stats');
    const s = await r.json();
    if (!s || s.healthy === false && s.tracks === undefined) { el.textContent = '本地库：不可用（联网刮削结果仅本次有效）'; refreshMetaAudit(false); return; }
    const mb = ((s.dbBytes || 0) / 1048576).toFixed(2);
    el.textContent = '本地库：' + (s.tracks || 0) + ' 首 · ' + (s.covers || 0) + ' 张封面 · ' + mb + ' MB · ' + (s.mode === 'ro' ? '只读（另一实例在写）' : '可写');
  } catch { el.textContent = '本地库：不可用（联网刮削结果仅本次有效）'; refreshMetaAudit(false); return; }
  refreshMetaAudit(true);
}

const AUDIT_LABELS = { title: '曲名', artist: '歌手', album: '专辑', year: '年份', genre: '流派', cover: '封面', lyrics: '歌词' };
const AUDIT_ORDER = ['title', 'artist', 'album', 'year', 'genre', 'cover', 'lyrics'];
/** 字段完整度 + 缺口专辑：只读接口，失败就整块隐藏，不打扰其它设置项 */
async function refreshMetaAudit(show) {
  const box = $('metaAuditBox');
  if (!box) return;
  if (!show) { box.classList.add('hidden'); return; }
  try {
    const r = await fetch('/api/meta/audit?top=5');
    const a = await r.json();
    if (!a || !a.tracks) { box.classList.add('hidden'); return; }

    const rows = AUDIT_ORDER.map((k) => {
      const n = (a.fields && a.fields[k]) || 0;
      const pct = a.tracks ? Math.round((n / a.tracks) * 100) : 0;
      return `<div class="audit-row${pct < 60 ? ' low' : ''}">` +
        `<span class="audit-k">${AUDIT_LABELS[k]}</span>` +
        `<span class="audit-bar"><i style="width:${pct}%"></i></span>` +
        `<span class="audit-v">${n}/${a.tracks}</span></div>`;
    }).join('');

    const prov = Object.entries(a.providers || {})
      .sort((x, y) => y[1] - x[1])
      .map(([k, v]) => `${escapeHtml(k)} ${v}`)
      .join(' / ');

    const foot = `<div class="audit-foot">流派 ${a.genreBucketCount || 0} 个分类 · 来源 ${prov || '—'}</div>`;

    const worst = (a.worstAlbums && a.worstAlbums.length)
      ? `<div class="audit-worst">缺流派最多：` +
        a.worstAlbums.slice(0, 3)
          .map((x) => `${escapeHtml(x.album)} ${x.noGenre}/${x.tracks}`)
          .join(' · ') + `</div>`
      : '';

    box.innerHTML = rows + foot + worst;
    box.classList.remove('hidden');
  } catch { box.classList.add('hidden'); }
}

document.querySelectorAll('.viz-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.viz-tab').forEach((b) => b.classList.toggle('is-active', b === btn));
    document.querySelectorAll('.viz-tab-page').forEach((p) => p.classList.toggle('hidden', p.dataset.tab !== btn.dataset.tab));
    if (btn.dataset.tab === 'scrape') refreshMetaStats();
  });
});

/* ---------------- 标题动效 + 欢迎文本控件 ---------------- */
(function initUserPrefControls() {
  const fxEnabled = $('titleFxEnabled');
  const fxIntensity = $('titleFxIntensity');
  const fxIntensityVal = $('titleFxIntensityVal');
  const fxMode = $('titleFxMode');
  const fxAmp = $('titleFxAmplitude');
  const fxAmpVal = $('titleFxAmplitudeVal');
  const fxCurve = $('titleFxCurve');
  const fxCurveVal = $('titleFxCurveVal');
  const wtTitle = $('welcomeTitle');
  const wtMeta = $('welcomeMeta');

  fxEnabled.checked = userPrefs.titleFx.enabled;
  fxIntensity.value = userPrefs.titleFx.intensity;
  fxIntensityVal.textContent = Math.round(userPrefs.titleFx.intensity * 100) + '%';
  fxMode.value = userPrefs.titleFx.mode;
  fxAmp.value = userPrefs.titleFx.amplitude;
  fxAmpVal.textContent = Math.round(userPrefs.titleFx.amplitude * 100) + '%';
  fxCurve.value = userPrefs.titleFx.curve;
  fxCurveVal.textContent = Math.round(userPrefs.titleFx.curve * 100) + '%';
  wtTitle.value = userPrefs.welcome.title;
  wtMeta.value = userPrefs.welcome.meta;
  // 初始同步欢迎文本（覆盖 HTML 硬编码默认值）
  if (showingWelcome) {
    el.nowTitle.textContent = userPrefs.welcome.title;
    el.nowMeta.textContent = userPrefs.welcome.meta;
  }

  fxEnabled.addEventListener('change', () => {
    userPrefs.titleFx.enabled = fxEnabled.checked;
    localStorage.setItem('mp.titleFx', JSON.stringify(userPrefs.titleFx));
    if (userPrefs.titleFx.enabled && !el.audioEl.paused) startTitleFx();
    else stopTitleFx();
  });
  fxIntensity.addEventListener('input', () => {
    userPrefs.titleFx.intensity = +fxIntensity.value;
    fxIntensityVal.textContent = Math.round(+fxIntensity.value * 100) + '%';
    localStorage.setItem('mp.titleFx', JSON.stringify(userPrefs.titleFx));
  });
  fxMode.addEventListener('change', () => {
    userPrefs.titleFx.mode = fxMode.value;
    localStorage.setItem('mp.titleFx', JSON.stringify(userPrefs.titleFx));
  });
  fxAmp.addEventListener('input', () => {
    userPrefs.titleFx.amplitude = +fxAmp.value;
    fxAmpVal.textContent = Math.round(+fxAmp.value * 100) + '%';
    localStorage.setItem('mp.titleFx', JSON.stringify(userPrefs.titleFx));
  });
  fxCurve.addEventListener('input', () => {
    userPrefs.titleFx.curve = +fxCurve.value;
    fxCurveVal.textContent = Math.round(+fxCurve.value * 100) + '%';
    localStorage.setItem('mp.titleFx', JSON.stringify(userPrefs.titleFx));
  });
  wtTitle.addEventListener('input', () => {
    userPrefs.welcome.title = wtTitle.value;
    localStorage.setItem('mp.welcomeText', JSON.stringify(userPrefs.welcome));
    if (showingWelcome) el.nowTitle.textContent = userPrefs.welcome.title;
  });
  wtMeta.addEventListener('input', () => {
    userPrefs.welcome.meta = wtMeta.value;
    localStorage.setItem('mp.welcomeText', JSON.stringify(userPrefs.welcome));
    if (showingWelcome) el.nowMeta.textContent = userPrefs.welcome.meta;
  });
})();
