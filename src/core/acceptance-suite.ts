/**
 * acceptance-suite.ts — ΔE00 肤色 + 时序稳定性检查（同构，无 Node/DOM 依赖）
 * verify-color.ts 与右侧“验收指标”面板都调用这里。
 */

import type { Lab } from './color';
import { deltaE00, pqInverseEotfNits, hlgOetf } from './color';
import { SKIN_PATCHES } from './skin';
import { DEFAULT_PARAMS, buildCurve, type ToneParams } from './params';
import { ToneSmoother, buildHistogram, type FrameStats } from './stats';
import {
  processPixel,
  labToBt2020Linear,
  type PipelineContext,
} from './pipeline-cpu';

export const PORTRAIT_ANCHORS = {
  black: 3.5,
  shadow: 14,
  mid: 78,
  p95: 480,
  white: 1700,
  high: 4200,
};

export interface SkinRow {
  id: string;
  group: string;
  L: number;
  de: number;
}

export interface ColorSuite {
  patchCount: number;
  mean: number;
  max: number;
  p95: number;
  rows: SkinRow[];
  sceneBattery: { scene: string; mean: number; max: number }[];
  gpuApprox: { mean: number; max: number };
  temporal: { stableMaxDE: number; cutMaxDE: number; convergenceResidualDE: number };
  pass: boolean;
}

function ctxFor(overrides: Partial<ToneParams> = {}, chromaIters?: number): PipelineContext {
  const params: ToneParams = { ...DEFAULT_PARAMS, ...overrides };
  return {
    transfer: 'pq',
    params,
    curve: buildCurve({ ...PORTRAIT_ANCHORS, cut: false, cutSettle: 1 }, params),
    whiteNit: params.diffuseWhiteNits,
    chromaIters,
  };
}

function runSkin(ctx: PipelineContext): { rows: SkinRow[]; mean: number; max: number; p95: number } {
  const rows: SkinRow[] = [];
  for (const patch of SKIN_PATCHES) {
    const lin = labToBt2020Linear(patch.lab);
    const nits = lin.map((v) => Math.max(0, v) * ctx.params.diffuseWhiteNits) as [number, number, number];
    const code = nits.map(pqInverseEotfNits) as [number, number, number];
    const out = processPixel(code, ctx);
    rows.push({ id: patch.id, group: patch.group, L: patch.lab.L, de: deltaE00(patch.lab, out.labOut) });
  }
  const sorted = rows.map((r) => r.de).sort((a, b) => a - b);
  return {
    rows,
    mean: sorted.reduce((s, v) => s + v, 0) / sorted.length,
    max: sorted[sorted.length - 1],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
  };
}

function makeHist(centerLog: number, spread: number, seed: number): Float64Array {
  const samples = new Array<number>(4096);
  let s = seed >>> 0;
  const rnd = () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  for (let i = 0; i < samples.length; i++) {
    samples[i] = centerLog + (rnd() + rnd() + rnd() - 1.5) * spread;
  }
  return buildHistogram(samples).hist;
}

function statsLike(a: Record<string, number>, hist: Float64Array): FrameStats {
  return {
    black: a.black, shadow: a.shadow, mid: a.mid, p95: a.p95, white: a.white, high: a.high,
    hist, meanLog: Math.log10(a.mid),
  };
}

function runTemporal(): ColorSuite['temporal'] {
  const params = { ...DEFAULT_PARAMS };
  const smoother = new ToneSmoother();
  const histA = makeHist(1.9, 1.6, 1234);
  const histB = makeHist(0.7, 1.8, 9876);
  const patch = SKIN_PATCHES.find((p) => p.id === 'fitzIII-neutral')!;
  const code = labToBt2020Linear(patch.lab)
    .map((v) => pqInverseEotfNits(Math.max(0, v) * 203)) as [number, number, number];

  let prevLab: Lab | null = null;
  let stableMax = 0;
  let cutMax = 0;
  for (let f = 0; f < 200; f++) {
    const isB = f >= 100;
    const jitter = 1 + Math.sin(f * 1.7) * 0.012 + Math.sin(f * 0.43) * 0.006;
    const base = isB
      ? { black: 1.2 * jitter, shadow: 4 * jitter, mid: 9 * jitter, p95: 220 * jitter, white: 2600 * jitter, high: 5000 }
      : {
          black: PORTRAIT_ANCHORS.black * jitter,
          shadow: PORTRAIT_ANCHORS.shadow * jitter,
          mid: PORTRAIT_ANCHORS.mid * jitter,
          p95: PORTRAIT_ANCHORS.p95 * jitter,
          white: PORTRAIT_ANCHORS.white * jitter,
          high: PORTRAIT_ANCHORS.high,
        };
    const scene = smoother.update(statsLike(base, isB ? histB : histA), params, 1 / 30);
    const ctx: PipelineContext = {
      transfer: 'pq', params, curve: buildCurve(scene, params), whiteNit: 203,
    };
    const lab = processPixel(code, ctx).labOut;
    if (prevLab) {
      const de = deltaE00(prevLab, lab);
      if (f < 100) stableMax = Math.max(stableMax, de);
      if (f >= 100 && f < 130) cutMax = Math.max(cutMax, de);
    }
    prevLab = lab;
  }
  const settled = { black: 1.2, shadow: 4, mid: 9, p95: 220, white: 2600, high: 5000, cut: false, cutSettle: 1 };
  const settledCtx: PipelineContext = {
    transfer: 'pq', params, curve: buildCurve(settled, params), whiteNit: 203,
  };
  return {
    stableMaxDE: stableMax,
    cutMaxDE: cutMax,
    convergenceResidualDE: deltaE00(prevLab!, processPixel(code, settledCtx).labOut),
  };
}

export function runColorSuite(): ColorSuite {
  const primary = runSkin(ctxFor());

  const anchors: Record<string, typeof PORTRAIT_ANCHORS> = {
    portrait: PORTRAIT_ANCHORS,
    neonNight: { black: 0.8, shadow: 3.5, mid: 9, p95: 260, white: 2600, high: 6000 },
    snow: { black: 20, shadow: 90, mid: 480, p95: 760, white: 1100, high: 1600 },
  };
  const sceneBattery = Object.entries(anchors).map(([scene, a]) => {
    const params = { ...DEFAULT_PARAMS };
    const r = runSkin({
      transfer: 'pq', params,
      curve: buildCurve({ ...a, cut: false, cutSettle: 1 }, params),
      whiteNit: params.diffuseWhiteNits,
    });
    return { scene, mean: r.mean, max: r.max };
  });

  // GPU 8 次二分近似 vs 精确
  const exact = ctxFor();
  const approx = ctxFor({}, 8);
  const gpuDs: number[] = [];
  for (const patch of SKIN_PATCHES) {
    const lin = labToBt2020Linear(patch.lab);
    const nits = lin.map((v) => Math.max(0, v) * 203) as [number, number, number];
    const code = nits.map(pqInverseEotfNits) as [number, number, number];
    gpuDs.push(deltaE00(processPixel(code, exact).labOut, processPixel(code, approx).labOut));
  }

  const temporal = runTemporal();
  const pass = primary.mean <= 3 && temporal.stableMaxDE <= 1.5 && temporal.cutMaxDE <= 2.5;

  return {
    patchCount: SKIN_PATCHES.length,
    mean: primary.mean,
    max: primary.max,
    p95: primary.p95,
    rows: primary.rows,
    sceneBattery,
    gpuApprox: { mean: gpuDs.reduce((s, v) => s + v, 0) / gpuDs.length, max: Math.max(...gpuDs) },
    temporal,
    pass,
  };
}

/** HLG 链路自检（供 bench 页/报告使用） */
export function hlgSelfCheck(): number {
  const params = { ...DEFAULT_PARAMS };
  const ctx: PipelineContext = {
    transfer: 'hlg', params,
    curve: buildCurve({ ...PORTRAIT_ANCHORS, cut: false, cutSettle: 1 }, params),
    whiteNit: 203, chromaIters: 8,
  };
  const ds: number[] = [];
  for (const patch of SKIN_PATCHES) {
    const lin = labToBt2020Linear(patch.lab).map((v) => Math.max(0, Math.min(1, v))) as [number, number, number];
    const code = lin.map(hlgOetf) as [number, number, number];
    const a = processPixel(code, { ...ctx, chromaIters: undefined });
    const b = processPixel(code, ctx);
    ds.push(deltaE00(a.labOut, b.labOut));
  }
  return ds.reduce((s, v) => s + v, 0) / ds.length;
}
