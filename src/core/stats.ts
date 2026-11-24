/**
 * stats.ts — 场景亮度分布统计、切镜头检测、参数时序平滑
 *
 * 渲染端把降采样后的 log10(nits) 亮度读回，TS 端建直方图、
 * 求百分位，再用帧率无关的指数平滑去跟踪场景锚点。
 * 切镜头时不跳变，而是用更短（但仍平滑）的时间常数过渡。
 */

import type { ToneParams, SceneTone } from './params';

export const LOG_BIN_MIN = -2; // 0.01 nit
export const LOG_BIN_MAX = 4; // 10000 nit
export const HIST_BINS = 256;

export interface FrameStats {
  black: number;
  shadow: number;
  mid: number;
  p95: number;
  white: number;
  high: number;
  /** 归一化直方图，用于切镜头检测 */
  hist: Float64Array;
  meanLog: number;
}

export function emptyHistogram(): Float64Array {
  return new Float64Array(HIST_BINS);
}

/** 从 log10(nits) 采样数组建立直方图 */
export function buildHistogram(logLuma: ArrayLike<number>): {
  hist: Float64Array;
  meanLog: number;
} {
  const hist = new Float64Array(HIST_BINS);
  let sum = 0;
  const n = logLuma.length;
  for (let i = 0; i < n; i++) {
    let v = logLuma[i];
    if (!Number.isFinite(v)) v = LOG_BIN_MIN;
    const t = (v - LOG_BIN_MIN) / (LOG_BIN_MAX - LOG_BIN_MIN);
    const b = Math.min(HIST_BINS - 1, Math.max(0, (t * HIST_BINS) | 0));
    hist[b]++;
    sum += v;
  }
  if (n > 0) {
    for (let i = 0; i < HIST_BINS; i++) hist[i] /= n;
  }
  return { hist, meanLog: n ? sum / n : 0 };
}

function nitAtBinCenter(b: number): number {
  const t = (b + 0.5) / HIST_BINS;
  const logV = LOG_BIN_MIN + t * (LOG_BIN_MAX - LOG_BIN_MIN);
  return Math.pow(10, logV);
}

/** 由归一化直方图求百分位 nit 值 */
export function percentileFromHist(hist: Float64Array, p: number): number {
  let acc = 0;
  const target = p / 100;
  for (let b = 0; b < HIST_BINS; b++) {
    if (acc + hist[b] >= target) {
      //  bin 内线性插值
      const prev = acc;
      const frac = hist[b] > 0 ? Math.min(1, Math.max(0, (target - prev) / hist[b])) : 0;
      const logLo = LOG_BIN_MIN + (b / HIST_BINS) * (LOG_BIN_MAX - LOG_BIN_MIN);
      const logHi = LOG_BIN_MIN + ((b + 1) / HIST_BINS) * (LOG_BIN_MAX - LOG_BIN_MIN);
      return Math.pow(10, logLo + (logHi - logLo) * frac);
    }
    acc += hist[b];
  }
  return nitAtBinCenter(HIST_BINS - 1);
}

export function analyzeHistogram(
  hist: Float64Array,
  meanLog: number,
  whitePercentile = 99.5,
): FrameStats {
  return {
    black: percentileFromHist(hist, 0.5),
    shadow: percentileFromHist(hist, 5),
    mid: percentileFromHist(hist, 50),
    p95: percentileFromHist(hist, 95),
    white: percentileFromHist(hist, whitePercentile),
    high: percentileFromHist(hist, 99.9),
    hist,
    meanLog,
  };
}

/** 直方图交集距离：0 = 完全相同，1 = 完全不同 */
export function histogramDistance(a: Float64Array, b: Float64Array): number {
  let inter = 0;
  for (let i = 0; i < HIST_BINS; i++) inter += Math.min(a[i], b[i]);
  return Math.max(0, Math.min(1, 1 - inter));
}

/** 平滑器内部状态 */
export class ToneSmoother {
  private logBlack = Math.log10(8);
  private logShadow = Math.log10(20);
  private logMid = Math.log10(80);
  private logP95 = Math.log10(400);
  private logWhite = Math.log10(1000);
  private logHigh = Math.log10(2500);
  private prevHist: Float64Array | null = null;
  /** 切镜头后用快速时间常数过渡的剩余程度 1->0 */
  cutBlend = 0;
  lastCut = false;
  initialized = false;

  reset(): void {
    this.prevHist = null;
    this.cutBlend = 0;
    this.initialized = false;
  }

  /**
   * 吃进一帧统计，输出平滑后的 SceneTone。
   * @param dtSec 距上一帧的真实时间（秒）
   */
  update(stats: FrameStats, params: ToneParams, dtSec: number): SceneTone {
    let cut = false;
    let cutScore = 0;
    if (this.prevHist) {
      cutScore = histogramDistance(this.prevHist, stats.hist);
      if (cutScore > params.cutThreshold) cut = true;
    }
    this.prevHist = stats.hist.slice();

    if (!this.initialized) {
      // 第一帧直接贴合，避免开场从默认值缓入
      this.logBlack = Math.log10(Math.max(stats.black, 0.01));
      this.logShadow = Math.log10(Math.max(stats.shadow, 0.01));
      this.logMid = Math.log10(Math.max(stats.mid, 0.1));
      this.logP95 = Math.log10(Math.max(stats.p95, 0.1));
      this.logWhite = Math.log10(Math.max(stats.white, 1));
      this.logHigh = Math.log10(Math.max(stats.high, 1));
      this.initialized = true;
      return this.toScene(false, 1);
    }

    if (cut) this.cutBlend = 1;

    // 切镜头后的过渡窗口内用 cutTimeSec，否则用 slow smoothTimeSec
    const tau = this.cutBlend > 0.02 ? params.cutTimeSec : params.smoothTimeSec;
    const dt = Math.min(0.1, Math.max(0.0005, dtSec));
    const alpha = 1 - Math.exp(-dt / Math.max(0.05, tau));

    this.logBlack = dampLog(this.logBlack, stats.black, alpha);
    this.logShadow = dampLog(this.logShadow, stats.shadow, alpha);
    this.logMid = dampLog(this.logMid, stats.mid, alpha);
    this.logP95 = dampLog(this.logP95, stats.p95, alpha);
    this.logWhite = dampLog(this.logWhite, stats.white, alpha);
    this.logHigh = dampLog(this.logHigh, stats.high, alpha);

    // cutBlend 按 cutTime 衰减，仅用于 UI/调试
    this.cutBlend *= Math.exp(-dt / Math.max(0.1, params.cutTimeSec));
    this.lastCut = cut;

    return this.toScene(cut, 1 - this.cutBlend);
  }

  private toScene(cut: boolean, settle: number): SceneTone {
    return {
      black: Math.pow(10, this.logBlack),
      shadow: Math.pow(10, this.logShadow),
      mid: Math.pow(10, this.logMid),
      p95: Math.pow(10, this.logP95),
      white: Math.pow(10, this.logWhite),
      high: Math.pow(10, this.logHigh),
      cut,
      cutSettle: settle,
    };
  }
}

/**
 * 对数域阻尼 + 小死区：
 * 同场景统计抖动小于 ~0.3%（log10 0.0013）时不动，杜绝微闪。
 */
function dampLog(prevLog: number, targetNits: number, alpha: number): number {
  const targetLog = Math.log10(Math.max(targetNits, 0.01));
  const delta = targetLog - prevLog;
  if (Math.abs(delta) < 0.0013) return prevLog;
  return prevLog + delta * alpha;
}

/**
 * 不经过平滑器，直接由一帧统计构造 SceneTone（测试/静态分析用）。
 * autoScene=false 时使用固定锚点。
 */
export function directScene(stats: FrameStats | null, p: ToneParams): SceneTone {
  if (!p.autoScene || !stats) {
    return {
      black: 1,
      shadow: 18,
      mid: 90,
      p95: 400,
      white: 1000,
      high: 4000,
      cut: false,
      cutSettle: 1,
    };
  }
  return {
    black: stats.black,
    shadow: stats.shadow,
    mid: stats.mid,
    p95: stats.p95,
    white: stats.white,
    high: stats.high,
    cut: false,
    cutSettle: 1,
  };
}
