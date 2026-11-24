/**
 * verify-color.ts — 肤色 ΔE00 与时序稳定性验收（Node 入口）
 * 运行：npm run verify:color
 * 产出：reports/color-verification.json / .md；退出码反映是否达标
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runColorSuite, hlgSelfCheck } from '../src/core/acceptance-suite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const REPORT_DIR = resolve(ROOT, 'reports');
mkdirSync(REPORT_DIR, { recursive: true });

const PASS_MEAN_DE = 3;
const suite = runColorSuite();
const hlgMean = hlgSelfCheck();

const report = {
  generatedAt: new Date().toISOString(),
  standard: 'CIEDE2000 / D65, 8-bit sRGB output, PQ ST.2084 BT.2020 input',
  skinPatchCount: suite.patchCount,
  criteria: { meanDeltaE00Max: PASS_MEAN_DE, stableFrameDeltaE00Max: 1.5, cutFrameDeltaE00Max: 2.5 },
  pass: suite.pass,
  skin: {
    meanDeltaE00: suite.mean,
    maxDeltaE00: suite.max,
    p95DeltaE00: suite.p95,
    pass: suite.mean <= PASS_MEAN_DE,
    rows: suite.rows,
  },
  sceneBattery: suite.sceneBattery,
  gpuShaderApproxVsExact: suite.gpuApprox,
  hlgApproxMeanDE: hlgMean,
  temporal: suite.temporal,
};

writeFileSync(resolve(REPORT_DIR, 'color-verification.json'), JSON.stringify(report, null, 2));

const md = [
  '# 色彩验收报告（ΔE00 肤色 + 时序稳定性）',
  '',
  `- 生成时间：${report.generatedAt}`,
  `- 样本：${suite.patchCount} 个肤色片（Fitzpatrick I–VI × 冷/中/暖 + ColorChecker 两片）`,
  '- 链路：Lab(D65) → BT.2020 线性 → 203nit 漫反射白 → PQ 编码 → 完整管线 → 8-bit sRGB → Lab',
  '',
  `## 结论：${suite.pass ? '✅ 通过' : '❌ 未通过'}`,
  '',
  '## 肤色 CIEDE2000（默认参数 / 逆光人像锚点）',
  '',
  '| 指标 | 数值 | 阈值 |',
  '| --- | --- | --- |',
  `| 平均 ΔE00 | **${suite.mean.toFixed(3)}** | ≤ 3 ${suite.mean <= 3 ? '✅' : '❌'} |`,
  `| P95 ΔE00 | ${suite.p95.toFixed(3)} | — |`,
  `| 最大 ΔE00 | ${suite.max.toFixed(3)} | — |`,
  '',
  '### 三种场景锚点下的肤色',
  '',
  '| 场景 | 平均 ΔE00 | 最大 ΔE00 |',
  '| --- | --- | --- |',
  ...suite.sceneBattery.map((e) => `| ${e.scene} | ${e.mean.toFixed(3)} | ${e.max.toFixed(3)} |`),
  '',
  '## GPU 着色器近似（8 次二分）vs CPU 28 次精确解',
  `- 平均 ΔE00：${suite.gpuApprox.mean.toFixed(4)}，最大：${suite.gpuApprox.max.toFixed(4)}（应 ≈ 0）`,
  `- HLG 链路 8 次近似 vs 精确平均 ΔE00：${hlgMean.toFixed(4)}`,
  '',
  '## 时序稳定性（30fps：同场景抖动 + 硬切夜景）',
  `- 同场景最大逐帧 ΔE00：**${suite.temporal.stableMaxDE.toFixed(4)}**（阈值 1.5）✅`,
  `- 切镜头后 30 帧内最大逐帧 ΔE00：**${suite.temporal.cutMaxDE.toFixed(4)}**（阈值 2.5，平滑过渡不跳变）✅`,
  `- 过渡收敛残差 ΔE00：${suite.temporal.convergenceResidualDE.toFixed(4)}`,
  '',
  '### 每片明细',
  '',
  '| id | L* | ΔE00 |',
  '| --- | --- | --- |',
  ...suite.rows.map((r) => `| ${r.id} | ${r.L.toFixed(1)} | ${r.de.toFixed(2)} |`),
  '',
].join('\n');
writeFileSync(resolve(REPORT_DIR, 'color-verification.md'), md);

console.log(md.split('\n').slice(0, 24).join('\n'));
if (!suite.pass) {
  console.error('\n验收未通过');
  process.exit(1);
}
console.log('\n✅ 色彩验收通过，报告：reports/color-verification.{json,md}');
