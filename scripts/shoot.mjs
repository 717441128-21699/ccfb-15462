/** 临时视觉检查：node scripts/shoot.mjs <hash?> <out.png> [waitMs] */
import puppeteer from 'puppeteer-core';
const out = process.argv[2] ?? 'reports/ui-shot.png';
const waitMs = Number(process.argv[3] ?? 6000);
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const b = await puppeteer.launch({
  executablePath: chromePath, headless: true,
  defaultViewport: { width: 1680, height: 980, deviceScaleFactor: 1 },
  args: ['--no-sandbox', '--ignore-gpu-blocklist', '--use-angle=d3d11'],
});
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await p.goto('http://127.0.0.1:47831/index.html', { waitUntil: 'networkidle0', timeout: 60000 });
await new Promise((r) => setTimeout(r, waitMs));
await p.screenshot({ path: out });
// 再截一张切到 neon GPU 源
if (process.argv[4]) {
  const cards = await p.$$('.mat-card');
  // GPU neon 是倒数第 2 张
  const gpuCards = await p.$$('#gpu-source-list .mat-card');
  await gpuCards[1]?.click();
  await new Promise((r) => setTimeout(r, 2500));
  await p.screenshot({ path: process.argv[4] });
}
console.log('errors:', errs.slice(0, 8));
await b.close();
process.exit(0);
