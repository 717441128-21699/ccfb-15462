/**
 * generate-clips.ts — 生成验收用 HDR 测试片段
 *
 * 三种场景：逆光人像 / 夜景霓虹 / 雪地，外加一个硬切镜头合集。
 * 软件渲染线性 BT.2020 nit 缓冲 -> PQ(ST2084) 或 HLG 码值 ->
 * rgb48le raw -> ffmpeg libx265 10bit，标记 BT.2020 + PQ/HLG。
 *
 * 运行：npm run generate:clips
 * 可选：FRAMES=30 npx tsx scripts/generate-clips.ts （快速版）
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pqInverseEotfNits, hlgOetf } from '../src/core/color';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(ROOT, 'public', 'samples');
mkdirSync(OUT_DIR, { recursive: true });

const W = 1280;
const H = 720;
const FPS = 30;
const FRAMES = Number(process.env.FRAMES ?? 60);

/* ---------------- 噪声 / 数学 ---------------- */

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function hash2(x: number, y: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return mix(mix(a, b, u), mix(c, d, u), v);
}
function fbm(x: number, y: number): number {
  let val = 0, amp = 0.5;
  for (let i = 0; i < 4; i++) {
    val += amp * vnoise(x, y);
    x *= 2.03; y *= 2.03; amp *= 0.5;
  }
  return val;
}

type Buf = Float32Array; // W*H*3 nits

function allocBuf(): Buf {
  return new Float32Array(W * H * 3);
}
function setPx(buf: Buf, i: number, r: number, g: number, b: number): void {
  buf[i * 3] = r; buf[i * 3 + 1] = g; buf[i * 3 + 2] = b;
}

/* ---------------- 场景 1：逆光人像 ---------------- */

function renderPortrait(): Buf {
  const buf = allocBuf();
  const ar = W / H;
  for (let y = 0; y < H; y++) {
    // rawvideo 第一行是图像顶部；GL 的 uv.y=0 在底部，这里翻转以对齐着色器构图
    const v = 1 - y / H;
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const px = (u - 0.5) * ar;
      const py = v - 0.5;
      const i = y * W + x;

      // 天空
      const g = smoothstep(0.15, 0.95, v);
      let r = mix(1.0, 0.35, g), gg = mix(0.72, 0.5, g), b = mix(0.45, 0.85, g);
      let nR = r * mix(900, 260, g), nG = gg * mix(900, 260, g), nB = b * mix(900, 260, g);

      // 太阳 + 光晕
      const sx = u - 0.68, sy = v - 0.62;
      const sd = Math.hypot(sx * ar, sy);
      const halo = Math.exp(-sd * 7) * 1400;
      nR += halo; nG += halo * 0.85; nB += halo * 0.6;
      if (sd < 0.05) { nR += 5000; nG += 4600; nB += 3800; }

      // 云
      const cl = fbm(u * 5, v * 9);
      const cloud = smoothstep(0.55, 0.75, cl) * smoothstep(0.35, 0.75, v);
      nR = mix(nR, 1500, cloud * 0.55);
      nG = mix(nG, 1395, cloud * 0.55);
      nB = mix(nB, 1230, cloud * 0.55);

      // 头肩
      const dHead = (Math.hypot((px - 0.02) / 0.135, (py - 0.06) / 0.17) - 1) * 0.135;
      const dShoulder = (Math.hypot(px / 0.46, (py + 0.42) / 0.27) - 1) * 0.27;
      const body = Math.min(dHead, dShoulder);
      const mask = smoothstep(0.004, -0.004, body);
      if (mask > 0.001) {
        const fabric = fbm(u * 220, v * 220) * 0.5 + fbm(u * 900, v * 900) * 0.5;
        const folds = 0.5 + 0.5 * Math.sin(u * 90 + fbm(u * 8, v * 8) * 6);
        let cR = mix(0.05, 0.12, fabric) * (7 + 16 * folds);
        let cG = mix(0.06, 0.13, fabric) * (7 + 16 * folds);
        let cB = mix(0.09, 0.18, fabric) * (7 + 16 * folds);
        const headMask = smoothstep(0.004, -0.004, dHead);
        const skinN = 14 + 26 * fbm(u * 60, v * 60);
        cR = mix(cR, 0.35 * skinN, headMask);
        cG = mix(cG, 0.2 * skinN, headMask);
        cB = mix(cB, 0.14 * skinN, headMask);
        // 轮廓光
        const rim = smoothstep(0.012, 0, Math.abs(body)) * smoothstep(-0.2, 0.5, px + 0.15);
        cR += 900 * rim; cG += 702 * rim; cB += 450 * rim;
        nR = mix(nR, cR, mask); nG = mix(nG, cG, mask); nB = mix(nB, cB, mask);
      }
      // 暗角
      const vig = 1 - 0.25 * smoothstep(0.5, 1.1, Math.hypot(px, py));
      setPx(buf, i, nR * vig, nG * vig, nB * vig);
    }
  }
  return buf;
}

/* ---------------- 场景 2：夜景霓虹 ---------------- */

function renderNeon(): Buf {
  const buf = allocBuf();
  const ar = W / H;
  // 预生成楼参数
  const buildings = Array.from({ length: 9 }, (_, i) => ({
    bx: -1.05 + i * 0.26 + 0.06 * hash2(i, 1),
    bw: 0.18 + 0.08 * hash2(i, 2),
    bh: 0.35 + 0.5 * hash2(i, 3),
    seed: hash2(i, 4),
  }));

  for (let y = 0; y < H; y++) {
    const v = 1 - y / H;
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const px = (u - 0.5) * ar;
      const py = v - 0.5;
      const i = y * W + x;

      let nR = mix(0.036, 0.12, v);
      let nG = mix(0.042, 0.15, v);
      let nB = mix(0.09, 0.36, v);

      for (let bi = 0; bi < buildings.length; bi++) {
        const bd = buildings[bi];
        const cx = bd.bx, cy = bd.bh * 0.5 - 0.5;
        const d = (Math.hypot((px - cx) / (bd.bw * 0.5), (py - cy) / (bd.bh * 0.5)) - 1) * Math.min(bd.bw * 0.5, bd.bh * 0.5);
        const bm = smoothstep(0.002, -0.002, d);
        if (bm > 0.001) {
          const tone = 3 + 2 * bd.seed;
          nR = mix(nR, 0.02 * tone, bm * 0.9);
          nG = mix(nG, 0.022 * tone, bm * 0.9);
          nB = mix(nB, 0.045 * tone, bm * 0.9);
          // 窗格
          const wu = (px - cx + bd.bw * 0.5) / bd.bw;
          const wv = (py - cy + bd.bh * 0.5) / bd.bh;
          const gx = wu * 6, gy = wv * 14;
          const fx = gx - Math.floor(gx), fy = gy - Math.floor(gy);
          if (fx > 0.25 && fx < 0.72 && fy > 0.3 && fy < 0.7) {
            const cell = Math.imul(Math.floor(gx) + bi * 57, 73856093) ^ Math.imul(Math.floor(gy), 19349663);
            const h = ((cell >>> 0) % 1000) / 1000;
            if (h > 0.45) {
              const warm = hash2(bi, 9) > 0.5;
              const wr = warm ? 1 : 0.6, wg = warm ? 0.75 : 0.8, wb = warm ? 0.4 : 1;
              nR += wr * 120 * bm; nG += wg * 120 * bm; nB += wb * 120 * bm;
            }
          }
        }
      }

      // 粉色灯管 + halo
      const tubeX = px + 0.42 + 0.05 * Math.sin(py * 6);
      const vMask = smoothstep(-0.5, -0.35, py) * (1 - smoothstep(0.35, 0.45, py));
      const tube1 = smoothstep(0.018, 0, Math.abs(tubeX)) * vMask;
      const glow1 = Math.exp(-Math.abs(px + 0.42) * 18) * smoothstep(-0.5, -0.3, py) * (1 - smoothstep(0.3, 0.5, py));
      nR += 1.0 * tube1 * 4200 + 1.0 * glow1 * 500;
      nG += 0.08 * tube1 * 4200 + 0.08 * glow1 * 500;
      nB += 0.45 * tube1 * 4200 + 0.45 * glow1 * 500;

      // 青色圆环
      const rd = Math.abs(Math.hypot(px - 0.45, py - 0.18) - 0.16);
      const ring = smoothstep(0.02, 0, rd);
      const glow2 = Math.exp(-rd * 10);
      nR += 0.05 * ring * 3600 + 0.05 * glow2 * 420;
      nG += 0.9 * ring * 3600 + 0.9 * glow2 * 420;
      nB += 1.0 * ring * 3600 + 1.0 * glow2 * 420;

      // 湿地反射
      const refl = smoothstep(0.55, 0, v) * smoothstep(0, 0.25, v);
      const streak = fbm(u * 60, v * 8);
      const rf = refl * (0.25 + 0.55 * streak);
      nR += (1.0 * glow1 * 500 + 0.05 * glow2 * 420) * rf * 0.02;
      nG += (0.08 * glow1 * 500 + 0.9 * glow2 * 420) * rf * 0.02;
      nB += (0.45 * glow1 * 500 + 1.0 * glow2 * 420) * rf * 0.02;

      setPx(buf, i, Math.max(0, nR), Math.max(0, nG), Math.max(0, nB));
    }
  }
  return buf;
}

/* ---------------- 场景 3：雪地 ---------------- */

function renderSnow(): Buf {
  const buf = allocBuf();
  const ar = W / H;
  for (let y = 0; y < H; y++) {
    const v = 1 - y / H;
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const px = (u - 0.5) * ar;
      const py = v - 0.5;
      const i = y * W + x;

      let nR = mix(0.72 * 520, 0.35 * 760, smoothstep(0.45, 1, v));
      let nG = mix(0.82 * 520, 0.52 * 760, smoothstep(0.45, 1, v));
      let nB = mix(0.98 * 520, 0.95 * 760, smoothstep(0.45, 1, v));

      // 远山
      const m = 0.42 + 0.08 * fbm(u * 3, 1);
      const mM = smoothstep(m + 0.004, m - 0.004, v);
      nR = mix(nR, 0.82 * 620, mM * 0.8);
      nG = mix(nG, 0.88 * 620, mM * 0.8);
      nB = mix(nB, 0.99 * 620, mM * 0.8);

      // 雪地
      const ground = smoothstep(0.55, 0.45, v);
      const tex = fbm(u * 18, v * 60);
      const shade = 0.92 + 0.08 * fbm(u * 6, v * 30);
      const sR = mix(0.82, 1.0, tex) * 980 * shade;
      const sG = mix(0.88, 0.99, tex) * 980 * shade;
      const sB = mix(1.0, 0.96, tex) * 980 * shade;
      nR = mix(nR, sR, ground);
      nG = mix(nG, sG, ground);
      nB = mix(nB, sB, ground);

      // 深色人物
      const dBody = (Math.hypot(px / 0.16, (py + 0.28) / 0.24) - 1) * 0.16;
      const dHead = (Math.hypot(px / 0.07, (py + 0.02) / 0.085) - 1) * 0.07;
      const fig = Math.min(dBody, dHead);
      const fm = smoothstep(0.004, -0.004, fig);
      if (fm > 0.001) {
        const weave = fbm(u * 260, v * 260);
        const lum = (8 + 14 * fbm(u * 90, v * 90)) * mix(0.6, 1.4, weave);
        nR = mix(nR, 0.06 * lum, fm);
        nG = mix(nG, 0.07 * lum, fm);
        nB = mix(nB, 0.1 * lum, fm);
      }
      setPx(buf, i, nR, nG, nB);
    }
  }
  return buf;
}

/* ---------------- 雪花粒子（逐帧叠加） ---------------- */

interface Flake { x: number; y: number; r: number; sp: number; bright: number }
function makeFlakes(n: number): Flake[] {
  return Array.from({ length: n }, (_, i) => ({
    x: hash2(i, 11), y: hash2(i, 23), r: 1 + hash2(i, 31) * 3.2,
    sp: 0.02 + hash2(i, 47) * 0.06, bright: 700 + hash2(i, 59) * 900,
  }));
}
function drawFlakes(buf: Buf, flakes: Flake[], frame: number): void {
  for (const f of flakes) {
    let fy = (f.y + frame * f.sp) % 1;
    const fx = (f.x + Math.sin(frame * 0.05 + f.x * 20) * 0.012 + 1) % 1;
    const cx = Math.floor(fx * W), cy = Math.floor(fy * H);
    const rad = Math.ceil(f.r * 2);
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        const px = cx + dx, py = cy + dy;
        if (px < 0 || px >= W || py < 0 || py >= H) continue;
        const a = smoothstep(f.r, 0, Math.hypot(dx, dy));
        const idx = py * W + px;
        buf[idx * 3] += f.bright * a;
        buf[idx * 3 + 1] += f.bright * a;
        buf[idx * 3 + 2] += f.bright * a;
      }
    }
  }
}

/* ---------------- 编码 + ffmpeg ---------------- */

function buildPqLut(): Uint16Array {
  const lut = new Uint16Array(65536);
  for (let i = 0; i < 65536; i++) {
    const nits = (i / 65535) * 6000; // 场景最大约 5000
    lut[i] = Math.round(clamp01(pqInverseEotfNits(nits)) * 65535);
  }
  return lut;
}

function nitsToPq16(n: number, lut: Uint16Array): number {
  // LUT 索引按 0..6000nit 线性
  const idx = Math.max(0, Math.min(65535, Math.round((n / 6000) * 65535)));
  return lut[idx];
}

function spawnFfmpeg(rawInput: boolean, outPath: string, transfer: 'pq' | 'hlg') {
  const args = ['-y'];
  if (rawInput) {
    args.push('-f', 'rawvideo', '-pix_fmt', 'rgb48le', '-s', `${W}x${H}`, '-r', String(FPS), '-i', 'pipe:0');
  }
  args.push(
    '-c:v', 'libx265', '-preset', 'medium', '-crf', '17',
    '-pix_fmt', 'yuv420p10le',
  );
  // VUI（比特流内色彩标记，ffprobe/解码器读这个）
  const vui = transfer === 'pq'
    ? 'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:hdr-opt=1:repeat-headers=1:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(40000000,1):max-cll=4000,1200'
    : 'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc';
  args.push('-x265-params', vui);
  args.push(outPath);
  const child = spawn('ffmpeg', args, { stdio: ['pipe', 'inherit', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d.toString(); });
  return {
    child,
    done: new Promise<void>((resolvePromise, reject) => {
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolvePromise();
        else reject(new Error(`ffmpeg 退出码 ${code}: ${err.slice(-1200)}`));
      });
    }),
  };
}

/**
 * 当前 Windows 版 ffmpeg 直接编码时不会把 -color-* 传播给 mp4 muxer 写 colr，
 * 因此编码出带 VUI 的临时文件后，再 -c copy remux 一次并显式写 nclx colr box。
 */
function remuxWithColr(src: string, outPath: string, transfer: 'pq' | 'hlg'): Promise<void> {
  const args = [
    '-y', '-i', src, '-c', 'copy',
    '-color_primaries', 'bt2020',
    '-color_trc', transfer === 'pq' ? 'smpte2084' : 'arib-std-b67',
    '-colorspace', 'bt2020nc',
    '-movflags', '+write_colr+faststart',
    '-tag:v', 'hvc1',
    outPath,
  ];
  const child = spawn('ffmpeg', args, { stdio: ['ignore', 'inherit', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d.toString(); });
  return new Promise((resolvePromise, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`remux 退出码 ${code}: ${err.slice(-1200)}`));
    });
  });
}

async function encodeClip(
  name: string,
  backgrounds: { buf: Buf; flakes?: Flake[] }[],
  transfer: 'pq' | 'hlg',
): Promise<string> {
  const finalPath = resolve(OUT_DIR, name);
  const tmpPath = resolve(OUT_DIR, name.replace(/\.mp4$/, '.vui-tmp.mp4'));
  const { child, done } = spawnFfmpeg(true, tmpPath, transfer);
  const pqLut = buildPqLut();
  const frameBytes = W * H * 6;
  const out = Buffer.alloc(frameBytes);

  for (let f = 0; f < FRAMES; f++) {
    const scene = backgrounds[Math.min(backgrounds.length - 1, Math.floor((f / FRAMES) * backgrounds.length))];
    // cuts：按帧分段（每 1/3 切一次），上面映射已处理；这里直接取 scene
    const work = scene.buf.slice();
    if (scene.flakes) drawFlakes(work, scene.flakes, f);

    for (let p = 0; p < W * H; p++) {
      for (let ch = 0; ch < 3; ch++) {
        const n = work[p * 3 + ch] * (1 + (hash2(p & 8191, f * 7 + ch) - 0.5) * 0.012);
        let code16: number;
        if (transfer === 'pq') {
          code16 = nitsToPq16(n, pqLut);
        } else {
          code16 = Math.round(clamp01(hlgOetf(clamp01(n / 1000))) * 65535);
        }
        out.writeUInt16LE(code16, p * 6 + ch * 2);
      }
    }
    if (!child.stdin.write(out)) {
      await new Promise((r) => child.stdin.once('drain', r));
    }
  }
  child.stdin.end();
  await done;

  await remuxWithColr(tmpPath, finalPath, transfer);
  try { unlinkSync(tmpPath); } catch { /* 忽略清理失败 */ }
  console.log('  ✓', name);
  return finalPath;
}

/* ---------------- 主流程 ---------------- */

async function main(): Promise<void> {
  console.log('渲染场景静态缓冲…');
  const portrait = renderPortrait();
  const neon = renderNeon();
  const snow = renderSnow();
  const snowFlakes = makeFlakes(170);

  console.log(`编码 ${W}x${H}@${FPS} ${FRAMES} 帧片段到`, OUT_DIR);

  await encodeClip('backlit-portrait-pq.mp4', [{ buf: portrait }], 'pq');
  await encodeClip('neon-night-pq.mp4', [{ buf: neon }], 'pq');
  await encodeClip('snow-pq.mp4', [{ buf: snow, flakes: snowFlakes }], 'pq');

  // 硬切合集：直接按帧段选择背景（encodeClip 的 backgrounds 映射是顺序分段）
  await encodeClip('scene-cuts-pq.mp4', [
    { buf: portrait }, { buf: neon }, { buf: snow, flakes: snowFlakes },
  ], 'pq');

  // 一个 HLG 样本用于识别两种传递函数
  await encodeClip('backlit-portrait-hlg.mp4', [{ buf: portrait }], 'hlg');

  const manifest = {
    generatedAt: new Date().toISOString(),
    width: W, height: H, fps: FPS, frames: FRAMES,
    clips: [
      { file: 'backlit-portrait-pq.mp4', scene: 'backlit-portrait', transfer: 'pq', primaries: 'bt2020', title: '逆光人像 · PQ' },
      { file: 'neon-night-pq.mp4', scene: 'neon-night', transfer: 'pq', primaries: 'bt2020', title: '夜景霓虹 · PQ' },
      { file: 'snow-pq.mp4', scene: 'snow', transfer: 'pq', primaries: 'bt2020', title: '雪地 · PQ' },
      { file: 'scene-cuts-pq.mp4', scene: 'cuts', transfer: 'pq', primaries: 'bt2020', title: '三镜硬切合集 · PQ' },
      { file: 'backlit-portrait-hlg.mp4', scene: 'backlit-portrait', transfer: 'hlg', primaries: 'bt2020', title: '逆光人像 · HLG' },
    ],
  };
  writeFileSync(resolve(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('全部测试片段生成完成');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
