/** bench.ts — 独立基准页：先验证 shader 可渲染，再跑色彩套件与 4K FPS */

import './styles.css';
import { HDRRenderer } from './gl/renderer';
import { ToneSmoother } from './core/stats';
import { DEFAULT_PARAMS } from './core/params';
import { runColorSuite, hlgSelfCheck } from './core/acceptance-suite';

declare global {
  interface Window {
    __BENCH_RESULT__?: unknown;
  }
}

const logEl = document.getElementById('bench-log')!;
const jsonEl = document.getElementById('bench-json')!;
const canvas = document.getElementById('bench-canvas') as HTMLCanvasElement;

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log('[bench]', msg);
  logEl.textContent += `\n${msg}`;
}

async function main(): Promise<void> {
  log('初始化 WebGL2…');
  const renderer = new HDRRenderer(canvas);
  log(`GPU：${renderer.rendererString}`);
  const isSoftware = /SwiftShader|llvmpipe|Software/i.test(renderer.rendererString);
  if (isSoftware) log('⚠ 当前为软件渲染（GPU 加速未生效），FPS 不代表真机性能');

  // 先渲染 30 帧三个场景，验证所有 shader/FBO 路径正常
  const smoother = new ToneSmoother();
  const params = { ...DEFAULT_PARAMS };
  for (let i = 0; i < 30; i++) {
    renderer.processFrame({
      source: { kind: 'procedural', sceneId: (i % 3) as 0 | 1 | 2, time: i / 30 },
      params, smoother, dt: 1 / 30, view: 'final',
    });
  }
  log('三个场景 × 10 帧试渲染通过');

  log('运行肤色 ΔE00 / 时序套件…');
  const color = runColorSuite();
  const hlg = hlgSelfCheck();
  log(`ΔE00 平均 ${color.mean.toFixed(3)}（阈值 3），同场景峰值 ${color.temporal.stableMaxDE.toFixed(3)}，切镜峰值 ${color.temporal.cutMaxDE.toFixed(3)}`);

  log('运行 4K（3840×2160）120 帧吞吐基准…');
  const fps = await renderer.benchmark4k(120, (d) => {
    if (d % 40 === 0) log(`  …${d}/120`);
  });
  log(`转换吞吐 ${fps.conversionFps.toFixed(1)} fps（帧均 ${(1000 / fps.conversionFps).toFixed(2)}ms）；含程序化场景生成 ${fps.fullFps.toFixed(1)} fps；GPU timer ${fps.gpuMs ? fps.gpuMs.toFixed(2) + 'ms' : 'n/a'}`);

  // 恢复预览尺寸并持续渲染
  renderer.resizeCanvas(1280, 720);
  let f = 0;
  const loop = () => {
    f++;
    renderer.processFrame({
      source: { kind: 'procedural', sceneId: (Math.floor(f / 120) % 3) as 0 | 1 | 2, time: f / 60 },
      params, smoother, dt: 1 / 60, view: 'compare', split: 0.5,
    });
    requestAnimationFrame(loop);
  };
  loop();

  const result = {
    status: 'done',
    generatedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    gpuRenderer: renderer.rendererString,
    softwareRendering: isSoftware,
    color: {
      pass: color.pass,
      patchCount: color.patchCount,
      meanDeltaE00: color.mean,
      maxDeltaE00: color.max,
      p95DeltaE00: color.p95,
      sceneBattery: color.sceneBattery,
      gpuApprox: color.gpuApprox,
      hlgApproxMeanDE: hlg,
      temporal: color.temporal,
    },
    fps: {
      pass: fps.conversionFps >= 60,
      width: fps.width,
      height: fps.height,
      frames: fps.frames,
      wallFps: fps.wallFps,
      conversionFps: fps.conversionFps,
      fullFps: fps.fullFps,
      frameMs: 1000 / fps.conversionFps,
      gpuMs: fps.gpuMs,
    },
  };
  window.__BENCH_RESULT__ = result;
  jsonEl.textContent = JSON.stringify(result, null, 2);
  document.title = 'BENCH_DONE';
  log('完成：' + (color.pass ? '色彩 ✅ ' : '色彩 ❌ ') + (fps.conversionFps >= 60 ? 'FPS ✅' : 'FPS ⚠ (<60)'));
}

main().catch((e) => {
  console.error(e);
  log('失败：' + (e?.stack || e?.message || String(e)));
  window.__BENCH_RESULT__ = { status: 'error', error: String(e?.stack || e) };
  jsonEl.textContent = JSON.stringify(window.__BENCH_RESULT__, null, 2);
  document.title = 'BENCH_ERROR';
});
