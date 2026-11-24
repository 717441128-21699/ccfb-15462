/**
 * pipeline-cpu.ts — WebGL2 片元管线的 TypeScript 参考实现
 *
 * 阶段与 shaders.ts 的 tonemap fragment shader 一一对应：
 *   PQ/HLG 解码 -> nit 线性 BT.2020 -> 曝光/场景曲线（亮度比例保持）
 *   -> 高光去饱和 -> XYZ/Lab -> 饱和度 -> 肤色保护
 *   -> 恒明度恒色相 BT.709 色域投影 -> sRGB 编码
 *
 * 验收脚本用它计算 ΔE00；浏览器 bench 用它和 GPU readPixels 做一致性校验。
 */

import {
  type RGB,
  type Lab,
  COEF_2020,
  pqEotfNits,
  hlgInverseOetf,
  hlgOotf,
  matMul,
  M_2020_TO_XYZ,
  M_XYZ_TO_709,
  xyzToLab,
  labToXyz,
  bt709LinearToLab,
  deltaE00,
  maxChromaScaleFor709,
  srgbEncode,
} from './color';
import { type ToneParams, type CurveKnots, evalCurve } from './params';

export type Transfer = 'pq' | 'hlg';

export interface PipelineContext {
  transfer: Transfer;
  params: ToneParams;
  curve: CurveKnots;
  /** 曲线归一化所用的场景白位 nit */
  whiteNit: number;
  hlgPeakNits?: number;
  hlgGamma?: number;
  /** 局部反差模糊亮度（可选，测试中省略 => 0 贡献） */
  blurLumaNormalized?: number;
  /** 色域投影二分迭代次数；省略则用 28 次精确解 */
  chromaIters?: number;
}

export interface PixelResult {
  /** 最终 sRGB 编码浮点 0..1 */
  srgb: RGB;
  /** 量化到 8bit 再解回的 Lab（真实输出色差） */
  labOut: Lab;
  /** 色域压缩前的 Lab */
  labPreGamut: Lab;
  chromaScale: number;
  skinMask: number;
  displayLuma: number;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** 解码码值 -> BT.2020 线性 nit */
export function decodeToNits(code: RGB, transfer: Transfer, hlgPeak = 1000, hlgGamma = 1.2): RGB {
  if (transfer === 'pq') {
    return [pqEotfNits(code[0]), pqEotfNits(code[1]), pqEotfNits(code[2])];
  }
  const e: RGB = [
    hlgInverseOetf(code[0]),
    hlgInverseOetf(code[1]),
    hlgInverseOetf(code[2]),
  ];
  const f = hlgOotf(e, hlgGamma);
  return [f[0] * hlgPeak, f[1] * hlgPeak, f[2] * hlgPeak];
}

/** Lab 肤色楔形遮罩：h≈35..82°, L 30..82, C>6 */
export function skinMaskLab(lab: Lab, skinProtect: number): number {
  if (skinProtect <= 0) return 0;
  const c = Math.hypot(lab.a, lab.b);
  let h = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
  if (h < 0) h += 360;
  const hMask = smoothstep(30, 42, h) * (1 - smoothstep(78, 95, h));
  const lMask = smoothstep(28, 40, lab.L) * (1 - smoothstep(78, 90, lab.L));
  const cMask = smoothstep(6, 14, c);
  return hMask * lMask * cMask * skinProtect;
}

export function processPixel(code: RGB, ctx: PipelineContext): PixelResult {
  const { params: p, curve } = ctx;
  const evGain = Math.pow(2, p.exposureEV);
  const white = Math.max(ctx.whiteNit, 1e-3);

  // 1. 解码到 nit
  const nits = decodeToNits(
    code,
    ctx.transfer,
    ctx.hlgPeakNits ?? 1000,
    ctx.hlgGamma ?? 1.2,
  );

  // 2. 场景亮度 + 比例保持的曲线映射
  const yNit = COEF_2020[0] * nits[0] + COEF_2020[1] * nits[1] + COEF_2020[2] * nits[2];
  const xY = (evGain * yNit) / white;
  let vY = evalCurve(curve, xY);

  // 局部纹理/清晰度（CPU 参考：若给了模糊值则施加，否则 0）
  if (ctx.blurLumaNormalized !== undefined && p.shadowTexture > 0) {
    const shadowMask = 1 - smoothstep(0.35, 0.75, vY);
    vY += p.shadowTexture * 0.22 * shadowMask * (vY - ctx.blurLumaNormalized);
    vY = Math.min(1, Math.max(0, vY));
  }

  const xR = (evGain * nits[0]) / white;
  const xG = (evGain * nits[1]) / white;
  const xB = (evGain * nits[2]) / white;
  const k = vY / Math.max(xY, 1e-6);
  let lin: RGB = [xR * k, xG * k, xB * k];

  // 3. 高光柔和去饱和（云/霓虹边缘），肤色楔形内减弱
  let labTmp = xyzToLab(matMul(M_2020_TO_XYZ, lin));
  const skin = skinMaskLab(labTmp, p.skinProtect);
  const hiMask = smoothstep(0.72, 0.97, vY);
  const desat = hiMask * (0.18 + 0.5 * p.highlightRolloff) * (1 - 0.75 * skin);
  lin = [
    lin[0] + (vY - lin[0]) * desat,
    lin[1] + (vY - lin[1]) * desat,
    lin[2] + (vY - lin[2]) * desat,
  ];

  // 4. 进 Lab，做饱和度
  let lab = xyzToLab(matMul(M_2020_TO_XYZ, lin));
  lab = { L: lab.L, a: lab.a * p.saturation, b: lab.b * p.saturation };

  // 5. 恒 L/h 色度投影到 BT.709 色域边界内
  let sExact: number;
  if (ctx.chromaIters && ctx.chromaIters < 28) {
    // 与 shader 完全相同的固定次数二分 + 0.995 安全系数
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < ctx.chromaIters; i++) {
      const mid = (lo + hi) / 2;
      const trial: Lab = { L: lab.L, a: lab.a * mid, b: lab.b * mid };
      const rgb = matMul(M_XYZ_TO_709, labToXyz(trial));
      const inside =
        rgb[0] >= -1e-4 && rgb[0] <= 1 + 1e-4 &&
        rgb[1] >= -1e-4 && rgb[1] <= 1 + 1e-4 &&
        rgb[2] >= -1e-4 && rgb[2] <= 1 + 1e-4;
      if (inside) lo = mid;
      else hi = mid;
    }
    sExact = lo * 0.995;
  } else {
    sExact = maxChromaScaleFor709(lab);
  }
  // gamutCompress < 1 时向“直接矩阵+截断”风格混合（创作选项），默认 1 为精确投影
  let s = sExact;
  if (p.gamutCompress < 1) {
    // 温和肩部：对强域外颜色再压一点色度，默认参数下该分支权重为 0
    const shoulder = 1 - 0.12 * (1 - p.gamutCompress) * smoothstep(1, 0.55, sExact);
    s = sExact * shoulder;
  }
  const labMapped: Lab = { L: lab.L, a: lab.a * s, b: lab.b * s };

  // 6. 转回 BT.709 线性 -> sRGB 编码 -> 8bit 量化
  const lin709 = matMul(M_XYZ_TO_709, labToXyz(labMapped));
  const enc: RGB = [
    srgbEncode(lin709[0]),
    srgbEncode(lin709[1]),
    srgbEncode(lin709[2]),
  ];
  const q8: RGB = [
    Math.round(Math.min(1, Math.max(0, enc[0])) * 255) / 255,
    Math.round(Math.min(1, Math.max(0, enc[1])) * 255) / 255,
    Math.round(Math.min(1, Math.max(0, enc[2])) * 255) / 255,
  ];
  const labOut = bt709LinearToLab([
    q8[0] <= 0.04045 ? q8[0] / 12.92 : Math.pow((q8[0] + 0.055) / 1.055, 2.4),
    q8[1] <= 0.04045 ? q8[1] / 12.92 : Math.pow((q8[1] + 0.055) / 1.055, 2.4),
    q8[2] <= 0.04045 ? q8[2] / 12.92 : Math.pow((q8[2] + 0.055) / 1.055, 2.4),
  ]);

  return {
    srgb: q8,
    labOut,
    labPreGamut: lab,
    chromaScale: s,
    skinMask: skin,
    displayLuma: vY,
  };
}

/** 便捷：Lab 肤色 -> BT.2020 线性（相对白） */
export function labToBt2020Linear(lab: Lab): RGB {
  return matMul(
    [
      // XYZ -> BT.2020 直接走 color 里的矩阵
      [1.716651187971268, -0.355670783776392, -0.25336628137366],
      [-0.666684351832489, 1.616481236634939, 0.0157685458139111],
      [0.017639857445311, -0.042770613257809, 0.942103121235474],
    ],
    labToXyz(lab),
  );
}

/** 计算一组 patch 的平均/最大 ΔE00 */
export function deltaEReport(
  pairs: { expected: Lab; actual: Lab }[],
): { mean: number; max: number; p95: number; values: number[] } {
  const values = pairs.map((pp) => deltaE00(pp.expected, pp.actual));
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / Math.max(1, values.length);
  const max = values.length ? sorted[sorted.length - 1] : 0;
  const p95 = values.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
  return { mean, max, p95, values };
}
