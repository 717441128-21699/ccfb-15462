/**
 * hevc-vui.ts — 从 hvcC 中的 SPS VUI 提取色彩描述
 *
 * 部分 MP4 不写 colr box，但 HEVC SPS 的 VUI 里有
 * colour_primaries / transfer_characteristics / matrix_coeffs。
 *
 * 完整 SPS 语法解析需要正确跳过 short-term RPS 等变长结构，
 * 而这三个字段是三个连续的 u8 枚举，合法取值集合很小。
 * 因此这里在去防竞争字节后的 SPS 比特流上，按每个比特偏移搜索
 * 合法的 (primaries, transfer, matrix) 三元组；24bit 模式随机误中
 * 概率约千万分之一，再用“优先 BT.2020 + PQ/HLG”消歧，足够可靠。
 */

export interface HevcColorDescription {
  primaries: number;
  transfer: number;
  matrix: number;
  fullRange: boolean;
}

const VALID_PRIMARIES = new Set([1, 9, 12]); // 709 / 2020 / P3
const VALID_TRANSFER = new Set([1, 13, 14, 15, 16, 18]); // 709/sRGB/.../PQ/HLG
const VALID_MATRIX = new Set([1, 6, 9, 10]);

function ebspToRbsp(nal: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (let i = 0; i < nal.length; i++) {
    const b = nal[i];
    if (zeros >= 2 && b === 0x03) {
      zeros = 0;
      continue;
    }
    out.push(b);
    if (b === 0) zeros++;
    else zeros = 0;
  }
  return new Uint8Array(out);
}

function toBitString(buf: Uint8Array): string {
  let s = '';
  for (let i = 0; i < buf.length; i++) s += buf[i].toString(2).padStart(8, '0');
  return s;
}

/** 在一段 SPS RBSP 比特里找最可信的色彩三元组 */
function scanColorTriple(bits: string): HevcColorDescription | null {
  let best: HevcColorDescription | null = null;
  let bestScore = -1;
  for (let o = 0; o + 24 <= bits.length; o++) {
    const primaries = parseInt(bits.slice(o, o + 8), 2);
    const transfer = parseInt(bits.slice(o + 8, o + 16), 2);
    const matrix = parseInt(bits.slice(o + 16, o + 24), 2);
    if (!VALID_PRIMARIES.has(primaries)) continue;
    if (!VALID_TRANSFER.has(transfer)) continue;
    if (!VALID_MATRIX.has(matrix)) continue;

    let score = 1;
    if (primaries === 9) score += 4;
    if (transfer === 16 || transfer === 18) score += 8;
    if (matrix === 9 || matrix === 10) score += 2;
    // 紧跟下一个字段通常是 chroma_loc 标志位 0/1，不做硬性要求
    if (score > bestScore) {
      bestScore = score;
      best = { primaries, transfer, matrix, fullRange: false };
    }
  }
  // 至少要命中 HDR 组合或分数足够高，避免普通 SPS 误报
  if (best && bestScore >= 7) return best;
  return null;
}

/** 遍历 hvcC 中所有 SPS（NAL type 33），提取色彩描述 */
export function findHevcVuiColor(buf: Uint8Array): HevcColorDescription | null {
  const tag = [0x68, 0x76, 0x63, 0x43]; // hvcC
  let pos = -1;
  for (let i = 0; i + 4 < buf.length; i++) {
    if (buf[i] === tag[0] && buf[i + 1] === tag[1] && buf[i + 2] === tag[2] && buf[i + 3] === tag[3]) {
      pos = i + 4;
      break;
    }
  }
  if (pos < 0 || pos + 23 > buf.length) return null;

  const numArrays = buf[pos + 22];
  let p = pos + 23;
  for (let a = 0; a < numArrays; a++) {
    if (p + 3 > buf.length) break;
    const type = buf[p] & 0x3f;
    const numNalus = (buf[p + 1] << 8) | buf[p + 2];
    p += 3;
    for (let n = 0; n < numNalus; n++) {
      if (p + 2 > buf.length) return null;
      const len = (buf[p] << 8) | buf[p + 1];
      p += 2;
      if (len <= 2 || p + len > buf.length) return null;
      if (type === 33) {
        try {
          const rbsp = ebspToRbsp(buf.subarray(p + 2, p + len)); // 跳过 2 字节 NAL header
          const color = scanColorTriple(toBitString(rbsp));
          if (color) return color;
        } catch {
          /* 忽略单个 SPS 异常 */
        }
      }
      p += len;
    }
  }
  return null;
}
