/** materials.ts — 素材模型、内置片段、上传文件解析与缩略图 */

import { detectHdrFromMp4, type HdrDetection } from '../core/detect';

export type MaterialKind = 'sample' | 'user' | 'gpu';

export interface Material {
  id: string;
  name: string;
  kind: MaterialKind;
  /** 视频 URL（sample / user） */
  url?: string;
  /** GPU 实时场景 id */
  sceneId?: 0 | 1 | 2;
  detection?: HdrDetection | null;
  /** 用户手动覆盖的传递函数 */
  transferOverride: 'auto' | 'pq' | 'hlg' | 'bt709';
  sizeLabel?: string;
  thumb?: string;
  duration?: number;
  width?: number;
  height?: number;
  file?: File;
}

let seq = 0;
export function nextId(prefix = 'm'): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

export interface SampleManifestClip {
  file: string;
  scene: string;
  transfer: 'pq' | 'hlg';
  primaries: string;
  title: string;
}

export async function loadSampleMaterials(): Promise<Material[]> {
  const base = import.meta.env.BASE_URL || './';
  try {
    const res = await fetch(`${base}samples/manifest.json`);
    if (!res.ok) throw new Error(`manifest ${res.status}`);
    const manifest = (await res.json()) as { clips: SampleManifestClip[] };
    const mats: Material[] = [];
    for (const c of manifest.clips) {
      const url = `${base}samples/${c.file}`;
      let detection: HdrDetection | null = null;
      try {
        const res = await fetch(url);
        const blob = await res.blob();
        // faststart 文件头部即含 moov/colr；取前 512KB 足够
        const head = await blob.slice(0, 512 * 1024).arrayBuffer();
        detection = detectHdrFromMp4(head);
        if (!detection.isHdr) {
          const all = await blob.arrayBuffer();
          detection = detectHdrFromMp4(all);
        }
      } catch {
        detection = null;
      }
      mats.push({
        id: nextId('sample'),
        name: c.title,
        kind: 'sample',
        url,
        detection,
        transferOverride: 'auto',
        sizeLabel: '1280×720 · 30fps',
      });
    }
    return mats;
  } catch (e) {
    console.warn('无法加载 samples/manifest.json（先运行 npm run generate:clips）', e);
    return [];
  }
}

/** 读取用户文件头部/尾部识别 HDR 标记 */
export async function detectFileHdr(file: File): Promise<HdrDetection | null> {
  try {
    const headSize = Math.min(512 * 1024, file.size);
    const head = await file.slice(0, headSize).arrayBuffer();
    let d = detectHdrFromMp4(head);
    if (d.isHdr || d.nclx) return d;
    // 非 faststart：moov 在文件尾部
    if (file.size > headSize) {
      const tailSize = Math.min(2 * 1024 * 1024, file.size);
      const tail = await file.slice(file.size - tailSize).arrayBuffer();
      d = detectHdrFromMp4(tail);
    }
    return d;
  } catch {
    return null;
  }
}

export async function fileToMaterial(file: File): Promise<Material> {
  const url = URL.createObjectURL(file);
  const detection = await detectFileHdr(file);
  return {
    id: nextId('user'),
    name: file.name.replace(/\.[^.]+$/, ''),
    kind: 'user',
    url,
    file,
    detection,
    transferOverride: 'auto',
    sizeLabel: formatBytes(file.size),
  };
}

export function formatBytes(n: number): string {
  if (n > 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n > 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/** 用隐藏 video 抓一帧做缩略图，失败返回 undefined */
export function makeThumbnail(url: string, atRatio = 0.12): Promise<{ thumb: string; width: number; height: number; duration: number } | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    let done = false;
    const finish = (v: { thumb: string; width: number; height: number; duration: number } | null) => {
      if (done) return;
      done = true;
      video.removeAttribute('src');
      video.load();
      resolve(v);
    };
    const timer = window.setTimeout(() => finish(null), 9000);
    video.onloadedmetadata = () => {
      const t = Number.isFinite(video.duration) ? Math.min(video.duration * atRatio, video.duration - 0.05) : 0.1;
      video.currentTime = Math.max(0, t);
    };
    video.onseeked = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 168;
        c.height = 94;
        const ctx = c.getContext('2d');
        if (!ctx) return finish(null);
        ctx.drawImage(video, 0, 0, c.width, c.height);
        window.clearTimeout(timer);
        finish({
          thumb: c.toDataURL('image/jpeg', 0.72),
          width: video.videoWidth,
          height: video.videoHeight,
          duration: video.duration,
        });
      } catch {
        window.clearTimeout(timer);
        finish(null);
      }
    };
    video.onerror = () => {
      window.clearTimeout(timer);
      finish(null);
    };
    video.src = url;
  });
}

export const GPU_SOURCES: Material[] = [
  { id: 'gpu-portrait', name: 'GPU · 逆光人像', kind: 'gpu', sceneId: 0, transferOverride: 'auto', sizeLabel: '实时 GLSL · 最高 4K' },
  { id: 'gpu-neon', name: 'GPU · 夜景霓虹', kind: 'gpu', sceneId: 1, transferOverride: 'auto', sizeLabel: '实时 GLSL · 最高 4K' },
  { id: 'gpu-snow', name: 'GPU · 雪地', kind: 'gpu', sceneId: 2, transferOverride: 'auto', sizeLabel: '实时 GLSL · 最高 4K' },
];

/** 决定素材实际使用的传递函数 */
export function resolveTransfer(m: Material): 'pq' | 'hlg' | 'bt709' {
  if (m.transferOverride !== 'auto') return m.transferOverride;
  if (m.kind === 'gpu') return 'pq'; // GPU 源直接输出 nit，decode pass 会被跳过
  const t = m.detection?.transfer;
  if (t === 'hlg') return 'hlg';
  if (t === 'bt709') return 'bt709';
  return 'pq'; // 手机 HDR 短视频绝大多数是 PQ / Dolby Vision profile
}
