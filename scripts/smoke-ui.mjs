/**
 * smoke-ui.mjs — 主界面交互冒烟 + 截图（需要先 npm run build 且 preview 在 47831）
 * node scripts/smoke-ui.mjs
 */
import puppeteer from 'puppeteer-core';

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const b = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  defaultViewport: { width: 1680, height: 1000, deviceScaleFactor: 1 },
  args: ['--no-sandbox', '--ignore-gpu-blocklist', '--use-angle=d3d11'],
});
const p = await b.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push('console: ' + m.text()); });

await p.goto('http://127.0.0.1:47831/index.html', { waitUntil: 'networkidle0', timeout: 60000 });
await new Promise((r) => setTimeout(r, 6000));

// 1) 验收标签 -> 运行 ΔE
  await p.evaluate(() => [...document.querySelectorAll('.tab')].find((t) => t.dataset.tab === 'accept')?.click());
  await new Promise((r) => setTimeout(r, 300));
  await p.click('#btn-run-de');
  await p.waitForSelector('#de-result .metric-big', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 600));
  const deText = await p.$eval('#de-result .metric-big', (el) => el.textContent).catch(() => null);
  console.log('UI ΔE big number =', deText);
  await p.screenshot({ path: 'reports/ui-accept.png' });

  // 2) 批量抽屉
  await p.click('#btn-batch');
  await new Promise((r) => setTimeout(r, 700));
  const batchItems = await p.$$eval('.batch-item', (els) => els.length);
  console.log('batch items =', batchItems);
  await p.screenshot({ path: 'reports/ui-batch.png' });
  await p.click('[data-close]');

  // 3) 选第一个内置视频，截最终主界面
  await p.evaluate(() => document.querySelector('#sample-list .mat-card')?.click());
  await new Promise((r) => setTimeout(r, 3500));
  await p.screenshot({ path: 'reports/ui-final.png' });

  console.log('errors =', errors.length ? errors : 'none');
  await b.close();
  process.exit(errors.some((e) => /pageerror|Shader|WebGL/i.test(e)) ? 1 : 0);
