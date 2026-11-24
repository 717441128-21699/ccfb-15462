/** acceptance-ui.ts — 右侧“验收指标”面板：ΔE00 套件 + 4K FPS 基准 */

import { h } from './dom';
import { runColorSuite, type ColorSuite } from '../core/acceptance-suite';
import { HDRRenderer } from '../gl/renderer';

export function renderDeResult(host: HTMLElement, s: ColorSuite): void {
  host.innerHTML = '';
  host.appendChild(h('div', { class: `metric-big ${s.mean <= 3 ? 'pass' : 'fail'}` }, s.mean.toFixed(2)));
  host.appendChild(h('div', { class: 'muted small' }, `平均 ΔE00（${s.patchCount} 个肤色片，阈值 ≤ 3）${s.pass ? ' · ✅ 达标' : ' · ❌ 未达标'}`));

  const grid = h('div', { class: 'metric-grid' },
    metric('P95', s.p95.toFixed(2)),
    metric('最大', s.max.toFixed(2)),
    metric('同场景逐帧ΔE', s.temporal.stableMaxDE.toFixed(3)),
    metric('切镜峰值ΔE', s.temporal.cutMaxDE.toFixed(2)),
  );
  host.appendChild(grid);

  host.appendChild(h('div', { class: 'small muted', style: 'margin-top:10px' }, '三种场景锚点：'));
  for (const b of s.sceneBattery) {
    host.appendChild(h('div', { class: 'small' }, `${b.scene}：均值 ${b.mean.toFixed(2)} / 最大 ${b.max.toFixed(2)}`));
  }
  host.appendChild(h('div', { class: 'small muted', style: 'margin-top:6px' },
    `GPU 8 次二分 vs 精确：平均 ${s.gpuApprox.mean.toFixed(3)} ΔE`));

  const bars = h('div', { class: 'de-bars' });
  const maxDe = Math.max(3.2, ...s.rows.map((r) => r.de));
  for (const r of [...s.rows].sort((a, b) => b.de - a.de)) {
    const pct = Math.min(100, (r.de / maxDe) * 100);
    bars.appendChild(h('div', { class: 'de-row' },
      h('span', { title: r.id }, r.id),
      h('div', { class: 'de-track' },
        h('div', { class: `de-fill ${r.de > 3 ? 'warn' : ''}`, style: `width:${pct}%` })),
      h('span', {}, r.de.toFixed(2)),
    ));
  }
  host.appendChild(bars);
}

function metric(k: string, v: string): HTMLElement {
  return h('div', { class: 'metric-cell' },
    h('div', { class: 'k' }, k),
    h('div', { class: 'v' }, v));
}

export interface FpsResultView {
  wallFps: number;
  conversionFps?: number;
  fullFps?: number;
  gpuMs: number | null;
  renderer: string;
  width: number;
  height: number;
  frames: number;
}

export async function runFpsBenchmark(
  onProgress: (done: number, total: number) => void,
): Promise<FpsResultView> {
  // 离屏 canvas，避免扰动预览
  const canvas = document.createElement('canvas');
  canvas.width = 3840;
  canvas.height = 2160;
  canvas.style.position = 'fixed';
  canvas.style.left = '-10000px';
  document.body.appendChild(canvas);
  let renderer: HDRRenderer | null = null;
  try {
    renderer = new HDRRenderer(canvas);
    const r = await renderer.benchmark4k(120, (d) => onProgress(d, 120));
    return { ...r, renderer: renderer.rendererString };
  } finally {
    renderer?.dispose();
    canvas.remove();
  }
}

export function renderFpsResult(host: HTMLElement, r: FpsResultView): void {
  host.innerHTML = '';
  const ok = r.wallFps >= 60;
  host.appendChild(h('div', { class: `metric-big ${ok ? 'pass' : 'fail'}` }, `${r.wallFps.toFixed(0)} fps`));
  host.appendChild(h('div', { class: 'muted small' },
    `${r.width}×${r.height} · ${r.frames} 帧离屏吞吐（阈值 ≥ 60）${ok ? ' · ✅ 达标' : ' · ⚠ 未到 60'}`));
  const grid = h('div', { class: 'metric-grid' },
    metric('转换帧均', `${(1000 / r.wallFps).toFixed(2)} ms`),
    metric('GPU timer', r.gpuMs ? `${r.gpuMs.toFixed(2)} ms` : 'n/a'),
    r.fullFps ? metric('含场景生成', `${r.fullFps.toFixed(0)} fps`) : null,
    r.conversionFps ? metric('转换吞吐', `${r.conversionFps.toFixed(0)} fps`) : null,
  );
  host.appendChild(grid);
  host.appendChild(h('div', { class: 'small muted', style: 'margin-top:8px;word-break:break-all' }, r.renderer));
}
