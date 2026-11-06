/**
 * 音效可视化背景（最小性能方案 + 可自定义参数引擎 + 条柱/环形模式）
 * -------------------------------------------------
 * 引擎：复用浏览器内置 Web Audio API 的 AnalyserNode（C++ 层实时计算频域），
 *       输出到 Canvas 2D。零第三方引擎、零额外进程、零依赖。
 *
 * 性能门控（守住"最小性能消耗"承诺）：
 *  - 仅「播放中 且 页面可见」时绘制；暂停 / 切后台立即停止 requestAnimationFrame。
 *  - ~30fps（每帧绘制前再等一帧），避免满 60fps 空转。
 *  - fftSize=256（128 bins），每帧只画 O(条数) 次图形（fillRect / 单次 stroke）。
 *  - canvas 固定 DPR=1，不做高清渲染。
 *  - 不使用 backdrop-filter / WebGL / ctx.filter(blur) 等 GPU 重操作。
 *  - 动态增强（峰值下落 / 渐变 / 镜像 / 波浪 / 峰值光点 / 环形）均为 O(N)。
 *
 * 显示模式 displayMode：'bars'（条柱，上下/左右四角双线性）
 *                      'ring' （环形：基准圆 + N 根等宽径向线）
 * 环形模式：
 *  - 每根线一次 stroke，lineWidth 恒定，粗细均匀；barGap 按环半径折算成角度间隙。
 *  - 长度 / 颜色 / 角度三重闭环：ringMirror=true 时频谱双圈镜像（接缝两侧同为低频、长度完全一致），
 *    为 false 时单圈铺满整圈（颜色依旧无缝，长度按相邻频段自然衔接）。
 *  - ringDiameter 控制基准圆直径（中心孔），ringWidth 控制线宽，ringLength 控制满幅长度。
 *  - 对数频率映射：20Hz~16kHz 等对数重采样（近似 1/3 倍频程），低频段加感知补偿。
 *  - 阶梯感抑制（rule.md 数据层最保守子集）：Catmull-Rom 三次插值 → [0,1] 钳制 →
 *    指数平滑（先插值后平滑）→ 邻条 5 点高斯；未引入辉光/自动降级等额外开销。
 *  - 指数平滑 ringAttack / ringRelease（上升快、回落慢）+ 相邻条轻度高斯平滑；
 *    最小长度为内径 10%（静音仍成环），峰值保持默认 12 帧（30fps ≈ 400ms）。
 *
 * 对外接口：
 *  - start(audioEl) / pause() / setVisible(v) / setMargins(l,r)  原有
 *  - setParams(patch)   合并式参数更新（实时生效）
 *  - setPreset(name)    套用内置预设
 *  - getParams()        返回当前参数副本
 *  - PRESETS            预设表（app 侧据此渲染预设按钮）
 */
export const PRESETS = {
  default: {
    displayMode: 'bars',
    barCount: 64, barGap: 1, barRound: 2, baseline: 0.05,
    // Deezer 风格紫粉渐变（商业音乐软件配色）：0/90/180/270 度
    colorMode: 'gradient', colorBase: '#ff0092',
    gradientCorners: { tl: '#a238ff', tr: '#ff0092', br: '#2b0b3a', bl: '#7a5cff' },
    freqGainLow: 1, freqGainMid: 1, freqGainHigh: 1,
    opacity: 0.05, alphaBoost: 0.33,
    fall: 0.93, peakHold: 12, smoothing: 0.35,
    peakDot: true, mirror: false, phaseWave: false,
    ringDiameter: 0.46, ringWidth: 3, ringLength: 0.55, ringMirror: true,
    ringAttack: 0.45, ringRelease: 0.1,
    ringSpin: 0.035, ringParticles: true,
  },
  winamp: {
    displayMode: 'bars',
    barCount: 48, barGap: 2, barRound: 1, baseline: 0.03,
    colorMode: 'gradient', colorBase: '#7a6cff',
    gradientCorners: { tl: '#ffffff', tr: '#7a6cff', bl: '#191446', br: '#4a3fd6' },
    freqGainLow: 1, freqGainMid: 1.05, freqGainHigh: 0.9,
    opacity: 0.06, alphaBoost: 0.4,
    fall: 0.88, peakHold: 15, smoothing: 0.3,
    peakDot: true, mirror: false, phaseWave: true,
    ringDiameter: 0.46, ringWidth: 3, ringLength: 0.55, ringMirror: true,
    ringAttack: 0.5, ringRelease: 0.08,
    ringSpin: 0.03, ringParticles: false,
  },
  neon: {
    displayMode: 'ring',
    barCount: 96, barGap: 1, barRound: 4, baseline: 0,
    colorMode: 'hueCycle', colorBase: '#00e5ff',
    gradientCorners: { tl: '#ff66ff', tr: '#00e5ff', br: '#191446', bl: '#00aaff' },
    freqGainLow: 1, freqGainMid: 1, freqGainHigh: 1.1,
    opacity: 0.06, alphaBoost: 0.45,
    fall: 0.9, peakHold: 12, smoothing: 0.3,
    peakDot: true, mirror: true, phaseWave: false,
    ringDiameter: 0.42, ringWidth: 4, ringLength: 0.5, ringMirror: true,
    ringAttack: 0.5, ringRelease: 0.12,
    ringSpin: 0.05, ringParticles: true,
  },
};

export function createVisualizer(canvas) {
  let ctx = null;
  let audioCtx = null;
  let analyser = null;
  let sourceNode = null;
  let freqData = null;
  let running = false;
  let rafId = 0;
  let W = 0;
  let H = 0;
  let t = 0; // 动画时钟（色相漂移 / 波浪共用）
  let rot = 0;       // 环形整体旋转角（弧度，顺时针为生长方向）
  let rotVel = 0;    // 当前角速度（弧度/秒），起播缓加速、暂停缓减速
  let coastLeft = 0; // 暂停后缓停剩余秒数（仅环形且旋转开启时）
  let breathE = 0;   // 低频呼吸包络（0-1），驱动半径 ±4% 微缩放
  let spawnAcc = 0;  // 粒子生成累加器
  let beat = 0;  // 低频能量（0-1），驱动标题动效；播放中每帧更新，暂停保持末值
  let mL = 0; // 左避让：左抽屉展开时由 app 更新为 264；默认 0
  let mR = 0; // 右避让：右曲目抽屉展开时为 264

  // 高频粒子池（固定 32 个，复用不产生垃圾；配合节拍向外飘散）
  const PARTS_MAX = 32;
  const PARTS = Array.from({ length: PARTS_MAX }, () => ({
    life: 0, max: 1, a: 0, r: 0, vr: 0, sz: 1, c: [255, 255, 255],
  }));

  // 参数（默认 = default 预设；colorHue/Sat/Light 为色环编辑态，用于面板回显与持久化）
  const P = { ...PRESETS.default, colorHue: 272, colorSat: 100, colorLight: 61 };
  // 每柱动态缓存（长度随显示柱数对齐）
  const smooths = []; // 柱间低通（当前值）
  const peaks = [];   // 独立峰值（下落/保持）
  const holds = [];   // 峰值保持计数
  const tmp = [];     // 环形高斯平滑临时缓冲

  function ensureBuffers(n) {
    while (smooths.length < n) { smooths.push(0); peaks.push(0); holds.push(0); tmp.push(0); }
    if (smooths.length > n) { smooths.length = n; peaks.length = n; holds.length = n; tmp.length = n; }
  }

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const lerp = (a, b, x) => a + (b - a) * x;
  const rgbStr = (rgb, a) => `rgba(${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0},${a.toFixed(3)})`;
  const lerpC = (a, b, x) => [lerp(a[0], b[0], x), lerp(a[1], b[1], x), lerp(a[2], b[2], x)];

  /** 合并式参数更新（实时生效，O(1) 合并） */
  function setParams(patch) {
    if (!patch) return;
    for (const k in patch) {
      if (k === 'displayMode') P[k] = patch[k] === 'bars' ? 'bars' : 'ring'; // 旧 radar 存档归并到 ring
      else if (k in P) P[k] = patch[k];
    }
  }
  /** 套用预设 */
  function setPreset(name) {
    if (PRESETS[name]) setParams(PRESETS[name]);
  }
  function getParams() {
    return { ...P };
  }

  function setMargins(l, r) {
    mL = l >= 0 ? l : 0;
    mR = r >= 0 ? r : 0;
  }

  function size() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    W = canvas.width = w; // DPR=1
    H = canvas.height = h;
    ctx = ctx || canvas.getContext('2d');
  }

  function ensureSource(audioEl) {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256; // 128 bins
      analyser.smoothingTimeConstant = 0.7;
      sourceNode = audioCtx.createMediaElementSource(audioEl);
      sourceNode.connect(analyser);
      analyser.connect(audioCtx.destination); // 必须连回输出，否则无声
      freqData = new Uint8Array(analyser.frequencyBinCount);
    }
  }

  function drawBars(g) {
    const {
      barCount, barGap, barRound, baseline, colorMode, colorBase,
      opacity, alphaBoost, fall, peakHold, smoothing, peakDot, mirror, phaseWave,
      gradientCorners, freqGainLow, freqGainMid, freqGainHigh,
    } = P;
    const w = W - mL - mR;
    const half = mirror ? Math.ceil(barCount / 2) : barCount;
    const nShown = mirror ? half * 2 : barCount;
    ensureBuffers(nShown);
    const step = Math.max(1, Math.floor(freqData.length / half));
    const baseRgb = hexToRgb(colorBase);
    const cornerRgb = {
      tl: hexToRgb(gradientCorners.tl), tr: hexToRgb(gradientCorners.tr),
      bl: hexToRgb(gradientCorners.bl), br: hexToRgb(gradientCorners.br),
    };
    // 间距过大时按可用宽度收敛，保证柱宽至少 1px、不溢出画面
    const gapMax = nShown > 1 ? Math.max(0, (w - nShown) / (nShown - 1)) : 0;
    const gap = Math.min(barGap, gapMax);
    const bw = (w - gap * (nShown - 1)) / nShown;
    const topSpace = H * baseline;
    const usableH = H - topSpace;
    const baseHue = colorMode === 'hueCycle' ? (t * 12) % 360 : 0;
    const waveBase = phaseWave ? t * 2.2 : 0;

    for (let si = 0; si < nShown; si++) {
      const src = mirror ? (si < half ? si : half * 2 - 1 - si) : si;
      const raw = freqData[Math.min(freqData.length - 1, src * step)] / 255;
      const gi = half > 1 ? src / half : 0;
      const v = Math.min(1, raw * (gi < 1 / 3 ? freqGainLow : gi < 2 / 3 ? freqGainMid : freqGainHigh));
      smooths[si] = v > smooths[si] ? v : smooths[si] + (v - smooths[si]) * smoothing;
      const s = smooths[si];
      if (v >= peaks[si]) { peaks[si] = v; holds[si] = 0; }
      else if (++holds[si] >= peakHold) { peaks[si] = peaks[si] * fall + v * (1 - fall); holds[si] = 0; }
      const ph = peaks[si];
      let wave = 0;
      if (phaseWave) wave = Math.sin(src * 0.35 + waveBase) * usableH * 0.04;
      const bhRaw = s * usableH * 0.92 + wave;
      const bh = Math.max(1.5, bhRaw);
      const x = mL + si * (bw + gap);
      const y = H - topSpace - bh;

      let fill;
      const a = opacity + s * alphaBoost;
      if (colorMode === 'single') {
        fill = rgbStr(baseRgb, a);
      } else if (colorMode === 'gradient') {
        const pos = nShown > 1 ? si / (nShown - 1) : 0;
        const topC = lerpC(cornerRgb.tl, cornerRgb.tr, pos);
        const botC = lerpC(cornerRgb.bl, cornerRgb.br, pos);
        const hT = Math.min(1, bh / usableH);
        fill = rgbStr(lerpC(botC, topC, hT), a);
      } else {
        const hue = colorMode === 'hueCycle' ? (baseHue + src * 3) % 360 : 150 + (src / half) * 210;
        fill = `hsla(${hue.toFixed(0)},70%,${(50 + s * 30).toFixed(1)}%,${a.toFixed(3)})`;
      }
      g.fillStyle = fill;
      if (barRound > 0 && g.roundRect) {
        g.beginPath();
        g.roundRect(x, y, Math.max(1, bw), bh, barRound);
        g.fill();
      } else {
        g.fillRect(x, y, Math.max(1, bw), bh);
      }
      if (peakDot && ph > 0.03) {
        const phPx = ph * usableH * 0.92;
        const py = H - topSpace - phPx;
        g.fillStyle = `rgba(255,255,255,${(0.15 + ph * 0.4).toFixed(3)})`;
        const r = Math.max(1, Math.min(3, bw * 0.4));
        g.beginPath();
        g.arc(x + bw / 2, py, r, 0, Math.PI * 2);
        g.fill();
      }
    }
  }

  /** 环形四角颜色：0/90/180/270 度循环插值，360 度回到 0 度（首尾同色） */
  function ringColorAt(cr, tt) {
    const stops = [cr.tl, cr.tr, cr.br, cr.bl];
    const p = ((tt % 1) + 1) % 1 * 4;
    const k = Math.floor(p) & 3;
    return lerpC(stops[k], stops[(k + 1) & 3], p - Math.floor(p));
  }

  /** 规则 A2/A3：Catmull-Rom 三次插值采样 FFT bin（边界复制端点），结果钳制到 [0,1] */
  function cubicBin(pos) {
    const len = freqData.length;
    const i1 = Math.floor(pos);
    const p0 = freqData[Math.max(0, i1 - 1)] / 255;
    const p1 = freqData[i1] / 255;
    const p2 = freqData[Math.min(len - 1, i1 + 1)] / 255;
    const p3 = freqData[Math.min(len - 1, i1 + 2)] / 255;
    const u = pos - i1;
    const v = 0.5 * (2 * p1 + (-p0 + p2) * u
      + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u
      + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u);
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  function drawRing(g) {
    const {
      barCount, barGap, barRound, colorMode, colorBase, opacity, alphaBoost,
      fall, peakHold, peakDot, phaseWave,
      gradientCorners, freqGainLow, freqGainMid, freqGainHigh,
      ringDiameter, ringWidth, ringLength, ringMirror, ringAttack, ringRelease, ringParticles,
    } = P;
    const n = Math.max(8, barCount);
    const mirror = ringMirror !== false;
    const lanes = mirror ? Math.ceil(n / 2) : n; // 双圈：只算半圈数据，两侧共用；单圈：整圈铺满频谱
    ensureBuffers(lanes);
    const cx = (mL + W - mR) / 2;
    const cy = H / 2;
    const availR = Math.min((W - mL - mR) / 2, H / 2) - 8;
    const baseR = Math.max(6, ringDiameter * availR);
    const slotAngle = (Math.PI * 2) / n;
    const slotArc = baseR * slotAngle;
    // 线宽恒定；间距按环半径折算角度，拥挤时优先压缩线宽、保证不重叠
    const wPx = Math.max(1, Math.min(ringWidth, Math.max(1, slotArc - Math.max(0, barGap))));
    // 最大长度不越过可用半径（按呼吸峰值 baseR×1.04 预留，外缘不裁切）
    const maxLen = Math.max(3, Math.min(ringLength * availR, availR - baseR * 1.04 - wPx));
    const baseRgb = hexToRgb(colorBase);
    const cornerRgb = {
      tl: hexToRgb(gradientCorners.tl), tr: hexToRgb(gradientCorners.tr),
      bl: hexToRgb(gradientCorners.bl), br: hexToRgb(gradientCorners.br),
    };
    const baseHue = colorMode === 'hueCycle' ? (t * 12) % 360 : 0;
    const waveBase = phaseWave ? t * 2.2 : 0;

    // 对数频率映射：20Hz ~ min(16kHz, 奈奎斯特)，按等对数刻度重采样（近似 1/3 倍频程）
    const nyq = audioCtx ? audioCtx.sampleRate / 2 : 24000;
    const fMin = 20;
    const fMax = Math.min(nyq, 16000);
    const fRatio = Math.log(fMax / fMin);
    const binHz = nyq / freqData.length;
    const attack = ringAttack != null ? ringAttack : 0.45;
    const release = ringRelease != null ? ringRelease : 0.1;
    let lowSum = 0, lowCnt = 0, hiSum = 0, hiCnt = 0; // 低频呼吸 / 高频粒子能量

    for (let j = 0; j < lanes; j++) {
      const u = lanes > 1 ? j / (lanes - 1) : 0;
      const f = fMin * Math.exp(fRatio * u);
      // 规则 A2/A3：三次插值采样（禁止最近邻），消除 bin 复制造成的台阶
      const pos = Math.min(freqData.length - 1, f / binHz);
      const raw = cubicBin(pos);
      // 低频感知补偿：20Hz 处 ×1.25，到 250Hz 回落至 ×1
      const shelf = f < 250 ? 1.25 - 0.25 * (f / 250) : 1;
      const gain = f < 250 ? freqGainLow : f < 2000 ? freqGainMid : freqGainHigh;
      // 规则 A4：钳制到 [0,1]
      const v = Math.min(1, Math.max(0, raw * gain * shelf));
      if (f < 250) { lowSum += v; lowCnt++; }
      else if (f >= 2000) { hiSum += v; hiCnt++; }
      // 规则 A5：插值之后再指数平滑（上升快 attack、回落慢 release）
      const cur = smooths[j];
      smooths[j] = cur + (v - cur) * (v > cur ? attack : release);
    }
    // 相邻条轻度平滑：两次 [1,2,1]/4 卷积 ≈ 5 点高斯，边缘钳制，消除条间高度台阶
    for (let pass = 0; pass < 2; pass++) {
      const src = pass === 0 ? smooths : tmp;
      const dst = pass === 0 ? tmp : smooths;
      for (let j = 0; j < lanes; j++) {
        const a = src[j > 0 ? j - 1 : 0];
        const c = src[j < lanes - 1 ? j + 1 : lanes - 1];
        dst[j] = (a + src[j] * 2 + c) * 0.25;
      }
    }
    for (let j = 0; j < lanes; j++) {
      const s = smooths[j];
      if (s >= peaks[j]) { peaks[j] = s; holds[j] = 0; }
      else if (++holds[j] >= peakHold) { peaks[j] = peaks[j] * fall + s * (1 - fall); holds[j] = 0; }
    }

    // 呼吸感：低频能量驱动整体半径 0~+4% 微缩放，包络平滑避免果冻感
    const lowE = lowCnt ? lowSum / lowCnt : 0;
    const hiE = hiCnt ? hiSum / hiCnt : 0;
    breathE += (lowE - breathE) * 0.12;
    const bR = baseR * (1 + breathE * 0.04);
    // 最小长度 = 内径的 10%，静音时环形仍完整可辨
    const minLen = Math.max(2, bR * 0.1);

    const cap = barRound > 0 ? 'round' : 'butt';
    for (let i = 0; i < n; i++) {
      const j = (mirror && i >= lanes) ? n - 1 - i : i; // 双圈：接缝两侧共用同一索引，长度完全一致
      const s = smooths[j];
      const ph = peaks[j];
      const theta = -Math.PI / 2 + rot + i * slotAngle; // 正上方起始，顺时针（rot 为整体旋转）
      let wave = 0;
      if (phaseWave) wave = Math.sin(theta * 6 + waveBase) * maxLen * 0.04; // 整数倍频，绕一圈闭合
      const len = Math.max(minLen, s * maxLen + wave);
      const a = opacity + s * alphaBoost;
      const tt = i / n; // 周向位置 0-1，循环取色

      let fill;
      if (colorMode === 'single') {
        fill = rgbStr(baseRgb, a);
      } else if (colorMode === 'gradient') {
        const c = ringColorAt(cornerRgb, tt);
        const inner = [c[0] * 0.42, c[1] * 0.42, c[2] * 0.42];
        const rg = g.createRadialGradient(cx, cy, bR, cx, cy, bR + len + 1);
        rg.addColorStop(0, rgbStr(inner, a));
        rg.addColorStop(1, rgbStr(c, a));
        fill = rg;
      } else {
        const hue = colorMode === 'hueCycle'
          ? (baseHue + 360 * tt) % 360
          : 150 + (j / Math.max(1, lanes - 1)) * 210;
        fill = `hsla(${hue.toFixed(0)},70%,${(50 + s * 30).toFixed(1)}%,${a.toFixed(3)})`;
      }

      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const r0 = bR + (cap === 'round' ? wPx / 2 : 0);
      const r1 = Math.max(r0 + 0.5, bR + len - (cap === 'round' ? wPx / 2 : 0));
      g.strokeStyle = fill;
      g.lineWidth = wPx;
      g.lineCap = cap;
      g.beginPath();
      g.moveTo(cx + cos * r0, cy + sin * r0);
      g.lineTo(cx + cos * r1, cy + sin * r1);
      g.stroke();

      // 峰值保持线：亮色细弧，随回落渐隐
      if (peakDot && ph - s > 0.02) {
        const rPh = Math.min(availR - 1, bR + ph * maxLen);
        const gap = Math.min(1, ph - s);
        g.strokeStyle = `rgba(255,255,255,${Math.min(0.85, 0.12 + gap * 1.1).toFixed(3)})`;
        g.lineWidth = 1;
        g.beginPath();
        g.arc(cx, cy, rPh, theta - slotAngle * 0.45, theta + slotAngle * 0.45);
        g.stroke();
      }
    }

    // 高频粒子：少量光点随高频能量向外飘散（固定池 32 个，避免 GC）
    if (ringParticles !== false) {
      const highStart = Math.floor(lanes * 2 / 3);
      if (running) {
        spawnAcc += hiE * 2.2;
        while (spawnAcc >= 1) {
          spawnAcc -= 1;
          let slot = -1;
          for (let k = 0; k < PARTS_MAX; k++) { if (PARTS[k].life <= 0) { slot = k; break; } }
          if (slot < 0) { spawnAcc = 0; break; }
          let i0 = -1, j0 = -1;
          for (let k = 0; k < 4; k++) {
            const cand = Math.floor(Math.random() * n);
            const lane = (mirror && cand >= lanes) ? n - 1 - cand : cand;
            if (lane >= highStart) { i0 = cand; j0 = lane; break; }
          }
          if (i0 < 0) break;
          const p = PARTS[slot];
          p.life = p.max = 0.8 + Math.random() * 0.7;
          p.a = -Math.PI / 2 + i0 * slotAngle;
          p.r = bR + smooths[j0] * maxLen * (0.5 + Math.random() * 0.45);
          p.vr = 10 + Math.random() * 22;
          p.sz = 1 + Math.random() * 1.2;
          p.c = colorMode === 'gradient' ? ringColorAt(cornerRgb, i0 / n)
            : colorMode === 'single' ? baseRgb : [220, 240, 255];
        }
        for (let k = 0; k < PARTS_MAX; k++) {
          const p = PARTS[k];
          if (p.life <= 0) continue;
          p.life -= 1 / 30;
          p.r += p.vr / 30;
        }
      }
      for (let k = 0; k < PARTS_MAX; k++) {
        const p = PARTS[k];
        if (p.life <= 0) continue;
        const ang = p.a + rot; // 粒子跟随整体旋转
        const al = (p.life / p.max) * 0.75;
        g.fillStyle = rgbStr(p.c, al);
        g.beginPath();
        g.arc(cx + Math.cos(ang) * p.r, cy + Math.sin(ang) * p.r, p.sz, 0, Math.PI * 2);
        g.fill();
      }
    }
  }

  function draw() {
    rafId = 0;
    const playing = running;
    // 缓停：暂停后仅环形继续绘制一小段时间，角速度衰减
    const coasting = !playing && coastLeft > 0 && P.displayMode === 'ring' && P.ringSpin > 0;
    if (!playing && !coasting) return;
    const g = ctx;
    g.clearRect(0, 0, W, H);
    const w = W - mL - mR;
    if (!playing) coastLeft -= 1 / 30;
    if (w > 8 && analyser && audioCtx && (playing ? audioCtx.state === 'running' : true)) {
      if (playing) {
        analyser.getByteFrequencyData(freqData);
        // 低频能量（前 12 bins ≈ 0~500Hz，覆盖底鼓/贝斯节拍），供标题动效 getBeat() 读取
        let bsum = 0;
        const BLOW = Math.min(12, freqData.length);
        for (let bi = 0; bi < BLOW; bi++) bsum += freqData[bi];
        beat = bsum / BLOW / 255;
        t += 0.06;
        rotVel += (P.ringSpin * Math.PI * 2 - rotVel) * 0.12; // 起播缓加速，方向与频谱生长一致（顺时针）
      } else {
        rotVel *= 0.9;
      }
      rot = (rot + rotVel / 30) % (Math.PI * 2);
      if (P.displayMode === 'bars') drawBars(g);
      else drawRing(g);
    }
    if (!playing && coastLeft <= 0) { rotVel = 0; return; } // 缓停结束，保留最后一帧
    // 降频至 ~30fps
    requestAnimationFrame(() => {
      requestAnimationFrame(draw);
    });
  }

  function start(audioEl) {
    try {
      ensureSource(audioEl);
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    } catch {
      running = false;
      return;
    }
    running = true;
    if (rafId === 0) draw();
  }

  function pause() {
    // 环形旋转：暂停后保留 0.45s 缓停（角速度指数衰减），避免突然停住
    const canCoast = running && P.displayMode === 'ring' && P.ringSpin > 0;
    running = false; // 保留最后一帧
    if (canCoast) coastLeft = 0.45;
  }

  function setVisible(v) {
    if (!v) { coastLeft = 0; rotVel = 0; } // 切后台立即停，不做缓停
    running = v && running;
    if (running && rafId === 0) draw();
  }

  size();
  window.addEventListener('resize', () => size());

  return { start, pause, setVisible, setMargins, setParams, setPreset, getParams, getBeat: () => beat };
}
