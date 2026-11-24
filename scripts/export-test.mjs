/** 导出冒烟：批量抽屉 -> 仅第一项 -> PNG -> 校验下载文件 */
import puppeteer from 'puppeteer-core';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve('reports/download-test');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const b = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--use-angle=d3d11'],
});
const p = await b.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
const cdp = await p.createCDPSession();
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true });

await p.goto('http://127.0.0.1:47831/index.html', { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 5000));
await p.click('#btn-batch');
await new Promise((r) => setTimeout(r, 500));
// 只保留第一个勾选
await p.$$eval('.batch-item input[type=checkbox]', (boxes) => {
  boxes.forEach((cb, i) => { if (cb.checked && i !== 0) cb.click(); });
});
await p.select('#export-format', 'png');
await p.click('#btn-start-batch');

let ok = false;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const txt = await p.$eval('.batch-item .batch-status', (el) => el.textContent).catch(() => '');
  if (/已导出 PNG/.test(txt)) { ok = true; break; }
  if (/失败/.test(txt)) { console.log('status:', txt); break; }
}
await new Promise((r) => setTimeout(r, 1500));
const files = readdirSync(dir);
console.log('png status ok =', ok, '| downloaded files =', files);
console.log('page errors =', errors.length ? errors : 'none');
await p.screenshot({ path: 'reports/ui-export-done.png' });
await b.close();
process.exit(ok && files.some((f) => f.endsWith('.png')) ? 0 : 1);
