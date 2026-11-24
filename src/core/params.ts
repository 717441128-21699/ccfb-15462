/**
 * params.ts — 映射参数、默认值与色调曲线锚点构造
 *
 * 曲线用 8 个锚点的单调三次 Hermite（Fritsch–Carlson 斜率），
 * TS 端构造锚点与斜率，GLSL 端用完全相同的 Hermite 基函数求值。
 */

export type TransferMode = 'auto' | 'pq' | 'hlg' | 'bt709';

export interface ToneParams {
  /** SDR 目标白峰 nit（平台通常 100） */
  targetPeakNits: number;
  /** HDR 漫反射白基准，BT.2408 建议 203 */
  diffuseWhiteNits: number;
  /** 用户曝光补偿 EV */
  exposureEV: number;
  /** 是否按场景亮度分布自动锚定 */
  autoScene: boolean;
  /** 白位点百分位 */
  whitePercentile: number;
  /** 阴影提升强度 0..1（暗部衣服纹理） */
  shadowLift: number;
  /** 局部清晰度 / 局部反差 0..1 */
  shadowTexture: number;
  /** 高光肩部强度 0..1（云、霓虹灯层次） */
  highlightRolloff: number;
  /** 全局反差 */
  contrast: number;
  /** 饱和度 0..1.5 */
  saturation: number;
  /** BT.2020→709 色域压缩强度（默认恒色相投影，1=精确边界） */
  gamutCompress: number;
  /** 肤色保护 0..1 */
  skinProtect: number;
  /** 同场景参数平滑时间常数（秒） */
  smoothTimeSec: number;
  /** 切镜头后的过渡时间常数（秒），仍然是慢慢过渡，不闪 */
  cutTimeSec: number;
  /** 切镜头判定阈值（直方图距离 0..1） */
  cutThreshold: number;
  /** 分屏位置 0..1（UI 状态，不参与核心） */
  split: number;
}

export const DEFAULT_PARAMS: ToneParams = {
  targetPeakNits: 100,
  diffuseWhiteNits: 203,
  exposureEV: 0,
  autoScene: true,
  whitePercentile: 99.5,
  shadowLift: 0.62,
  shadowTexture: 0.45,
  highlightRolloff: 0.8,
  contrast: 1.06,
  saturation: 1.04,
  gamutCompress: 1,
  skinProtect: 0.85,
  smoothTimeSec: 1.1,
  cutTimeSec: 0.85,
  cutThreshold: 0.42,
  split: 0.5,
};

export function cloneParams(p: ToneParams): ToneParams {
  return { ...p };
}

/** 平滑后的场景锚点，单位 nit */
export interface SceneTone {
  black: number;
  shadow: number;
  mid: number;
  p95: number;
  white: number;
  high: number;
  /** 本帧是否判定为切镜头 */
  cut: boolean;
  /** 切镜头后的过渡进度 0..1（1 = 已贴合新场景） */
  cutSettle: number;
}

export interface CurveKnots {
  /** 归一化输入 x = 2^EV * nit / whiteNit */
  x: number[];
  /** 输出显示线性光 0..1 */
  y: number[];
  /** Fritsch–Carlson 切线斜率 */
  m: number[];
}

const K = 8;

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * 根据场景锚点与参数构造 8 锚点单调曲线。
 *
 * 设计原则（肤色 ΔE 与高光层次兼得的关键）：
 *  - x 以 HDR 漫反射白（默认 203nit，BT.2408）归一化，x=1 即参考白；
 *  - x∈[~0.14, 0.5] 是肤色主要区间，锚点直接放在 y=x 上，
 *    Fritsch–Carlson 割线斜率全为 1 => Hermite 段严格还原恒等映射；
 *  - 暗部提升只作用在 x<0.1 的趾部（深色衣服），到 x=0.14 回到恒等，
 *    不抬深肤色；
 *  - 场景分布只动态改变黑位点、暗趾目标和白位肩部长度，
 *    云 / 霓虹 / 雪地各自得到不同的肩部。
 */
export function buildCurve(scene: SceneTone, p: ToneParams): CurveKnots {
  const evGain = Math.pow(2, p.exposureEV);
  const ref = Math.max(p.diffuseWhiteNits, 1);
  const ex = (nit: number) => (evGain * nit) / ref;

  const blackX = Math.min(0.08, Math.max(0, ex(scene.black)));
  const shadowX = Math.min(0.09, Math.max(blackX + 0.004, ex(scene.shadow)));
  const whiteX = Math.max(1.05, ex(scene.white));
  const highX = Math.max(whiteX + 0.4, ex(scene.high));
  const farX = Math.max(3.2, highX * 1.25, whiteX * 1.7);

  // 暗趾目标（sRGB 编码域）：默认约 0.29，把 p5 暗纹拉到可辨
  const qShadow = 0.13 + 0.26 * p.shadowLift;

  // 肩部两个锚点的编码目标
  const qShoulder0 = 0.845; // x=0.85
  const qWhite = 0.95 - 0.09 * p.highlightRolloff; // 默认 .878

  const x = [0, blackX, shadowX, 0.14, 0.5, 0.85, whiteX, farX];
  // y 用线性光：恒等锚点 y=x；肩部锚点由编码目标转回
  let y = [
    0,
    0,
    srgbDecodeSimple(qShadow),
    0.14,
    0.5,
    srgbDecodeSimple(qShoulder0),
    srgbDecodeSimple(qWhite),
    1,
  ];

  // 反差围绕编码域 0.5 拉伸（会轻微偏离恒等线，默认值很温和）
  if (Math.abs(p.contrast - 1) > 1e-4) {
    y = y.map((lin, i) => {
      if (i === 0 || i === K - 1) return lin;
      const q = srgbEncodeSimple(lin);
      const qc = 0.5 + (q - 0.5) * p.contrast;
      return srgbDecodeSimple(Math.min(1, Math.max(0, qc)));
    });
  }

  // 保证 x 严格递增（统计百分位可能重合）
  const xMinGap = 1e-4;
  for (let i = 1; i < K; i++) {
    if (x[i] < x[i - 1] + xMinGap) x[i] = x[i - 1] + xMinGap;
  }
  // 保证 y 严格递增
  const yMinGap = 1e-3;
  y[0] = 0;
  y[K - 1] = 1;
  for (let i = 1; i < K; i++) {
    if (y[i] <= y[i - 1] + yMinGap) y[i] = y[i - 1] + yMinGap;
  }
  for (let i = K - 2; i >= 1; i--) {
    if (y[i] >= y[i + 1] - yMinGap) y[i] = y[i + 1] - yMinGap;
  }
  if (y[1] < 0 || y[K - 2] > 1 || y[2] <= y[1]) {
    for (let i = 1; i < K - 1; i++) y[i] = i / (K - 1);
  }
  y[0] = 0;
  y[K - 1] = 1;

  const m = fritschCarlson(x, y);
  return { x, y, m };
}

export function srgbEncodeSimple(c: number): number {
  const x = Math.min(1, Math.max(0, c));
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

export function srgbDecodeSimple(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Fritsch–Carlson 单调三次斜率 */
export function fritschCarlson(x: number[], y: number[]): number[] {
  const n = x.length;
  const dk: number[] = new Array(n - 1);
  for (let k = 0; k < n - 1; k++) dk[k] = (y[k + 1] - y[k]) / (x[k + 1] - x[k]);

  const m: number[] = new Array(n).fill(0);
  m[0] = dk[0];
  m[n - 1] = dk[n - 2];
  for (let k = 1; k < n - 1; k++) {
    if (dk[k - 1] * dk[k] <= 0) m[k] = 0;
    else {
      const hkm1 = x[k] - x[k - 1];
      const hk = x[k + 1] - x[k];
      const w1 = 2 * hk + hkm1;
      const w2 = hk + 2 * hkm1;
      m[k] = (w1 + w2) / (w1 / dk[k - 1] + w2 / dk[k]);
    }
  }
  // 限制斜率保证单调
  for (let k = 0; k < n - 1; k++) {
    if (Math.abs(dk[k]) < 1e-12) {
      m[k] = 0;
      m[k + 1] = 0;
      continue;
    }
    const alpha = m[k] / dk[k];
    const beta = m[k + 1] / dk[k];
    const s = alpha * alpha + beta * beta;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      m[k] = tau * alpha * dk[k];
      m[k + 1] = tau * beta * dk[k];
    }
  }
  return m;
}

/** CPU 端 Hermite 求值，必须与 shader 的 curveEval 完全一致 */
export function evalCurve(c: CurveKnots, xin: number): number {
  const { x, y, m } = c;
  const n = x.length;
  if (xin <= x[0]) return y[0] + m[0] * (xin - x[0]) < 0 ? 0 : y[0] + m[0] * (xin - x[0]);
  if (xin >= x[n - 1]) return y[n - 1];
  let i = 0;
  while (i < n - 2 && xin > x[i + 1]) i++;
  const h = x[i + 1] - x[i];
  const t = (xin - x[i]) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  const v = h00 * y[i] + h10 * h * m[i] + h01 * y[i + 1] + h11 * h * m[i + 1];
  return Math.min(1, Math.max(0, v));
}
