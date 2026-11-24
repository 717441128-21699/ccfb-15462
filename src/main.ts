/** main.ts — 应用装配：素材库 / 预览 / 参数 / 验收 / 批量导出 */

import './styles.css';
import { DEFAULT_PARAMS, type ToneParams } from './core/params';
import type { HdrDetection } from './core/detect';
import {
  type Material,
  loadSampleMaterials,
  fileToMaterial,
  makeThumbnail,
  GPU_SOURCES,
} from './ui/materials';
import { buildControls, resetParams } from './ui/controls';
import { Player } from './ui/player';
import { BatchExporter } from './ui/exporter';
import { runColorSuite } from './core/acceptance-suite';
import { renderDeResult, runFpsBenchmark, renderFpsResult } from './ui/acceptance-ui';
import { h, toast } from './ui/dom';

const params: ToneParams = { ...DEFAULT_PARAMS };
let materials: Material[] = [];
let selectedId: string | null = null;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/* ---------------- 素材卡片 ---------------- */

function tag(text: string, cls: string): HTMLElement {
  return h('span', { class: `tag ${cls}` }, text);
}

function detectionTags(m: Material): HTMLElement[] {
  const tags: HTMLElement[] = [];
  if (m.kind === 'gpu') {
    tags.push(tag('GPU 线性 nit', 'tag-gpu'));
    tags.push(tag('BT.2020', 'tag-2020'));
    return tags;
  }
  const d: HdrDetection | null | undefined = m.detection;
  const t = m.transferOverride === 'auto' ? d?.transfer : m.transferOverride;
  if (t === 'pq') tags.push(tag('PQ', 'tag-pq'));
  else if (t === 'hlg') tags.push(tag('HLG', 'tag-hlg'));
  else if (t === 'bt709') tags.push(tag('BT.709', 'tag-709'));
  else tags.push(tag('传递函数未知', 'tag-709'));

  const p = m.transferOverride === 'auto' ? d?.primaries : (m.transferOverride === 'bt709' ? 'bt709' : 'bt2020');
  if (p === 'bt2020') tags.push(tag('BT.2020', 'tag-2020'));
  else if (p === 'bt709') tags.push(tag('BT.709', 'tag-709'));
  return tags;
}

function renderLibrary(): void {
  const sampleList = $('sample-list');
  const userList = $('user-list');
  const gpuList = $('gpu-source-list');
  sampleList.innerHTML = '';
  userList.innerHTML = '';
  gpuList.innerHTML = '';

  const samples = materials.filter((m) => m.kind === 'sample');
  const users = materials.filter((m) => m.kind === 'user');

  for (const m of samples) sampleList.appendChild(matCard(m));
  if (!samples.length) {
    sampleList.appendChild(h('p', { class: 'muted small pad' }, '未找到内置片段，运行 npm run generate:clips'));
  }
  if (!users.length) {
    userList.appendChild(h('p', { class: 'muted small pad' }, '还没有添加文件'));
  }
  for (const m of users) userList.appendChild(matCard(m));
  for (const g of GPU_SOURCES) gpuList.appendChild(matCard(g));

  $('lib-count').textContent = `${materials.length + GPU_SOURCES.length} 项`;
  $('batch-count').textContent = String(materials.length + GPU_SOURCES.length);
}

function matCard(m: Material): HTMLElement {
  const active = m.id === selectedId;
  const gpuGradients = [
    'linear-gradient(160deg,#3a4a8a,#e8915a 70%,#fff2c8)',
    'linear-gradient(160deg,#070a18,#3a1140 55%,#ff2d95,#19e3ff)',
    'linear-gradient(160deg,#8fb4ff,#eef4ff 55%,#2a3550)',
  ];

  let thumbEl: HTMLElement;
  if (m.thumb) {
    thumbEl = h('img', { class: 'mat-thumb', alt: '', src: m.thumb }) as HTMLImageElement;
  } else if (m.kind === 'gpu') {
    thumbEl = h('div', { class: 'mat-thumb', style: `background:${gpuGradients[m.sceneId ?? 0]}` });
  } else {
    thumbEl = h('div', { class: 'mat-thumb mat-thumb-loading' }, '…');
  }

  const meta = h('div', { class: 'mat-meta' },
    h('div', { class: 'mat-name', title: m.name }, m.name),
    h('div', { class: 'mat-sub' }, ...detectionTags(m), m.sizeLabel ? h('span', {}, m.sizeLabel) : null),
  );
  const actions = h('div', { class: 'mat-actions' });
  if (m.kind === 'user') {
    actions.appendChild(h('button', {
      class: 'icon-btn', title: '移除',
      onclick: (e: Event) => {
        e.stopPropagation();
        removeMaterial(m.id);
      },
    }, '🗑'));
  }
  const card = h('div', { class: `mat-card ${active ? 'active' : ''}` }, thumbEl, meta, actions);
  card.addEventListener('click', () => selectMaterial(m.id));
  return card;
}

function removeMaterial(id: string): void {
  const m = materials.find((x) => x.id === id);
  if (m?.url && m.kind === 'user') URL.revokeObjectURL(m.url);
  materials = materials.filter((x) => x.id !== id);
  if (selectedId === id) {
    selectedId = null;
    $('empty-hint').style.display = '';
  }
  renderLibrary();
  exporter.setMaterials([...materials, ...GPU_SOURCES]);
}

/* ---------------- 选择 / 检测面板 ---------------- */

let player: Player;

function selectMaterial(id: string): void {
  const all = [...materials, ...GPU_SOURCES];
  const m = all.find((x) => x.id === id);
  if (!m) return;
  selectedId = id;
  renderLibrary();
  player.load(m);
  updateDetectPanel(m);
}

function updateDetectPanel(m: Material): void {
  const reason = $('detect-reason');
  const sel = $('transfer-override') as HTMLSelectElement;
  sel.value = m.transferOverride;
  if (m.kind === 'gpu') {
    reason.textContent = '实时 GLSL 源：直接输出 BT.2020 线性 nit，等价于 PQ 解码后的光。';
    return;
  }
  reason.textContent = m.detection?.reason ?? '未解析元数据';
}

/* ---------------- 文件导入 ---------------- */

async function handleFiles(files: FileList | File[] | null): Promise<void> {
  if (!files || !files.length) return;
  const videos = [...files].filter((f) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(f.name));
  if (!videos.length) {
    toast('请选择视频文件', 'error');
    return;
  }
  for (const f of videos) {
    const m = await fileToMaterial(f);
    materials.push(m);
    toast(`已添加 ${m.name}：${m.detection?.transfer?.toUpperCase() ?? '未知'} / ${m.detection?.primaries ?? '?'}`, 'ok');
    // 异步缩略图与时长
    if (m.url) {
      void makeThumbnail(m.url).then((info) => {
        if (info) {
          m.thumb = info.thumb;
          m.width = info.width;
          m.height = info.height;
          m.duration = info.duration;
          m.sizeLabel = `${info.width}×${info.height}`;
          renderLibrary();
        }
      });
    }
  }
  renderLibrary();
  exporter.setMaterials([...materials, ...GPU_SOURCES]);
  if (!selectedId && materials.length) selectMaterial(materials[materials.length - 1].id);
}

/* ---------------- 启动 ---------------- */

let exporter: BatchExporter;

function bootstrap(): void {
  const canvas = $('gl-canvas') as HTMLCanvasElement;
  try {
    player = new Player(
      canvas,
      $('canvas-shell'),
      $('stage-frame'),
      params,
      {
        emptyHint: $('empty-hint'),
        btnPlay: $('btn-play') as HTMLButtonElement,
        seek: $('seek') as HTMLInputElement,
        tcCur: $('tc-cur'),
        tcDur: $('tc-dur'),
        divider: $('compare-divider'),
        hudWhite: $('hud-white'),
        hudMid: $('hud-mid'),
        hudCut: $('hud-cut'),
        hudFps: $('hud-fps'),
        hudGpu: $('hud-gpu'),
      },
    );
  } catch (e) {
    const err = $('gl-error');
    err.hidden = false;
    err.textContent = `WebGL2 初始化失败：${(e as Error).message}\n请使用最新版 Chrome / Edge，并确认显卡驱动正常。`;
    throw e;
  }

  buildControls($('param-groups'), params, () => { /* 参数被 player 每帧读取，无需额外动作 */ });
  $('btn-reset').addEventListener('click', () => {
    resetParams(params);
    buildControls($('param-groups'), params, () => {});
    toast('参数已恢复默认', 'ok');
  });

  exporter = new BatchExporter(
    $('batch-list'),
    $('btn-start-batch') as HTMLButtonElement,
    $('export-res') as HTMLSelectElement,
    $('export-fps') as HTMLSelectElement,
    $('export-format') as HTMLSelectElement,
    params,
    (n) => { $('batch-count').textContent = String(n); },
  );

  bindChrome();
  renderLibrary();
  exporter.setMaterials(GPU_SOURCES);

  // 加载内置片段
  void loadSampleMaterials().then((samples) => {
    materials = samples;
    renderLibrary();
    exporter.setMaterials([...materials, ...GPU_SOURCES]);
    if (samples[0]) selectMaterial(samples[0].id);
    // 缩略图异步
    for (const m of samples) {
      if (m.url) void makeThumbnail(m.url).then((info) => {
        if (info) {
          m.thumb = info.thumb;
          m.width = info.width;
          m.height = info.height;
          renderLibrary();
        }
      });
    }
  });
}

function bindChrome(): void {
  const fileInput = $('file-input') as HTMLInputElement;
  $('btn-add').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => void handleFiles(fileInput.files));

  const dz = $('dropzone');
  dz.addEventListener('click', () => fileInput.click());
  ['dragover', 'dragenter'].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.add('drag');
  }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.remove('drag');
  }));
  dz.addEventListener('drop', (e) => {
    const dt = (e as DragEvent).dataTransfer;
    void handleFiles(dt?.files ?? null);
  });
  // 整窗拖放
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    void handleFiles((e as DragEvent).dataTransfer?.files ?? null);
  });

  // 视图切换
  $('view-seg').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-view]') as HTMLButtonElement | null;
    if (!btn) return;
    document.querySelectorAll('#view-seg button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    player.setView(btn.dataset.view as 'compare' | 'final' | 'source');
  });
  $('baseline-mode').addEventListener('change', (e) => {
    player.setBaseline((e.target as HTMLSelectElement).value as 'hardclip' | 'hazy');
  });
  $('btn-loop').addEventListener('click', (e) => {
    player.loop = !player.loop;
    (e.currentTarget as HTMLButtonElement).style.opacity = player.loop ? '1' : '.4';
  });
  ($('btn-loop') as HTMLButtonElement).style.opacity = '1';

  $('transfer-override').addEventListener('change', (e) => {
    const all = [...materials, ...GPU_SOURCES];
    const m = all.find((x) => x.id === selectedId);
    if (!m) return;
    m.transferOverride = (e.target as HTMLSelectElement).value as Material['transferOverride'];
    updateDetectPanel(m);
    renderLibrary();
  });

  $('btn-png').addEventListener('click', () => {
    if (!player.current) return toast('请先选择素材', 'error');
    const url = player.snapshotDataUrl();
    const a = document.createElement('a');
    a.href = url;
    a.download = `${player.current.name}-sdr.png`;
    a.click();
    toast('已导出当前帧 PNG', 'ok');
  });

  // 右侧 tabs
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    const name = (t as HTMLElement).dataset.tab;
    $('tab-params').hidden = name !== 'params';
    $('tab-accept').hidden = name !== 'accept';
  }));

  // ΔE 验收
  $('btn-run-de').addEventListener('click', () => {
    const btn = $('btn-run-de') as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = '计算中…';
    setTimeout(() => {
      try {
        const suite = runColorSuite();
        renderDeResult($('de-result'), suite);
        toast(suite.pass ? `平均 ΔE00=${suite.mean.toFixed(2)}，达标` : 'ΔE00 未达标', suite.pass ? 'ok' : 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '重新运行 ΔE00 测试';
      }
    }, 30);
  });

  // FPS 基准
  $('btn-run-fps').addEventListener('click', () => {
    const btn = $('btn-run-fps') as HTMLButtonElement;
    const host = $('fps-result');
    btn.disabled = true;
    btn.textContent = '基准运行中…';
    host.textContent = '正在离屏渲染 120 个 4K 帧…';
    void runFpsBenchmark((d, total) => {
      host.textContent = `进度 ${d}/${total}`;
    }).then((r) => {
      renderFpsResult(host, r);
      toast(`4K 平均 ${r.wallFps.toFixed(0)} fps`, r.wallFps >= 60 ? 'ok' : 'error');
    }).catch((e) => {
      host.textContent = `基准失败：${(e as Error).message}`;
    }).finally(() => {
      btn.disabled = false;
      btn.textContent = '重新运行 4K 基准';
    });
  });

  // 批量抽屉
  const drawer = $('batch-drawer');
  $('btn-batch').addEventListener('click', () => { drawer.hidden = false; });
  drawer.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', () => {
    drawer.hidden = true;
  }));
}

bootstrap();
