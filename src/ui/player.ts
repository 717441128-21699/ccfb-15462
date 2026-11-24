/** player.ts — 中间预览：渲染循环、video/GPU 源、分屏、传输与 HUD */

import { HDRRenderer, type ViewMode, type BaselineMode } from '../gl/renderer';
import { ToneSmoother } from '../core/stats';
import type { ToneParams } from '../core/params';
import { type Material, resolveTransfer } from './materials';
import { formatTime } from './dom';

const GPU_DURATION = 12;

export class Player {
  readonly renderer: HDRRenderer;
  readonly video: HTMLVideoElement;
  private smoother = new ToneSmoother();
  private mat: Material | null = null;
  private view: ViewMode = 'compare';
  private baseline: BaselineMode = 'hardclip';
  playing = false;
  loop = true;
  private gpuTime = 0;
  private lastT = performance.now();
  private fpsEma = 60;
  private hudTimer = 0;
  private aspect = 16 / 9;
  private raf = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private shell: HTMLElement,
    private frame: HTMLElement,
    private params: ToneParams,
    private els: {
      emptyHint: HTMLElement;
      btnPlay: HTMLButtonElement;
      seek: HTMLInputElement;
      tcCur: HTMLElement;
      tcDur: HTMLElement;
      divider: HTMLElement;
      hudWhite: HTMLElement;
      hudMid: HTMLElement;
      hudCut: HTMLElement;
      hudFps: HTMLElement;
      hudGpu: HTMLElement;
    },
  ) {
    this.renderer = new HDRRenderer(canvas);
    els.hudGpu.textContent = this.renderer.rendererString;
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.preload = 'auto';
    this.video.crossOrigin = 'anonymous';

    this.bindTransport();
    this.bindDivider();
    this.fitStage();
    new ResizeObserver(() => this.fitStage()).observe(shell);

    this.video.addEventListener('loadedmetadata', () => {
      if (this.video.videoWidth) this.aspect = this.video.videoWidth / this.video.videoHeight;
      this.fitStage();
      els.tcDur.textContent = formatTime(this.video.duration);
    });
    this.video.addEventListener('ended', () => {
      if (this.loop) {
        this.video.currentTime = 0;
        void this.video.play().catch(() => {});
      } else {
        this.setPlaying(false);
      }
    });

    const loopFn = () => {
      this.tick();
      this.raf = requestAnimationFrame(loopFn);
    };
    this.raf = requestAnimationFrame(loopFn);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.renderer.dispose();
  }

  setView(v: ViewMode): void {
    this.view = v;
    const showDivider = v === 'compare';
    this.els.divider.style.display = showDivider ? '' : 'none';
    document.querySelectorAll('.side-label').forEach((el) => {
      (el as HTMLElement).style.display = showDivider ? '' : 'none';
    });
  }

  setBaseline(b: BaselineMode): void {
    this.baseline = b;
  }

  load(mat: Material): void {
    this.mat = mat;
    this.smoother.reset();
    this.gpuTime = 0;
    this.els.emptyHint.style.display = 'none';
    this.els.seek.value = '0';
    this.els.tcCur.textContent = '00:00';

    if (mat.kind === 'gpu') {
      this.video.pause();
      this.video.removeAttribute('src');
      this.aspect = 16 / 9;
      this.els.tcDur.textContent = formatTime(GPU_DURATION);
      this.fitStage();
      this.setPlaying(true);
    } else if (mat.url) {
      this.video.src = mat.url;
      this.video.load();
      if (mat.width && mat.height) this.aspect = mat.width / mat.height;
      this.setPlaying(true);
      void this.video.play().catch(() => {
        // 自动播放策略兜底：等待用户点播放
        this.setPlaying(false);
      });
    }
  }

  get current(): Material | null {
    return this.mat;
  }

  /** 当前画面导出 PNG */
  snapshotDataUrl(): string {
    this.renderOne(0.016);
    return this.canvas.toDataURL('image/png');
  }

  private setPlaying(v: boolean): void {
    this.playing = v;
    this.els.btnPlay.textContent = v ? '❚❚' : '▶';
    if (!v && this.mat?.kind !== 'gpu') this.video.pause();
    if (v && this.mat && this.mat.kind !== 'gpu') void this.video.play().catch(() => {});
  }

  togglePlay(): void {
    if (!this.mat) return;
    this.setPlaying(!this.playing);
  }

  private bindTransport(): void {
    this.els.btnPlay.addEventListener('click', () => this.togglePlay());
    this.els.seek.addEventListener('input', () => {
      const ratio = Number(this.els.seek.value) / 1000;
      if (this.mat?.kind === 'gpu') {
        this.gpuTime = ratio * GPU_DURATION;
      } else if (Number.isFinite(this.video.duration)) {
        this.video.currentTime = ratio * this.video.duration;
      }
    });
    this.video.addEventListener('seeked', () => this.smoother.reset());
  }

  private bindDivider(): void {
    const divider = this.els.divider;
    const handle = divider.querySelector('.divider-handle') as HTMLElement;
    let dragging = false;
    const update = (clientX: number) => {
      const rect = this.frame.getBoundingClientRect();
      const r = Math.min(0.985, Math.max(0.015, (clientX - rect.left) / rect.width));
      this.params.split = r;
      divider.style.left = `${r * 100}%`;
    };
    handle.addEventListener('pointerdown', (e) => {
      dragging = true;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (dragging) update(e.clientX);
    });
    const stop = () => { dragging = false; };
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
    // 点击/拖动舞台任意位置也能移动分割线
    this.frame.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('.divider-handle')) return;
      if (this.view !== 'compare') return;
      update(e.clientX);
      const move = (ev: PointerEvent) => update(ev.clientX);
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  /** 按素材宽高比把 frame 放进 shell */
  private fitStage(): void {
    const shellW = this.shell.clientWidth - 4;
    const shellH = this.shell.clientHeight - 4;
    if (shellW <= 0 || shellH <= 0) return;
    let w = shellW;
    let h = w / this.aspect;
    if (h > shellH) {
      h = shellH;
      w = h * this.aspect;
    }
    this.frame.style.width = `${Math.floor(w)}px`;
    this.frame.style.height = `${Math.floor(h)}px`;

    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const bw = Math.min(3840, Math.max(2, Math.floor(w * dpr)));
    const bh = Math.min(2160, Math.max(2, Math.floor(h * dpr)));
    this.renderer.resizeCanvas(bw, bh);
    this.els.divider.style.left = `${this.params.split * 100}%`;
  }

  private tick(): void {
    const now = performance.now();
    let dt = (now - this.lastT) / 1000;
    this.lastT = now;
    dt = Math.min(0.1, Math.max(0.0005, dt));
    this.fpsEma = this.fpsEma * 0.95 + (1 / dt) * 0.05;

    if (this.mat) this.renderOne(dt);

    // HUD ~5Hz
    this.hudTimer += dt;
    if (this.hudTimer > 0.2) {
      this.hudTimer = 0;
      this.els.hudFps.textContent = `${Math.round(this.fpsEma)} fps`;
      this.updateTransportUi();
    }
  }

  private lastScene: { white: number; mid: number; cut: boolean } | null = null;

  private renderOne(dt: number): void {
    const m = this.mat;
    if (!m) return;

    if (m.kind === 'gpu') {
      if (this.playing) {
        this.gpuTime += dt;
        if (this.gpuTime > GPU_DURATION) this.gpuTime -= GPU_DURATION;
      }
      const res = this.renderer.processFrame({
        source: { kind: 'procedural', sceneId: m.sceneId ?? 0, time: this.gpuTime },
        params: this.params, smoother: this.smoother, dt,
        view: this.view, split: this.params.split, baseline: this.baseline,
      });
      this.lastScene = res.scene;
    } else if (this.video.readyState >= 2) {
      const transfer = resolveTransfer(m);
      const res = this.renderer.processFrame({
        source: { kind: 'video', video: this.video, transfer },
        params: this.params, smoother: this.smoother, dt,
        view: this.view, split: this.params.split, baseline: this.baseline,
      });
      this.lastScene = res.scene;
    }

    if (this.lastScene && this.hudTimer === 0) {
      const s = this.lastScene;
      this.els.hudWhite.textContent = `${Math.round(s.white)} nit`;
      this.els.hudMid.textContent = `${Math.round(s.mid)} nit`;
      this.els.hudCut.textContent = s.cut ? '检测到硬切 → 过渡中' : '稳定';
      this.els.hudCut.style.color = s.cut ? 'var(--warn)' : '';
    }
  }

  private updateTransportUi(): void {
    if (this.mat?.kind === 'gpu') {
      this.els.seek.value = String((this.gpuTime / GPU_DURATION) * 1000);
      this.els.tcCur.textContent = formatTime(this.gpuTime);
      this.els.tcDur.textContent = formatTime(GPU_DURATION);
    } else if (this.mat && Number.isFinite(this.video.duration)) {
      this.els.seek.value = String((this.video.currentTime / this.video.duration) * 1000);
      this.els.tcCur.textContent = formatTime(this.video.currentTime);
    }
  }
}
