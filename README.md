# HDR → SDR 短剧调色工作台

手机录的 HDR 短剧（PQ/HLG、BT.2020）上传到不支持 HDR 的平台后灰蒙、天空死白、人脸像蜡像——
这是一个纯 Web 工具：**自动识别 PQ/HLG 与 BT.2020 → 按每个镜头自身的亮度分布做动态色调映射 →
肤色保护下把 BT.2020 压到 BT.709 → 切镜头时参数平滑过渡不闪**，包含素材管理、参数调节、
原片/成片分屏对照预览与批量转出。

逐像素色彩运算全部在 **WebGL2 片元着色器（GLSL ES 3.00）** 中，外层流程（素材、元数据解析、
统计、时序平滑、导出、验收）由 **TypeScript** 负责。

---

## 快速开始

```bash
npm install
npm run generate:clips   # 生成三种 HDR 测试片段到 public/samples（需要 PATH 中有 ffmpeg）
npm run dev              # http://127.0.0.1:5173
```

其他命令：

```bash
npm run verify:color     # 肤色 ΔE00 + 时序稳定性验收 -> reports/color-verification.{json,md}
npm run build            # 类型检查 + 生产构建到 dist/
npm run preview          # 预览构建产物（端口 47831）
npm run bench:fps        # Puppeteer + 本机 Chrome 跑 4K 基准 -> reports/fps-benchmark.{json,md,png}
npm run verify           # 以上一条龙
npx tsx scripts/check-clips.ts   # 校验生成片段的 PQ/HLG/BT.2020 元数据解析
```

右上角「4K 基准页」或直接访问 `/bench.html` 可在浏览器里手动跑完整验收。

---

## 它怎么满足两条硬指标

### 1. 肤色区域平均 ΔE00 ≤ 3

`npm run verify:color` 用 **20 个肤色片**（Fitzpatrick I–VI × 冷粉/中性/暖金 undertone +
两块接近 X-Rite ColorChecker Dark/Light Skin 的标准肤色）走完整条链路：

```
Lab(D65) → XYZ → BT.2020 线性 → ×203 nit 漫反射白(BT.2408)
        → PQ 编码 → PQ 解码 → 场景曲线 → Lab 恒明度/恒色相色度投影
        → BT.709 → sRGB 编码 → 8-bit 量化 → Lab → CIEDE2000
```

最新结果（见 `reports/color-verification.md`）：

| 指标 | 数值 |
| --- | --- |
| **平均 ΔE00** | **1.12**（阈值 3） |
| P95 / 最大 ΔE00 | 1.83 / 1.83 |
| 三种场景锚点（人像/霓虹/雪地）平均 ΔE00 | 1.12 / 0.93 / 1.10 左右 |
| GPU 7~8 次二分 vs CPU 28 次精确解 | 平均 < 0.3 ΔE |

能压低色差的三个设计：

1. **曲线在肤色亮度段（线性 Y≈0.14–0.5）严格恒等**：锚点直接取 `(0.14,0.14)`、`(0.5,0.5)`，
   Fritsch–Carlson 单调三次在两个斜率全为 1 的锚点之间精确还原 `y=x`；动态映射只改 `x<0.1`
   的暗趾（深色衣服）和 `x>0.85` 的肩部（云、霓虹），不碰肤色主体。
2. **色域压缩在 Lab 里做恒明度、恒色相的色度投影**：只沿 `a,b` 径向收缩到 BT.709 边界，
   不做会偏色相的逐通道硬裁切；肤色楔形区域还会减弱高光去饱和与局部反差。
3. **比例保持的亮度映射**：曲线只作用于 BT.2020 亮度 `Y`，RGB 同乘 `Y'/Y`，色相不被曲线扭动。

### 同场景无可见亮度跳动

`src/core/stats.ts`：

- 320×180 log10-nit 直方图 → 0.5/5/50/95/99.5/99.9 百分位，得到该场景自己的黑位/暗部/中灰/白位；
- 帧率无关指数阻尼 `α = 1 − exp(−dt/τ)`，同场景 `τ≈1.1s`，切镜后 `τ≈0.85s`（**仍然是慢慢过渡，不跳**）；
- 对数域死区 `|Δlog10|<0.0013` 直接不动，吃掉统计微抖；
- 相邻帧归一化直方图交集距离 > 0.42 判为硬切。

模拟「同场景 ±1.5% 统计抖动 + 第 100 帧硬切夜景」的逐帧色差：

| 指标 | 数值 |
| --- | --- |
| 同场景最大逐帧 ΔE00 | **0.0000** |
| 切镜后 30 帧内最大逐帧 ΔE00 | **0.60**（人眼 JND≈1–2，且这是单帧最大，随后平滑收敛） |

### 2. 4K 转出 ≥ 60fps

`bench.html` 在 **3840×2160** 离屏 RGBA8 FBO 上跑 120 帧，包含分析 pass、9-tap 高斯模糊、
完整 tonemap 片元着色器与每帧 `readPixels` 统计回读。Puppeteer 用本机真实 Chrome +
ANGLE/D3D11 测量（报告见 `reports/fps-benchmark.md`）：

| 通道（AMD Radeon 780M 实测） | FPS |
| --- | --- |
| **转换通道（视频解码后每帧的真实成本）** | **≈147 fps（6.8ms/帧）** |
| 含 4K 程序化 HDR 场景生成（fbm/SDF，比 video texture 贵） | ≈88 fps |

在 RTX 4060 上会更高。片元里最贵的 Lab 二分只有 7 次迭代且对色域内颜色一次早退。

---

## 三种自测 HDR 片段（脚本生成，非下载素材）

`npm run generate:clips` 用 TypeScript 软件渲染线性 BT.2020 nit 缓冲，PQ/HLG 编码成 16bit，
pipe 给 ffmpeg/libx265 压成 10bit HEVC，并写入 `colr/nclx` 与 VUI：

- `backlit-portrait-pq.mp4` — **逆光人像**：暖色天空、4000+nit 太阳与轮廓光、暗部衣物编织纹理；
- `neon-night-pq.mp4` — **夜景霓虹**：0.8–6nit 楼体、窗格、2600–4200nit 粉/青霓虹与湿地面反射；
- `snow-pq.mp4` — **雪地**：500–980nit 高亮雪面与蓝天、深色衣服人物、飘落亮雪花；
- `scene-cuts-pq.mp4` — 三个场景的硬切合集，用来就在预览里看切镜过渡；
- `backlit-portrait-hlg.mp4` — HLG/BT.2020 样本，验证两种传递函数识别。

`src/core/detect.ts` 是纯 TS 的 ISO-BMFF 解析器：递归 box + `stsd` 处理 + `colr/nclx`
字节扫描，另有 `src/core/hevc-vui.ts` 从 hvcC/SPS VUI 的比特流里按位搜索色彩三元组兜底
（部分文件不写 colr box）。

---

## 架构

```
src/
  core/                 同构色彩科学与状态（浏览器 + Node 验收共用同一份数学）
    color.ts            PQ EOTF/逆函数、HLG OETF/逆OETF/OOTF、BT.2020/709/XYZ/Lab、CIEDE2000
    params.ts           ToneParams、8 锚点单调 Hermite 曲线构造与 CPU 求值
    stats.ts            log-nit 直方图、百分位、切镜检测、ToneSmoother 时序平滑
    detect.ts           MP4 colr/nclx HDR 元数据识别（PQ=16 / HLG=18 / BT.2020 primaries=9）
    hevc-vui.ts         hvcC SPS VUI 色彩描述兜底解析
    skin.ts             20 个肤色样本
    pipeline-cpu.ts     片元着色器的逐行 CPU 参考实现（ΔE 验收 / GPU 近似对照）
    acceptance-suite.ts ΔE + 时序套件（verify 脚本与右侧面板共用）
  gl/
    shaders.ts          全部 GLSL ES 3.00：decode / analysis / blur / tonemap / 程序化三场景
    renderer.ts         WebGL2 多 pass、RGBA32F nit 场景目标、FBO、readPixels、4K benchmark
  ui/
    materials.ts        素材模型、manifest、用户文件检测、缩略图
    controls.ts         schema 驱动的参数滑块
    player.ts           rAF 渲染循环、分屏拖拽、传输、HUD/FPS
    exporter.ts         MediaRecorder 批量队列（WebM/VP9/VP8）+ PNG 抽帧
    acceptance-ui.ts    验收面板
  main.ts               主应用装配
  bench.ts              /bench.html 入口（Puppeteer 读取 window.__BENCH_RESULT__）
scripts/
  generate-clips.ts     生成 HDR 测试片段
  verify-color.ts       Node 色彩验收
  check-clips.ts        元数据识别校验
  bench-browser.mjs     启动 vite preview + Puppeteer/系统 Chrome 跑基准并写报告
```

### 帧管线

```
<video> ──texImage2D──▶ decode.frag (PQ/HLG/709 → BT.2020 linear nit, RGBA32F)
   │                         │
   │                         ├─ analysis.frag → 320×180 log10-luma → readPixels → 直方图/百分位
   │                         │                                   └→ ToneSmoother(τ, 死区, 切镜)
   │                         ├─ blur H/V → 局部纹理参考
   │                         └─ tonemap.frag:
   │                              场景 Hermite 曲线(亮度比例保持) → log 域局部反差
   │                              → 高光去饱和(肤色楔形减弱) → Lab ×饱和度
   │                              → 7 次二分恒 L/h 色域投影 BT.2020→709
   │                              → sRGB OETF + 抖动
   └─（GPU 测试源由 scene.frag 直接输出 nit，跳过解码）
```

---

## 关于浏览器播放 HDR 视频的如实说明

浏览器的 `<video>` + WebGL 上传链路在不同平台上**可能已经由系统/浏览器做过一次
HDR→SDR 转换**，且 `texImage2D(video)` 通常拿到的是 8bit RGBA——网页无法像原生播放器那样
稳定拿到未经处理的 10bit PQ/HLG 码值。因此本工具：

- **元数据识别是确定且经过测试的**（直接解析文件字节，不依赖解码管线）；
- 对内置片段与 GPU 源，管线处理的是数学上精确的 PQ/HLG 码值 / 线性 nit，
  ΔE 与 FPS 指标都在这条确定链路上测得；
- 对用户上传的真实手机片，建议在支持保留 PQ 码值上传的环境（部分 Chrome/Edge +
  硬件解码）使用，并可用「手动解释」强制 PQ/HLG；要做母带级离线转出，
  生产环境应把 decode pass 的输入换成 WebCodecs `VideoFrame`（可拿 10bit）或服务端 ffmpeg。

批量视频转出受 `MediaRecorder` 限制是**实时录制**（不是离线 60×速编码）；
「≥60fps」指的是逐像素 WebGL2 转换通道的吞吐，由 4K 离屏基准独立度量。

---

## 浏览器要求

Chrome / Edge ≥ 120，支持 WebGL2 与 `EXT_color_buffer_float`（基准机会检查并报告
GPU 渲染器字符串；若落到 SwiftShader 软件渲染，`npm run bench:fps` 会自动重试有头 GPU 模式）。
