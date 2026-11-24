/**
 * renderer.ts — WebGL2 渲染器
 *
 * 通道：
 *   视频码值 --decode--> RGBA32F nit 场景纹理（或程序化 HDR 场景直接生成）
 *   场景 --analysis--> 320x180 log10 亮度（readPixels 给 TS 统计）
 *        \--downsample blur H/V--> 局部反差纹理
 *   场景+曲线+色域压缩 --tonemap--> sRGB 画面 / 分屏对照 / 导出目标
 */

import { VERT_FULLSCREEN, FRAG_DECODE, FRAG_ANALYSIS, FRAG_BLUR, FRAG_TONEMAP, FRAG_SCENE } from './shaders';
import type { ToneParams, CurveKnots, SceneTone } from '../core/params';
import { buildCurve, DEFAULT_PARAMS as DEFAULT_PARAMS_BENCH } from '../core/params';
import {
  ToneSmoother,
  buildHistogram,
  analyzeHistogram,
  directScene,
  type FrameStats,
} from '../core/stats';
import type { Transfer } from '../core/pipeline-cpu';

export type ViewMode = 'compare' | 'final' | 'source';
export type BaselineMode = 'hardclip' | 'hazy';

interface Target {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
  internal: number;
  format: number;
  type: number;
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    console.error(log, src);
    throw new Error('Shader 编译失败: ' + log);
  }
  return sh;
}

function createProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('Program 链接失败: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

export interface ProcessOptions {
  source:
    | { kind: 'procedural'; sceneId: 0 | 1 | 2; time: number }
    | { kind: 'video'; video: HTMLVideoElement; transfer: Transfer | 'bt709' };
  params: ToneParams;
  smoother: ToneSmoother;
  dt: number;
  view?: ViewMode;
  split?: number;
  baseline?: BaselineMode;
  /** 输出到指定 FBO 尺寸（导出/基准），默认画到 canvas */
  output?: { fbo: WebGLFramebuffer | null; w: number; h: number };
}

export interface ProcessResult {
  scene: SceneTone;
  stats: FrameStats;
}

const ANALYSIS_W = 320;
const ANALYSIS_H = 180;

export class HDRRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  readonly rendererString: string;
  private extFloat: EXT_color_buffer_float | null;
  private timerExt: any = null;

  private pDecode: WebGLProgram;
  private pAnalysis: WebGLProgram;
  private pBlur: WebGLProgram;
  private pTonemap: WebGLProgram;
  private pScene: WebGLProgram;
  private vao: WebGLVertexArrayObject;

  private sceneRT: Target | null = null;
  private analysisRT: Target | null = null;
  private blurA: Target | null = null;
  private blurB: Target | null = null;
  private outRT: Target | null = null;
  private videoTex: WebGLTexture;

  private analysisBuf = new Float32Array(ANALYSIS_W * ANALYSIS_H * 4);
  private logCompact = new Float32Array(ANALYSIS_W * ANALYSIS_H);

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    this.extFloat = gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');
    this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.rendererString = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);

    this.pDecode = createProgram(gl, VERT_FULLSCREEN, FRAG_DECODE);
    this.pAnalysis = createProgram(gl, VERT_FULLSCREEN, FRAG_ANALYSIS);
    this.pBlur = createProgram(gl, VERT_FULLSCREEN, FRAG_BLUR);
    this.pTonemap = createProgram(gl, VERT_FULLSCREEN, FRAG_TONEMAP);
    this.pScene = createProgram(gl, VERT_FULLSCREEN, FRAG_SCENE);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    this.videoTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.analysisRT = this.createTarget(ANALYSIS_W, ANALYSIS_H, gl.RGBA32F, gl.RGBA, gl.FLOAT);
    this.blurA = this.createTarget(ANALYSIS_W, ANALYSIS_H, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT);
    this.blurB = this.createTarget(ANALYSIS_W, ANALYSIS_H, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT);
  }

  private createTarget(w: number, h: number, internal: number, format: number, type: number): Target {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('FBO 不完整: 0x' + status.toString(16) + ' (float 扩展: ' + !!this.extFloat + ')');
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex, w, h, internal, format, type };
  }

  private ensureScene(w: number, h: number): Target {
    if (this.sceneRT && this.sceneRT.w === w && this.sceneRT.h === h) return this.sceneRT;
    if (this.sceneRT) {
      this.gl.deleteTexture(this.sceneRT.tex);
      this.gl.deleteFramebuffer(this.sceneRT.fbo);
    }
    // 直接存 nit 浮点；RGBA32F 保证高光梯度不被精度截断
    this.sceneRT = this.createTarget(w, h, this.gl.RGBA32F, this.gl.RGBA, this.gl.FLOAT);
    return this.sceneRT;
  }

  ensureOutput(w: number, h: number): Target {
    if (this.outRT && this.outRT.w === w && this.outRT.h === h) return this.outRT;
    if (this.outRT) {
      this.gl.deleteTexture(this.outRT.tex);
      this.gl.deleteFramebuffer(this.outRT.fbo);
    }
    this.outRT = this.createTarget(w, h, this.gl.RGBA8, this.gl.RGBA, this.gl.UNSIGNED_BYTE);
    return this.outRT;
  }

  /** 让 canvas 绘图缓冲匹配显示分辨率（CSS 尺寸 * dpr 由调用方给） */
  resizeCanvas(w: number, h: number): boolean {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      return true;
    }
    return false;
  }

  private bindQuad(prog: WebGLProgram): void {
    this.gl.useProgram(prog);
    this.gl.bindVertexArray(this.vao);
  }

  /** 渲染程序化 HDR 场景到 sceneRT */
  private renderProcedural(sceneId: number, time: number, w: number, h: number): void {
    const gl = this.gl;
    const rt = this.ensureScene(w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fbo);
    gl.viewport(0, 0, w, h);
    this.bindQuad(this.pScene);
    gl.uniform1i(gl.getUniformLocation(this.pScene, 'u_scene'), sceneId);
    gl.uniform1f(gl.getUniformLocation(this.pScene, 'u_time'), time);
    gl.uniform2f(gl.getUniformLocation(this.pScene, 'u_res'), w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** 上传视频帧并解码到 sceneRT */
  private decodeVideo(video: HTMLVideoElement, transfer: 'pq' | 'hlg' | 'bt709', w: number, h: number): void {
    const gl = this.gl;
    const rt = this.ensureScene(w, h);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    } catch (e) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      throw e;
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fbo);
    gl.viewport(0, 0, w, h);
    this.bindQuad(this.pDecode);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.uniform1i(gl.getUniformLocation(this.pDecode, 'u_video'), 0);
    gl.uniform1i(gl.getUniformLocation(this.pDecode, 'u_transfer'), transfer === 'pq' ? 0 : transfer === 'hlg' ? 1 : 2);
    gl.uniform1f(gl.getUniformLocation(this.pDecode, 'u_hlgPeak'), 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** 场景 -> log 亮度 FBO + readPixels，返回紧凑 log10 数组 */
  private runAnalysis(): Float32Array {
    const gl = this.gl;
    const scene = this.sceneRT!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.analysisRT!.fbo);
    gl.viewport(0, 0, ANALYSIS_W, ANALYSIS_H);
    this.bindQuad(this.pAnalysis);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, scene.tex);
    gl.uniform1i(gl.getUniformLocation(this.pAnalysis, 'u_scene'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.readPixels(0, 0, ANALYSIS_W, ANALYSIS_H, gl.RGBA, gl.FLOAT, this.analysisBuf);
    for (let i = 0; i < ANALYSIS_W * ANALYSIS_H; i++) {
      this.logCompact[i] = this.analysisBuf[i * 4];
    }
    return this.logCompact;
  }

  /** 对 log 亮度做两次 9-tap 高斯（水平+垂直） */
  private runBlur(): Target {
    const gl = this.gl;
    const src = this.analysisRT!;
    const a = this.blurA!;
    const b = this.blurB!;
    const pass = (input: Target, out: Target, dx: number, dy: number) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
      gl.viewport(0, 0, ANALYSIS_W, ANALYSIS_H);
      this.bindQuad(this.pBlur);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, input.tex);
      gl.uniform1i(gl.getUniformLocation(this.pBlur, 'u_tex'), 0);
      gl.uniform2f(gl.getUniformLocation(this.pBlur, 'u_texel'), 1 / ANALYSIS_W, 1 / ANALYSIS_H);
      gl.uniform2f(gl.getUniformLocation(this.pBlur, 'u_dir'), dx, dy);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    pass(src, a, 1, 0);
    pass(a, b, 0, 1);
    return b;
  }

  private applyTonemapUniforms(prog: WebGLProgram, params: ToneParams, curve: CurveKnots): void {
    const gl = this.gl;
    const loc = (n: string) => gl.getUniformLocation(prog, n);
    gl.uniform1fv(loc('u_cx[0]'), curve.x);
    gl.uniform1fv(loc('u_cy[0]'), curve.y);
    gl.uniform1fv(loc('u_cm[0]'), curve.m);
    gl.uniform1f(loc('u_evGain'), Math.pow(2, params.exposureEV));
    gl.uniform1f(loc('u_refWhite'), params.diffuseWhiteNits);
    gl.uniform1f(loc('u_shadowTexture'), params.shadowTexture);
    gl.uniform1f(loc('u_highlightRolloff'), params.highlightRolloff);
    gl.uniform1f(loc('u_saturation'), params.saturation);
    gl.uniform1f(loc('u_skinProtect'), params.skinProtect);
    gl.uniform1f(loc('u_gamutCompress'), params.gamutCompress);
  }

  /**
   * 高层入口：生成/解码 -> 统计 -> 平滑 -> 模糊 -> 绘制。
   * 当 output 省略时画到 canvas，并按 view/split 出对照。
   */
  processFrame(opts: ProcessOptions): ProcessResult {
    const { params, smoother, dt } = opts;

    let srcW = 1920;
    let srcH = 1080;
    if (opts.source.kind === 'procedural') {
      // 程序化源默认按 canvas  backing 尺寸渲染（benchmark 会先 resize 到 4K）
      srcW = this.canvas.width || 1920;
      srcH = this.canvas.height || 1080;
      this.renderProcedural(opts.source.sceneId, opts.source.time, srcW, srcH);
    } else {
      const v = opts.source.video;
      srcW = v.videoWidth || 1920;
      srcH = v.videoHeight || 1080;
      this.decodeVideo(v, opts.source.transfer, srcW, srcH);
    }

    return this.conversionPass(params, smoother, dt, opts.view ?? 'compare', opts.split ?? params.split,
      opts.baseline ?? 'hardclip', opts.output);
  }

  /**
   * 转换通道：场景统计 -> 时序平滑 -> 曲线 -> 局部模糊 -> tonemap 绘制。
   * 要求 sceneRT 已由 processFrame 的源阶段或 benchmark 预置好。
   */
  conversionPass(
    params: ToneParams,
    smoother: ToneSmoother,
    dt: number,
    view: ViewMode = 'final',
    split = 0.5,
    baseline: BaselineMode = 'hardclip',
    output?: { fbo: WebGLFramebuffer | null; w: number; h: number },
  ): ProcessResult {
    const gl = this.gl;
    const logs = this.runAnalysis();
    const { hist, meanLog } = buildHistogram(logs);
    const rawStats = analyzeHistogram(hist, meanLog, params.whitePercentile);
    // 自动场景：时序平滑；手动模式：固定锚点，不做平滑跟随
    const scene = params.autoScene
      ? smoother.update(rawStats, params, dt)
      : directScene(null, params);
    const curve = buildCurve(scene, params);
    const blurRT = this.runBlur();

    if (output) {
      const { fbo, w, h } = output;
      this.drawTonemap(fbo, w, h, blurRT, curve, params, 0);
    } else {
      const w = this.canvas.width;
      const h = this.canvas.height;
      if (view === 'final') {
        this.drawTonemap(null, w, h, blurRT, curve, params, 0);
      } else if (view === 'source') {
        this.drawTonemap(null, w, h, blurRT, curve, params, baseline === 'hazy' ? 2 : 1);
      } else {
        const sx = Math.round(split * w);
        gl.enable(gl.SCISSOR_TEST);
        // 左：成片
        gl.scissor(0, 0, sx, h);
        this.drawTonemap(null, w, h, blurRT, curve, params, 0);
        // 右：基准
        gl.scissor(sx, 0, w - sx, h);
        this.drawTonemap(null, w, h, blurRT, curve, params, baseline === 'hazy' ? 2 : 1);
        gl.disable(gl.SCISSOR_TEST);
      }
    }
    return { scene, stats: rawStats };
  }

  private drawTonemap(
    fbo: WebGLFramebuffer | null,
    w: number,
    h: number,
    blurRT: Target,
    curve: CurveKnots,
    params: ToneParams,
    variant: number,
  ): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w, h);
    this.bindQuad(this.pTonemap);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneRT!.tex);
    gl.uniform1i(gl.getUniformLocation(this.pTonemap, 'u_scene'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, blurRT.tex);
    gl.uniform1i(gl.getUniformLocation(this.pTonemap, 'u_blur'), 1);
    gl.uniform1i(gl.getUniformLocation(this.pTonemap, 'u_variant'), variant);
    this.applyTonemapUniforms(this.pTonemap, params, curve);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * 4K 吞吐基准：
   *  - conversionFps：预置一帧场景纹理后，只跑“分析回读+模糊+动态曲线+
   *    Lab 色域投影 tonemap”，这正是视频转出时的逐帧成本（源由解码器提供）；
   *  - fullFps：额外包含 4K 程序化 HDR 场景生成（fbm/SDF，比真实 decode 重）。
   * 全程渲染到离屏 RGBA8 FBO，不经过交换链/vsync。
   */
  async benchmark4k(frames = 120, onProgress?: (done: number) => void): Promise<{
    width: number; height: number; frames: number;
    wallFps: number; conversionFps: number; fullFps: number; gpuMs: number | null;
  }> {
    const gl = this.gl;
    const W = 3840;
    const H = 2160;
    this.resizeCanvas(W, H);
    const out = this.ensureOutput(W, H);
    const target = { fbo: out.fbo, w: W, h: H } as const;
    const makeSmoother = () => new ToneSmoother();
    const params = { ...DEFAULT_PARAMS_BENCH };

    // 预置静态场景纹理（转换基准用）
    this.renderProcedural(0, 3.1, W, H);

    // warmup：shader 编译 / FBO / 管线分配
    for (let i = 0; i < 12; i++) {
      this.conversionPass(params, makeSmoother(), 1 / 60, 'final', 0.5, 'hardclip', target);
    }
    gl.finish();

    // ---- 转换通道吞吐 ----
    const sm1 = makeSmoother();
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) {
      this.conversionPass(params, sm1, 1 / 60, 'final', 0.5, 'hardclip', target);
      if (i % 30 === 29) onProgress?.(i + 1);
    }
    gl.finish();
    const convMs = performance.now() - t0;

    // ---- 全流程（含程序化场景生成）----
    const sm2 = makeSmoother();
    gl.finish();
    const t1 = performance.now();
    for (let i = 0; i < frames; i++) {
      this.processFrame({
        source: { kind: 'procedural', sceneId: (Math.floor(i / 40) % 3) as 0 | 1 | 2, time: i / 60 },
        params, smoother: sm2, dt: 1 / 60,
        output: target,
      });
    }
    gl.finish();
    const fullMs = performance.now() - t1;
    onProgress?.(frames);

    // GPU timer（参考）
    let gpuMs: number | null = null;
    if (this.timerExt) {
      const q = gl.createQuery()!;
      gl.beginQuery(this.timerExt.TIME_ELAPSED_EXT, q);
      this.conversionPass(params, makeSmoother(), 1 / 60, 'final', 0.5, 'hardclip', target);
      gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);
      gl.finish();
      if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
        gpuMs = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
      }
    }

    const conversionFps = (frames * 1000) / convMs;
    return {
      width: W,
      height: H,
      frames,
      wallFps: conversionFps, // 主指标 = 转换吞吐
      conversionFps,
      fullFps: (frames * 1000) / fullMs,
      gpuMs,
    };
  }

  /** 读回当前 canvas/FBO 的 dataURL（导出 PNG 用） */
  capturePNG(): string {
    // preserveDrawingBuffer: true，可直接 toDataURL
    return this.canvas.toDataURL('image/png');
  }

  dispose(): void {
    const gl = this.gl;
    [this.sceneRT, this.analysisRT, this.blurA, this.blurB, this.outRT].forEach((rt) => {
      if (rt) {
        gl.deleteTexture(rt.tex);
        gl.deleteFramebuffer(rt.fbo);
      }
    });
    gl.deleteTexture(this.videoTex);
    [this.pDecode, this.pAnalysis, this.pBlur, this.pTonemap, this.pScene].forEach((p) => gl.deleteProgram(p));
    gl.deleteVertexArray(this.vao);
    const ext = gl.getExtension('WEBGL_lose_context');
    ext?.loseContext();
  }
}
