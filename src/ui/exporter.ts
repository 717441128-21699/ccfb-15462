/** exporter.ts — 批量转出 SDR BT.709（WebM 视频 / PNG 帧） */

import { HDRRenderer } from '../gl/renderer';
import { ToneSmoother } from '../core/stats';
import type { ToneParams } from '../core/params';
import { type Material, resolveTransfer } from './materials';
import { h, downloadBlob } from './dom';

type ExportFormat = 'webm-vp9' | 'webm-vp8' | 'png';

interface QueueItem {
  mat: Material;
  checked: boolean;
  el?: HTMLElement;
  bar?: HTMLElement;
  status?: HTMLElement;
  resultUrl?: string;
  resultName?: string;
}

const GPU_CLIP_SECONDS = 5;

export class BatchExporter {
  private items: QueueItem[] = [];
  private running = false;

  constructor(
    private listEl: HTMLElement,
    private btnStart: HTMLButtonElement,
    private resSel: HTMLSelectElement,
    private fpsSel: HTMLSelectElement,
    private fmtSel: HTMLSelectElement,
    private params: ToneParams,
    private onCountChange: (n: number) => void,
  ) {
    btnStart.addEventListener('click', () => void this.start());
  }

  setMaterials(mats: Material[]): void {
    this.items = mats.map((mat) => ({ mat, checked: true }));
    this.renderList();
    this.onCountChange(this.items.length);
  }

  private renderList(): void {
    this.listEl.innerHTML = '';
    for (const item of this.items) {
      const check = h('input', { type: 'checkbox' }) as HTMLInputElement;
      check.checked = item.checked;
      check.addEventListener('change', () => { item.checked = check.checked; });
      const name = h('div', { class: 'name' }, item.mat.name);
      const bar = h('i', {});
      const track = h('div', { class: 'progress' }, bar);
      const status = h('div', { class: 'batch-status' }, '等待');
      const row = h('div', { class: 'batch-row' }, check, name);
      const card = h('div', { class: 'batch-item' }, row, track, status);
      item.el = card;
      item.bar = bar;
      item.status = status;
      this.listEl.appendChild(card);
    }
  }

  private updateCount(): void {
    this.onCountChange(this.items.filter((i) => i.checked).length);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.btnStart.disabled = true;
    const fmt = this.fmtSel.value as ExportFormat;
    for (const item of this.items) {
      if (!item.checked) continue;
      try {
        if (fmt === 'png') await this.exportPng(item);
        else await this.exportVideo(item, fmt);
      } catch (e) {
        this.setStatus(item, `失败：${(e as Error).message}`, 'error');
      }
    }
    this.running = false;
    this.btnStart.disabled = false;
  }

  private setProgress(item: QueueItem, p: number, text?: string): void {
    if (item.bar) item.bar.style.width = `${Math.round(p * 100)}%`;
    if (text && item.status) item.status.textContent = text;
  }
  private setStatus(item: QueueItem, text: string, cls = ''): void {
    if (!item.status) return;
    item.status.textContent = text;
    item.status.className = `batch-status ${cls}`;
  }

  private targetSize(mat: Material, vw = 1280, vh = 720): { w: number; h: number } {
    const choice = this.resSel.value;
    let maxW = choice === '1920' ? 1920 : choice === '1280' ? 1280 : 3840;
    let w = mat.width || vw;
    let h = mat.height || vh;
    if (mat.kind === 'gpu') { w = 1920; h = 1080; }
    if (w > maxW) { h = Math.round((h * maxW) / w); w = maxW; }
    if (w > 3840) { h = Math.round((h * 3840) / w); w = 3840; }
    w = Math.max(2, w - (w % 2));
    h = Math.max(2, h - (h % 2));
    return { w, h };
  }

  private makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; renderer: HDRRenderer } {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.style.position = 'fixed';
    canvas.style.left = '-10000px';
    document.body.appendChild(canvas);
    const renderer = new HDRRenderer(canvas);
    return { canvas, renderer };
  }

  private async exportPng(item: QueueItem): Promise<void> {
    this.setProgress(item, 0.1, '渲染代表帧…');
    const size = this.targetSize(item.mat);
    const { canvas, renderer } = this.makeCanvas(size.w, size.h);
    const smoother = new ToneSmoother();
    try {
      if (item.mat.kind === 'gpu') {
        renderer.processFrame({
          source: { kind: 'procedural', sceneId: item.mat.sceneId ?? 0, time: 2.5 },
          params: this.params, smoother, dt: 0.016, view: 'final',
        });
        // 多喂几帧让统计平滑稳定
        for (let i = 0; i < 30; i++) {
          renderer.processFrame({
            source: { kind: 'procedural', sceneId: item.mat.sceneId ?? 0, time: 2.5 + i / 30 },
            params: this.params, smoother, dt: 1 / 30, view: 'final',
          });
        }
      } else {
        const video = await this.openVideo(item.mat.url!);
        const metaW = video.videoWidth;
        const metaH = video.videoHeight;
        const sz = this.targetSize(item.mat, metaW, metaH);
        canvas.width = sz.w; canvas.height = sz.h;
        renderer.resizeCanvas(sz.w, sz.h);
        video.currentTime = Math.min(1, (video.duration || 2) * 0.1);
        await new Promise<void>((res) => {
          video.onseeked = () => res();
          window.setTimeout(res, 3000);
        });
        for (let i = 0; i < 12; i++) {
          renderer.processFrame({
            source: { kind: 'video', video, transfer: resolveTransfer(item.mat) },
            params: this.params, smoother, dt: 1 / 30, view: 'final',
          });
        }
        video.pause();
        video.removeAttribute('src');
      }
      const blob: Blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG 失败'))), 'image/png'));
      const name = `${item.mat.name}-sdr.png`;
      downloadBlob(blob, name);
      this.attachDownload(item, URL.createObjectURL(blob), name);
      this.setProgress(item, 1);
      this.setStatus(item, '已导出 PNG', 'done');
    } finally {
      renderer.dispose();
      canvas.remove();
    }
  }

  private attachDownload(item: QueueItem, url: string, name: string): void {
    item.resultUrl = url;
    item.resultName = name;
    if (item.status) {
      const a = h('a', { class: 'dl-link', href: url, download: name }, `⬇ 重新下载 ${name}`);
      item.status.appendChild(document.createElement('br'));
      item.status.appendChild(a);
    }
  }

  private openVideo(url: string): Promise<HTMLVideoElement> {
    return new Promise((resolve, reject) => {
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.crossOrigin = 'anonymous';
      v.src = url;
      v.onloadedmetadata = () => resolve(v);
      v.onerror = () => reject(new Error('视频解码失败'));
    });
  }

  private pickMime(fmt: ExportFormat): string {
    const candidates = fmt === 'webm-vp8'
      ? ['video/webm;codecs=vp8', 'video/webm']
      : ['video/webm;codecs=vp9', 'video/webm;codecs=vp9,opus', 'video/webm'];
    for (const m of candidates) if (MediaRecorder.isTypeSupported(m)) return m;
    return '';
  }

  private async exportVideo(item: QueueItem, fmt: ExportFormat): Promise<void> {
    const mime = this.pickMime(fmt);
    if (!mime) throw new Error('当前浏览器不支持 WebM 录制');
    const fps = Number(this.fpsSel.value);

    let video: HTMLVideoElement | null = null;
    let duration = GPU_CLIP_SECONDS;
    let size = this.targetSize(item.mat);
    if (item.mat.kind !== 'gpu') {
      video = await this.openVideo(item.mat.url!);
      duration = Number.isFinite(video.duration) ? video.duration : 5;
      size = this.targetSize(item.mat, video.videoWidth, video.videoHeight);
    }

    const { canvas, renderer } = this.makeCanvas(size.w, size.h);
    const smoother = new ToneSmoother();
    const stream = canvas.captureStream(fps);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
    const chunks: BlobPart[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

    const stopped = new Promise<void>((resolve) => { rec.onstop = () => resolve(); });
    rec.start(250);

    await new Promise<void>((resolve, reject) => {
      const startWall = performance.now();
      let raf = 0;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        cancelAnimationFrame(raf);
        resolve();
      };
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        cancelAnimationFrame(raf);
        reject(e);
      };

      if (video) {
        video.currentTime = 0;
        void video.play().catch(fail);
        video.onended = finish;
        video.onerror = () => fail(new Error('播放失败'));
      }

      const draw = () => {
        const elapsed = (performance.now() - startWall) / 1000;
        try {
          if (item.mat.kind === 'gpu') {
            const t = elapsed % GPU_DURATION_LOOP;
            for (let k = 0; k < 1; k++) {
              renderer.processFrame({
                source: { kind: 'procedural', sceneId: item.mat.sceneId ?? 0, time: t },
                params: this.params, smoother, dt: 1 / fps, view: 'final',
              });
            }
            this.setProgress(item, Math.min(0.99, elapsed / GPU_CLIP_SECONDS), `渲染中 ${elapsed.toFixed(1)}s / ${GPU_CLIP_SECONDS}s`);
            if (elapsed >= GPU_CLIP_SECONDS) return finish();
          } else if (video) {
            if (video.readyState >= 2) {
              renderer.processFrame({
                source: { kind: 'video', video, transfer: resolveTransfer(item.mat) },
                params: this.params, smoother, dt: 1 / fps, view: 'final',
              });
            }
            const p = Number.isFinite(video.duration) ? video.currentTime / video.duration : elapsed / duration;
            this.setProgress(item, Math.min(0.99, p), `转出中 ${Math.round(p * 100)}%`);
          }
        } catch (e) {
          fail(e as Error);
          return;
        }
        raf = requestAnimationFrame(draw);
      };
      raf = requestAnimationFrame(draw);
    });

    if (video) {
      video.pause();
      video.removeAttribute('src');
    }
    rec.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());

    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type: mime.split(';')[0] });
    const name = `${item.mat.name}-sdr.${ext}`;
    downloadBlob(blob, name);
    this.attachDownload(item, URL.createObjectURL(blob), name);
    this.setProgress(item, 1);
    this.setStatus(item, `完成 · ${(blob.size / 1024 / 1024).toFixed(1)} MB`, 'done');
    renderer.dispose();
    canvas.remove();
  }
}

const GPU_DURATION_LOOP = 12;
