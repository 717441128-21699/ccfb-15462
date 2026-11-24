/**
 * color.ts — 色彩科学单一事实来源
 *
 * 浏览器渲染管线的 CPU 参考实现与 Node 验收脚本共用本文件：
 *  - SMPTE ST 2084 (PQ) EOTF / 逆 EOTF
 *  - ITU-R BT.2100 HLG OETF 逆函数 + OOTF
 *  - BT.2020 / BT.709 / XYZ(D65) / CIE Lab 矩阵
 *  - CIEDE2000 色差
 *
 * GLSL 片元着色器里有逐行对应的实现，改动时两边一起改，
 * 并由 bench 的 GPU↔CPU 一致性测试兜底。
 */

export type RGB = [number, number, number];
export type Lab = { L: number; a: number; b: number };

/* ------------------------------------------------------------------ */
/* 矩阵（D65）                                                         */
/* ------------------------------------------------------------------ */

/** BT.2020 线性 RGB -> XYZ */
export const M_2020_TO_XYZ: number[][] = [
  [0.6369580483012914, 0.14461690358620832, 0.16888097516416947],
  [0.2627002120112671, 0.6779980715188708, 0.05930171646986196],
  [0.0, 0.028072693049087428, 1.0609850577107909],
];

/** XYZ -> BT.2020 线性 RGB */
export const M_XYZ_TO_2020: number[][] = [
  [1.716651187971268, -0.355670783776392, -0.25336628137366],
  [-0.666684351832489, 1.616481236634939, 0.0157685458139111],
  [0.017639857445311, -0.042770613257809, 0.942103121235474],
];

/** XYZ -> BT.709 线性 RGB */
export const M_XYZ_TO_709: number[][] = [
  [3.2409699419045226, -1.537383177570094, -0.4986107602930033],
  [-0.9692436362808795, 1.8759675015077202, 0.0415550574071756],
  [0.0556300796969937, -0.2039769588889756, 1.0569715142428786],
];

/** BT.709 线性 RGB -> XYZ */
export const M_709_TO_XYZ: number[][] = [
  [0.4123907992659595, 0.357584339383878, 0.1804807884018343],
  [0.2126390058715104, 0.715168678767756, 0.0721923153607337],
  [0.0193308187155918, 0.119194779794626, 0.9505321522496607],
];

export const COEF_2020: RGB = [0.2627, 0.678, 0.0593];
export const COEF_709: RGB = [0.2126, 0.7152, 0.0722];

/** D65 白点 */
export const D65 = { X: 0.9504559270516716, Y: 1.0, Z: 1.0890577507598784 };

export function matMul(m: number[][], v: RGB): RGB {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

/* ------------------------------------------------------------------ */
/* PQ SMPTE ST 2084                                                    */
/* ------------------------------------------------------------------ */

export const PQ = {
  m1: 2610 / 16384, // 0.1593017578125
  m2: (2523 / 4096) * 128, // 78.84375
  c1: 3424 / 4096, // 0.8359375
  c2: (2413 / 4096) * 32, // 18.8515625
  c3: (2392 / 4096) * 32, // 18.6875
};

/** PQ EOTF：信号码值 N[0,1] -> 线性光 [0,1]（1 = 10000 nit） */
export function pqEotf(n: number): number {
  const N = Math.min(1, Math.max(0, n));
  const np = Math.pow(N, 1 / PQ.m2);
  const L = Math.pow(
    Math.max(np - PQ.c1, 0) / (PQ.c2 - PQ.c3 * np),
    1 / PQ.m1,
  );
  return L;
}

/** PQ EOTF，直接返回 nit */
export function pqEotfNits(n: number): number {
  return pqEotf(n) * 10000;
}

/** PQ 逆 EOTF：nit -> 信号码值 [0,1] */
export function pqInverseEotfNits(nits: number): number {
  const y = Math.max(0, nits) / 10000;
  const ym = Math.pow(y, PQ.m1);
  return Math.pow((PQ.c1 + PQ.c2 * ym) / (1 + PQ.c3 * ym), PQ.m2);
}

/* ------------------------------------------------------------------ */
/* HLG BT.2100                                                         */
/* ------------------------------------------------------------------ */

export const HLG = {
  a: 0.17883277,
  b: 1 - 4 * 0.17883277, // 0.28466892
  c: 0.5 - 0.17883277 * Math.log(4 * 0.17883277), // 0.55991073
};

/** HLG 逆 OETF：信号 E'[0,1] -> 场景线性 E[0,1] */
export function hlgInverseOetf(ep: number): number {
  const x = Math.min(1, Math.max(0, ep));
  if (x <= 0.5) return (x * x) / 3;
  return (Math.exp((x - HLG.c) / HLG.a) + HLG.b) / 12;
}

/** HLG OETF：场景线性 E[0,1] -> 信号 E'[0,1]（生成测试片用） */
export function hlgOetf(e: number): number {
  const x = Math.max(0, e);
  if (x <= 1 / 12) return Math.sqrt(3 * x);
  return HLG.a * Math.log(12 * x - HLG.b) + HLG.c;
}

/**
 * HLG OOTF：场景线性 RGB -> 显示线性（相对峰值归一化）。
 * gamma 按 BT.2100 由显示峰值决定，1000 nit 时为 1.2。
 * 返回值乘以 hlgPeakNits 即 nit。
 */
export function hlgOotf(rgb: RGB, gamma = 1.2): RGB {
  const ys = COEF_2020[0] * rgb[0] + COEF_2020[1] * rgb[1] + COEF_2020[2] * rgb[2];
  const k = Math.pow(Math.max(ys, 0), gamma - 1);
  return [k * rgb[0], k * rgb[1], k * rgb[2]];
}

/* ------------------------------------------------------------------ */
/* sRGB / BT.709 传递函数（输出编码用 sRGB 分段，和 709 OETF 近似）      */
/* ------------------------------------------------------------------ */

export function srgbEncode(c: number): number {
  const x = Math.min(1, Math.max(0, c));
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

export function srgbDecode(c: number): number {
  const x = Math.min(1, Math.max(0, c));
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

/* ------------------------------------------------------------------ */
/* XYZ <-> Lab (D65)                                                   */
/* ------------------------------------------------------------------ */

function labF(t: number): number {
  const d = 6 / 29;
  return t > d * d * d ? Math.cbrt(t) : t / (3 * d * d) + 4 / 29;
}

function labFInv(t: number): number {
  const d = 6 / 29;
  return t > d ? t * t * t : 3 * d * d * (t - 4 / 29);
}

export function xyzToLab(xyz: RGB): Lab {
  const x = labF(xyz[0] / D65.X);
  const y = labF(xyz[1] / D65.Y);
  const z = labF(xyz[2] / D65.Z);
  return { L: 116 * y - 16, a: 500 * (x - y), b: 200 * (y - z) };
}

export function labToXyz(lab: Lab): RGB {
  const fy = (lab.L + 16) / 116;
  const fx = lab.a / 500 + fy;
  const fz = fy - lab.b / 200;
  return [
    D65.X * labFInv(fx),
    D65.Y * labFInv(fy),
    D65.Z * labFInv(fz),
  ];
}

export function bt2020ToLab(rgb2020Linear: RGB): Lab {
  return xyzToLab(matMul(M_2020_TO_XYZ, rgb2020Linear));
}

export function labToBt709Linear(lab: Lab): RGB {
  const xyz = labToXyz(lab);
  return matMul(M_XYZ_TO_709, xyz);
}

export function bt709LinearToLab(rgb709Linear: RGB): Lab {
  return xyzToLab(matMul(M_709_TO_XYZ, rgb709Linear));
}

/* ------------------------------------------------------------------ */
/* CIEDE2000                                                           */
/* ------------------------------------------------------------------ */

/**
 * CIEDE2000 色差（Sharma 2005 修正版）。
 * kL=kC=kH=1 对应参考条件。
 */
export function deltaE00(l1: Lab, l2: Lab, kL = 1, kC = 1, kH = 1): number {
  const rad = Math.PI / 180;
  const deg = 180 / Math.PI;

  const C1 = Math.hypot(l1.a, l1.b);
  const C2 = Math.hypot(l2.a, l2.b);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 6103515625))); // 25^7

  const a1p = (1 + G) * l1.a;
  const a2p = (1 + G) * l2.a;
  const C1p = Math.hypot(a1p, l1.b);
  const C2p = Math.hypot(a2p, l2.b);

  let h1p = C1p === 0 ? 0 : Math.atan2(l1.b, a1p) * deg;
  let h2p = C2p === 0 ? 0 : Math.atan2(l2.b, a2p) * deg;
  if (h1p < 0) h1p += 360;
  if (h2p < 0) h2p += 360;

  const dLp = l2.L - l1.L;
  const dCp = C2p - C1p;

  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);

  const Lbarp = (l1.L + l2.L) / 2;
  const Cbarp = (C1p + C2p) / 2;

  let hbarp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) {
      if (hbarp < 360) hbarp += 360;
      else hbarp -= 360;
    } else {
      hbarp /= 2;
    }
  } else {
    hbarp = h1p + h2p;
  }

  const T =
    1 -
    0.17 * Math.cos((hbarp - 30) * rad) +
    0.24 * Math.cos(2 * hbarp * rad) +
    0.32 * Math.cos((3 * hbarp + 6) * rad) -
    0.2 * Math.cos((4 * hbarp - 63) * rad);

  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
  const Cbarp7 = Math.pow(Cbarp, 7);
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + 6103515625));
  const SL =
    1 + (0.015 * (Lbarp - 50) * (Lbarp - 50)) / Math.sqrt(20 + (Lbarp - 50) * (Lbarp - 50));
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(2 * dTheta * rad) * RC;

  const termL = dLp / (kL * SL);
  const termC = dCp / (kC * SC);
  const termH = dHp / (kH * SH);
  return Math.sqrt(
    termL * termL + termC * termC + termH * termH + RT * termC * termH,
  );
}

/* ------------------------------------------------------------------ */
/* 色域压缩：Lab 恒色相/恒明度向 BT.709 边界收缩                         */
/* ------------------------------------------------------------------ */

/** 判断线性 BT.709 RGB 是否在 [0,1] 色域内（带极小容差） */
export function isInside709(rgb: RGB, eps = 1e-5): boolean {
  return rgb[0] >= -eps && rgb[0] <= 1 + eps &&
    rgb[1] >= -eps && rgb[1] <= 1 + eps &&
    rgb[2] >= -eps && rgb[2] <= 1 + eps;
}

/**
 * 求给定 Lab（L、h 不变）下，a/b 色度缩放到恰好落入 BT.709 的最大比例。
 * 返回 1 表示原色就在色域内。二分 28 次，作为验收用的“理想基准”。
 */
export function maxChromaScaleFor709(lab: Lab): number {
  if (isInside709(labToBt709Linear(lab))) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    const trial: Lab = { L: lab.L, a: lab.a * mid, b: lab.b * mid };
    if (isInside709(labToBt709Linear(trial), 1e-7)) lo = mid;
    else hi = mid;
  }
  return lo;
}
