/**
 * bench-browser.mjs — 用系统 Chrome + Puppeteer 跑真实 WebGL2 4K 基准
 *
 * 前置：npm run build（npm run verify 会自动先 build）
 * 产出：reports/fps-benchmark.json / .md / bench-screenshot.png
 * 退出码：色彩达标且 4K >=60fps 时 0，否则 1
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const REPORT = resolve(ROOT, 'reports');
mkdirSync(REPORT, { recursive: true });
const PORT = 47831;
const URL = `http://127.0.0.1:${PORT}/bench.html`;

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p));
}

function waitServer(timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((res, rej) => {
    const tick = () => {
      const req = http.get(`http://127.0.0.1:${PORT}/index.html`, (r) => {
        r.resume();
        if (r.statusCode && r.statusCode < 500) res();
        else retry();
      });
      req.on('error', retry);
      req.setTimeout(1500, () => req.destroy());
      function retry() {
        if (Date.now() - start > timeoutMs) rej(new Error('vite preview 启动超时'));
        else setTimeout(tick, 400);
      }
    };
    tick();
  });
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('未找到系统 Chrome / Edge，可用 CHROME_PATH 指定');
  console.log('使用浏览器：', chromePath);

  const viteBin = resolve(ROOT, 'node_modules/vite/bin/vite.js');
  const server = spawn(process.execPath, [viteBin, 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
  });

  let browser;
  try {
    await waitServer();

    const launch = async (headless) => {
      browser = await puppeteer.launch({
        executablePath: chromePath,
        headless,
        defaultViewport: { width: 1500, height: 1000, deviceScaleFactor: 1 },
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--ignore-gpu-blocklist',
          '--enable-webgl',
          '--use-angle=d3d11',
          '--enable-gpu-rasterization',
          '--window-size=1500,1000',
        ],
      });
      return browser;
    };

    await launch(true);
    let page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push('console: ' + m.text());
    });

    await page.goto(URL, { waitUntil: 'networkidle0', timeout: 60000 });

    const title0 = await page.title();
    if (!/验收基准|BENCH_DONE|BENCH_ERROR/.test(title0)) {
      throw new Error(`端口 ${PORT} 上的页面不是本项目基准页（标题：${title0}），可能端口被占用`);
    }

    // 等 window.__BENCH_RESULT__
    let result = null;
    for (let i = 0; i < 240; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      result = await page.evaluate(() => window.__BENCH_RESULT__ ?? null);
      if (result && result.status) break;
    }
    if (!result) throw new Error('基准在 240s 内未产出结果。浏览器错误：\n' + errors.slice(0, 10).join('\n'));
    if (result.status === 'error') throw new Error('基准页报错：' + result.error);

    // 若 headless 落到 SwiftShader，尝试一次有头模式拿真 GPU 数据
    if (result.softwareRendering) {
      console.log('Headless 使用软件渲染，尝试有头 GPU 运行…');
      await browser.close();
      await launch(false);
      page = await browser.newPage();
      await page.setViewport({ width: 1500, height: 1000 });
      await page.goto(URL, { waitUntil: 'networkidle0', timeout: 60000 });
      result = null;
      for (let i = 0; i < 240; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        result = await page.evaluate(() => window.__BENCH_RESULT__ ?? null);
        if (result && result.status === 'done') break;
      }
      if (!result || result.status !== 'done') throw new Error('有头基准未完成');
    }

    await page.screenshot({ path: resolve(REPORT, 'bench-screenshot.png') }).catch(() => {});

    result.browserErrors = errors.filter((e) => !/favicon|DevTools|SharedArrayBuffer/.test(e)).slice(0, 20);
    writeFileSync(resolve(REPORT, 'fps-benchmark.json'), JSON.stringify(result, null, 2));

    const c = result.color;
    const f = result.fps;
    const md = [
      '# 浏览器真机验收报告',
      '',
      `- 时间：${result.generatedAt}`,
      `- GPU：${result.gpuRenderer}${result.softwareRendering ? '（软件渲染！）' : ''}`,
      `- UA：${result.userAgent}`,
      '',
      '## 肤色 ΔE00',
      `- 平均 **${c.meanDeltaE00.toFixed(3)}**（阈值 ≤3）：${c.pass ? '✅' : '❌'}`,
      `- P95 ${c.p95DeltaE00.toFixed(3)} / 最大 ${c.maxDeltaE00.toFixed(3)}`,
      `- 同场景最大逐帧 ΔE00：${c.temporal.stableMaxDE.toFixed(4)}`,
      `- 切镜后最大逐帧 ΔE00：${c.temporal.cutMaxDE.toFixed(4)}`,
      '',
      '## 4K 吞吐',
      `- **转换通道 ${(f.conversionFps ?? f.wallFps).toFixed(1)} fps**（${f.width}×${f.height}，${f.frames} 帧，阈值 ≥60）：${f.pass ? '✅' : '❌'}`,
      `- 含程序化场景生成全流程：${(f.fullFps ?? 0).toFixed(1)} fps`,
      `- 转换帧均 ${f.frameMs.toFixed(2)}ms；GPU timer ${f.gpuMs ? f.gpuMs.toFixed(2) + 'ms' : 'n/a'}`,
      '',
      result.browserErrors.length ? `## 浏览器错误\n\`\`\`\n${result.browserErrors.join('\n')}\n\`\`\`` : '',
    ].join('\n');
    writeFileSync(resolve(REPORT, 'fps-benchmark.md'), md);
    console.log('\n' + md);

    const ok = c.pass && f.pass && !result.softwareRendering;
    if (!ok) {
      console.error('\n基准指标未全部满足（色彩 pass=%s, fps pass=%s, sw=%s）', c.pass, f.pass, result.softwareRendering);
      process.exitCode = 1;
    } else {
      console.log('\n✅ 浏览器基准全部达标');
    }
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}

main().catch((e) => {
  console.error(e);
  try { server?.kill(); } catch {}
  process.exit(1);
});
