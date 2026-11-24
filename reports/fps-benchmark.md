# 浏览器真机验收报告

- 时间：2026-11-24T17:22:09.245Z
- GPU：ANGLE (AMD, AMD Radeon 780M Graphics (0x000015BF) Direct3D11 vs_5_0 ps_5_0, D3D11)
- UA：Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/158.0.0.0 Safari/537.36

## 肤色 ΔE00
- 平均 **1.119**（阈值 ≤3）：✅
- P95 1.829 / 最大 1.829
- 同场景最大逐帧 ΔE00：0.0000
- 切镜后最大逐帧 ΔE00：0.5996

## 4K 吞吐
- **转换通道 276.6 fps**（3840×2160，120 帧，阈值 ≥60）：✅
- 含程序化场景生成全流程：142.8 fps
- 转换帧均 3.61ms；GPU timer n/a

