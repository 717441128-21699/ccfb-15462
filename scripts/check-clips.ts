/**
 * check-clips.ts — 验证生成片段的 PQ/HLG + BT.2020 标记能被解析
 * 也可对任意用户文件运行：npx tsx scripts/check-clips.ts <file.mp4 ...>
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectHdrFromMp4 } from '../src/core/detect';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sampleDir = resolve(__dirname, '..', 'public', 'samples');

const expected: Record<string, { transfer: string }> = {
  'backlit-portrait-pq.mp4': { transfer: 'pq' },
  'neon-night-pq.mp4': { transfer: 'pq' },
  'snow-pq.mp4': { transfer: 'pq' },
  'scene-cuts-pq.mp4': { transfer: 'pq' },
  'backlit-portrait-hlg.mp4': { transfer: 'hlg' },
};

const extra = process.argv.slice(2);
let failures = 0;

for (const [file, exp] of Object.entries(expected)) {
  const p = resolve(sampleDir, file);
  if (!existsSync(p)) {
    console.log(`- 跳过 ${file}（尚未生成）`);
    continue;
  }
  const d = detectHdrFromMp4(readFileSync(p));
  const ok = d.transfer === exp.transfer && d.primaries === 'bt2020';
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${file}: transfer=${d.transfer}, primaries=${d.primaries} | ${d.reason}`);
}

for (const p of extra) {
  if (!existsSync(p)) {
    console.error('文件不存在:', p);
    failures++;
    continue;
  }
  const d = detectHdrFromMp4(readFileSync(p));
  console.log(`• ${p}:`, JSON.stringify({ isHdr: d.isHdr, transfer: d.transfer, primaries: d.primaries, nclx: d.nclx }));
}

if (failures) {
  console.error(`\n${failures} 个片段识别失败`);
  process.exit(1);
}
console.log('\n片段 HDR 标记识别全部正确');
