/** WebM 导出冒烟：只导出最后一个 GPU 源，等待 MediaRecorder 完成并校验文件 */
import puppeteer from 'puppeteer-core';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve('reports/download-webm');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const b = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--use-angle=d3d11', '--enable-gpu'],
});
const p = await b.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
const cdp = await p.createCDPSession();
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true });

await p.goto('http://127.0.0.1:47831/index.html', { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 4000));
await p.click('#btn-batch');
await new Promise((r) => setTimeout(r, 500));
await p.$$eval('.batch-item input[type=checkbox]', (boxes) => {
  boxes.forEach((cb, i) => { if (cb.checked && i !== boxes.length - 1) cb.click(); });
});
await p.select('#export-format', 'webm-vp8');
await p.click('#btn-start-batch');

let state = '';
for (let i = 0; i < 80; i++) {
  await new Promise((r) => setTimeout(r, 500));
  state = await p.$eval('.batch-item .batch-status', (el) => el.textContent).catch(() => '');
  if (/完成|失败/.test(state)) break;
}
await new Promise((r) => setTimeout(r, 1500));
const files = readdirSync(dir);
console.log('final status =', state);
console.log('files =', files);
console.log('errors =', errors.length ? errors.slice(0, 3) : 'none');
await b.close();
const ok = /完成/.test(state) && files.some((f) => /\.webm$/.test(f));
process.exit(ok && errors.length === 0 ? 0 : 1);
