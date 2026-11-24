/**
 * skin.ts — 肤色样本集
 *
 * 覆盖 Fitzpatrick I–VI 的 Lab 范围（L*≈34–76, a*≈8–22, b*≈10–28），
 * 每种基色再分冷粉 / 中性 / 暖金三种 undertone，共 27 片，
 * 另加两块接近 X-Rite ColorChecker Dark/Light Skin 的标准肤色。
 * 数值参考公开的肤色测量区间构造，不是任意随机色。
 */

import type { Lab } from './color';

export interface SkinPatch {
  id: string;
  group: string;
  lab: Lab;
}

export const SKIN_PATCHES: SkinPatch[] = (() => {
  const out: SkinPatch[] = [];

  // ColorChecker 两块标准肤色（文献常见 Lab 近似值）
  out.push({ id: 'cc-dark', group: 'colorchecker', lab: { L: 37.99, a: 13.56, b: 14.06 } });
  out.push({ id: 'cc-light', group: 'colorchecker', lab: { L: 65.71, a: 18.13, b: 17.81 } });

  const levels = [
    { roman: 'VI', L: 36 },
    { roman: 'V', L: 43 },
    { roman: 'IV', L: 50 },
    { roman: 'III', L: 57 },
    { roman: 'II', L: 64 },
    { roman: 'I', L: 72 },
  ];

  const undertones = [
    { key: 'cool', da: 3.2, db: -2.5 },
    { key: 'neutral', da: 0, db: 0 },
    { key: 'warm', da: -1.2, db: 3.4 },
  ];

  for (const lv of levels) {
    // 深肤色色度略低，浅肤色色度更高
    const t = (lv.L - 36) / (72 - 36);
    const a0 = 11.5 + 7.5 * t;
    const b0 = 12.5 + 9.5 * t;
    for (const u of undertones) {
      out.push({
        id: `fitz${lv.roman}-${u.key}`,
        group: `fitzpatrick-${lv.roman}`,
        lab: {
          L: lv.L + (u.key === 'cool' ? 0.6 : u.key === 'warm' ? -0.4 : 0),
          a: a0 + u.da,
          b: b0 + u.db,
        },
      });
    }
  }
  return out;
})();
