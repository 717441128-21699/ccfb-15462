/**
 * detect.ts — 从 ISO-BMFF（MP4/MOV）容器识别 HDR 元数据
 *
 * 手机 HDR 片段通常在 stsd 的 colr box 里写 nclx：
 *   colour_primaries = 9  (BT.2020)
 *   transfer_characteristics = 16 (PQ / ST 2084) 或 18 (HLG / BT.2100 HLG)
 *   matrix_coefficients = 9/10 (BT.2020 NCL/CL)
 *
 * 纯 TS、无 DOM 依赖，Node 脚本直接拿生成的片段做解析验证。
 */

import { findHevcVuiColor } from './hevc-vui';

export type TransferKind = 'pq' | 'hlg' | 'bt709' | 'unknown';
export type PrimariesKind = 'bt2020' | 'bt709' | 'unknown';

export interface NclxInfo {
  primaries: number;
  transfer: number;
  matrix: number;
  fullRange: boolean;
}

export interface HdrDetection {
  isHdr: boolean;
  transfer: TransferKind;
  primaries: PrimariesKind;
  nclx: NclxInfo | null;
  brands: string[];
  /** 识别依据，给 UI 展示 */
  reason: string;
}

const CONTAINERS = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts', 'dinf', 'mvex', 'moof', 'traf',
]);

interface BoxHeader {
  type: string;
  start: number;
  headerSize: number;
  size: number;
}

function readU32(dv: DataView, o: number): number {
  return dv.getUint32(o, false);
}

function readBoxHeader(buf: Uint8Array, dv: DataView, offset: number, end: number): BoxHeader | null {
  if (offset + 8 > end) return null;
  let size = readU32(dv, offset);
  const type = String.fromCharCode(buf[offset + 4], buf[offset + 5], buf[offset + 6], buf[offset + 7]);
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > end) return null;
    const hi = dv.getUint32(offset + 8, false);
    const lo = dv.getUint32(offset + 12, false);
    size = hi * 2 ** 32 + lo;
    headerSize = 16;
  } else if (size === 0) {
    size = end - offset;
  }
  if (size < headerSize || offset + size > end) {
    // 损坏的 size：把剩余区间交给扫描兜底
    return { type, start: offset, headerSize, size: end - offset };
  }
  return { type, start: offset, headerSize, size };
}

function parseNclx(buf: Uint8Array, colrPayload: number, colrEnd: number): NclxInfo | null {
  // colr payload 起点：[colour_type 4]
  if (colrPayload + 7 > colrEnd) return null;
  const ct = String.fromCharCode(...buf.subarray(colrPayload, colrPayload + 4));
  if (ct !== 'nclx') return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const primaries = dv.getUint16(colrPayload + 4, false);
  const transfer = dv.getUint16(colrPayload + 6, false);
  const matrix = dv.getUint16(colrPayload + 8, false);
  const rangeByte = buf[colrPayload + 10] ?? 0;
  return { primaries, transfer, matrix, fullRange: (rangeByte & 0x80) !== 0 };
}

/** 递归遍历 box，收集所有 colr nclx */
function walk(buf: Uint8Array, start: number, end: number, out: NclxInfo[]): void {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = start;
  while (o + 8 <= end) {
    const box = readBoxHeader(buf, dv, o, end);
    if (!box) break;
    const payload = box.start + box.headerSize;
    const boxEnd = Math.min(end, box.start + box.size);
    if (box.type === 'colr') {
      const n = parseNclx(buf, payload, boxEnd);
      if (n) out.push(n);
    } else if (box.type === 'stsd') {
      // version/flags 4 + entry_count 4
      if (payload + 8 <= boxEnd) {
        const count = dv.getUint32(payload + 4, false);
        let eo = payload + 8;
        for (let i = 0; i < count && eo + 8 <= boxEnd; i++) {
          const entry = readBoxHeader(buf, dv, eo, boxEnd);
          if (!entry) break;
          // SampleEntry(8) + VisualSampleEntry 固定字段(70) => 78
          const childStart = entry.start + entry.headerSize + 70;
          if (childStart < entry.start + entry.size) {
            walk(buf, childStart, Math.min(boxEnd, entry.start + entry.size), out);
          }
          eo = entry.start + entry.size;
          if (entry.size <= 0) break;
        }
      }
    } else if (box.type === 'meta') {
      // meta 后有 4 字节 version/flags
      walk(buf, payload + 4, boxEnd, out);
    } else if (CONTAINERS.has(box.type)) {
      walk(buf, payload, boxEnd, out);
    }
    if (box.size <= 0) break;
    o = box.start + box.size;
  }
}

/** 兜底：直接扫描 `colr nclx` 字节模式 */
function scanNclx(buf: Uint8Array): NclxInfo | null {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i + 11 < buf.length; i++) {
    if (
      buf[i] === 0x63 && buf[i + 1] === 0x6f && buf[i + 2] === 0x6c && buf[i + 3] === 0x72 && // colr
      buf[i + 4] === 0x6e && buf[i + 5] === 0x63 && buf[i + 6] === 0x6c && buf[i + 7] === 0x78 // nclx
    ) {
      return {
        primaries: dv.getUint16(i + 8, false),
        transfer: dv.getUint16(i + 10, false),
        matrix: dv.getUint16(i + 12, false),
        fullRange: (buf[i + 14] & 0x80) !== 0,
      };
    }
  }
  return null;
}

export function detectHdrFromMp4(data: ArrayBuffer | Uint8Array): HdrDetection {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  const brands: string[] = [];
  // ftyp major/compatible brands
  if (buf.length > 12) {
    const size = readU32(dv, 0);
    if (size >= 8 && size <= buf.length) {
      const major = String.fromCharCode(...buf.subarray(8, 12));
      brands.push(major);
      for (let o = 16; o + 4 <= size; o += 4) {
        brands.push(String.fromCharCode(...buf.subarray(o, o + 4)));
      }
    }
  }

  const list: NclxInfo[] = [];
  try {
    walk(buf, 0, buf.length, list);
  } catch {
    /* 解析失败走字节扫描 */
  }
  let nclx: NclxInfo | null = list[0] ?? null;
  let metaSource = 'colr/nclx';
  if (!nclx) nclx = scanNclx(buf);
  if (nclx) metaSource = 'colr/nclx(scan)';
  if (!nclx) {
    // 许多 HEVC 文件只在 SPS VUI 中带色彩描述
    const vui = findHevcVuiColor(buf);
    if (vui) {
      nclx = { primaries: vui.primaries, transfer: vui.transfer, matrix: vui.matrix, fullRange: vui.fullRange };
      metaSource = 'HEVC SPS VUI';
    }
  }

  if (!nclx) {
    return {
      isHdr: false,
      transfer: 'unknown',
      primaries: 'unknown',
      nclx: null,
      brands: brands.filter((b) => /[\x20-\x7e]{4}/.test(b)),
      reason: '未在 MP4 中找到 colr/nclx 或 HEVC VUI 标记，可在右侧手动指定 PQ / HLG',
    };
  }

  const primaries: PrimariesKind =
    nclx.primaries === 9 ? 'bt2020' : nclx.primaries === 1 ? 'bt709' : 'unknown';
  const transfer: TransferKind =
    nclx.transfer === 16 ? 'pq' : nclx.transfer === 18 ? 'hlg' : nclx.transfer === 1 ? 'bt709' : 'unknown';

  const isHdr = primaries === 'bt2020' && (transfer === 'pq' || transfer === 'hlg');
  const reason = isHdr
    ? `${metaSource}: primaries=${nclx.primaries} (BT.2020), transfer=${nclx.transfer} (${transfer === 'pq' ? 'SMPTE 2084 PQ' : 'ARIB STD-B67 HLG'}), matrix=${nclx.matrix}`
    : `${metaSource}: primaries=${nclx.primaries}, transfer=${nclx.transfer}（非典型 HDR 组合，可手动覆盖）`;

  return { isHdr, transfer, primaries, nclx, brands, reason };
}

export const NCLX_TRANSFER_NAME: Record<number, string> = {
  1: 'BT.709',
  13: 'sRGB',
  15: 'BT.2020 PQ?',
  16: 'PQ (ST 2084)',
  18: 'HLG (BT.2100)',
};

export const NCLX_PRIMARIES_NAME: Record<number, string> = {
  1: 'BT.709',
  9: 'BT.2020',
  12: 'P3-D65',
};
