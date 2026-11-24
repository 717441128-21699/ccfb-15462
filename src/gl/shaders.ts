/**
 * shaders.ts — 全部 WebGL2 GLSL ES 3.00 源码
 *
 * 与 src/core/pipeline-cpu.ts 逐阶段对应，修改时两边同步。
 */

export const VERT_FULLSCREEN = /* glsl */ `#version 300 es
precision highp float;
// 直接用 3 顶点大三角形，无 buffer 属性
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** 视频码值 -> BT.2020 线性 nit */
export const FRAG_DECODE = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D u_video;
uniform int u_transfer; // 0=PQ 1=HLG 2=BT.709/sRGB
uniform float u_hlgPeak;

const float PQ_M1 = 0.1593017578125;
const float PQ_M2 = 78.84375;
const float PQ_C1 = 0.8359375;
const float PQ_C2 = 18.8515625;
const float PQ_C3 = 18.6875;

float pqEotf(float n) {
  n = clamp(n, 0.0, 1.0);
  float np = pow(n, 1.0 / PQ_M2);
  return pow(max(np - PQ_C1, 0.0) / (PQ_C2 - PQ_C3 * np), 1.0 / PQ_M1);
}
float hlgInvOetf(float ep) {
  float x = clamp(ep, 0.0, 1.0);
  if (x <= 0.5) return x * x / 3.0;
  return (exp((x - 0.55991073) / 0.17883277) + 0.28466892) / 12.0;
}
float srgbDecode(float c) {
  return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4);
}
void main() {
  vec3 code = texture(u_video, vUv).rgb;
  vec3 nits;
  if (u_transfer == 0) {
    nits = vec3(pqEotf(code.r), pqEotf(code.g), pqEotf(code.b)) * 10000.0;
  } else if (u_transfer == 1) {
    vec3 e = vec3(hlgInvOetf(code.r), hlgInvOetf(code.g), hlgInvOetf(code.b));
    float ys = dot(e, vec3(0.2627, 0.6780, 0.0593));
    float k = pow(max(ys, 0.0), 0.2); // gamma 1.2 => gamma-1=0.2
    nits = e * k * u_hlgPeak;
  } else {
    nits = vec3(srgbDecode(code.r), srgbDecode(code.g), srgbDecode(code.b)) * 100.0;
  }
  fragColor = vec4(max(nits, vec3(0.0)), 1.0);
}
`;

/** 场景 nit -> R 通道 log10 亮度，供直方图与模糊使用 */
export const FRAG_ANALYSIS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D u_scene;
const vec3 C2020 = vec3(0.2627, 0.6780, 0.0593);
void main() {
  vec3 nits = texture(u_scene, vUv).rgb;
  float y = dot(nits, C2020);
  float l = log(max(y, 0.01)) / log(10.0);
  fragColor = vec4(clamp(l, -2.0, 4.0), 0.0, 0.0, 1.0);
}
`;

/** 可分离高斯模糊（方向由 u_dir 决定） */
export const FRAG_BLUR = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D u_tex;
uniform vec2 u_texel;
uniform vec2 u_dir;
void main() {
  // 9-tap gaussian
  float w[5];
  w[0] = 0.227027; w[1] = 0.1945946; w[2] = 0.1216216; w[3] = 0.054054; w[4] = 0.016216;
  vec3 sum = texture(u_tex, vUv).rgb * w[0];
  for (int i = 1; i < 5; i++) {
    vec2 off = u_dir * u_texel * float(i) * 1.6;
    sum += texture(u_tex, vUv + off).rgb * w[i];
    sum += texture(u_tex, vUv - off).rgb * w[i];
  }
  fragColor = vec4(sum, 1.0);
}
`;

const COLOR_CHUNKS = /* glsl */ `
const vec3 R2X = vec3(0.6369580483, 0.1446169036, 0.1688809752);
const vec3 G2X = vec3(0.2627002120, 0.6779980715, 0.0593017165);
const vec3 B2X = vec3(0.0,          0.0280726930, 1.0609850577);
vec3 bt2020ToXyz(vec3 c) {
  return vec3(dot(R2X, c), dot(G2X, c), dot(B2X, c));
}
const vec3 X2R709 = vec3( 3.2409699419, -1.5373831776, -0.4986107603);
const vec3 X2G709 = vec3(-0.9692436363,  1.8759675015,  0.0415550574);
const vec3 X2B709 = vec3( 0.0556300797, -0.2039769589,  1.0569715142);
vec3 xyzTo709(vec3 xyz) {
  return vec3(dot(X2R709, xyz), dot(X2G709, xyz), dot(X2B709, xyz));
}
vec3 xyzToLab(vec3 xyz) {
  vec3 w = vec3(0.9504559, 1.0, 1.0890578);
  vec3 t = xyz / w;
  vec3 f;
  f.r = t.r > 0.00885645 ? pow(t.r, 1.0/3.0) : 7.787037*t.r + 16.0/116.0;
  f.g = t.g > 0.00885645 ? pow(t.g, 1.0/3.0) : 7.787037*t.g + 16.0/116.0;
  f.b = t.b > 0.00885645 ? pow(t.b, 1.0/3.0) : 7.787037*t.b + 16.0/116.0;
  return vec3(116.0*f.g - 16.0, 500.0*(f.r-f.g), 200.0*(f.g-f.b));
}
vec3 labToXyz(vec3 lab) {
  float fy = (lab.x + 16.0) / 116.0;
  float fx = lab.y / 500.0 + fy;
  float fz = fy - lab.z / 200.0;
  float e = 216.0/24389.0;
  float k = 24389.0/27.0;
  float xr = fx*fx*fx > e ? fx*fx*fx : (116.0*fx - 16.0)/k;
  float yr = lab.x > 8.0 ? fy*fy*fy : lab.x / k;
  float zr = fz*fz*fz > e ? fz*fz*fz : (116.0*fz - 16.0)/k;
  return vec3(xr, yr, zr) * vec3(0.9504559, 1.0, 1.0890578);
}
float srgbEncode(float c) {
  c = clamp(c, 0.0, 1.0);
  return c <= 0.0031308 ? 12.92*c : 1.055*pow(c, 1.0/2.4) - 0.055;
}
vec3 srgbEncode(vec3 c) { return vec3(srgbEncode(c.r), srgbEncode(c.g), srgbEncode(c.b)); }

bool inside709(vec3 lab) {
  vec3 rgb = xyzTo709(labToXyz(lab));
  return rgb.r >= -0.002 && rgb.r <= 1.002
      && rgb.g >= -0.002 && rgb.g <= 1.002
      && rgb.b >= -0.002 && rgb.b <= 1.002;
}
// 恒 L/h 色度投影：固定 7 次二分（1/128 精度，色差远小于 8bit 量化）
float gamutChromaScale(vec3 lab) {
  if (inside709(lab)) return 1.0;
  float lo = 0.0, hi = 1.0;
  for (int i = 0; i < 7; i++) {
    float mid = (lo + hi) * 0.5;
    vec3 t = vec3(lab.x, lab.y*mid, lab.z*mid);
    if (inside709(t)) lo = mid; else hi = mid;
  }
  return lo * 0.995;
}
float skinMask(vec3 lab, float skinProtect) {
  if (skinProtect <= 0.001) return 0.0;
  float c = length(lab.yz);
  float h = degrees(atan(lab.z, lab.y));
  if (h < 0.0) h += 360.0;
  float hM = smoothstep(30.0, 42.0, h) * (1.0 - smoothstep(78.0, 95.0, h));
  float lM = smoothstep(28.0, 40.0, lab.x) * (1.0 - smoothstep(78.0, 90.0, lab.x));
  float cM = smoothstep(6.0, 14.0, c);
  return hM * lM * cM * skinProtect;
}
`;

/** 主色调映射片元：variant 0 = 动态成片 */
export const FRAG_TONEMAP = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D u_scene;   // BT.2020 nit
uniform sampler2D u_blur;    // 模糊后的 log10 亮度
uniform int u_variant;       // 0 成片 1 硬裁切基准 2 灰蒙反例

uniform float u_cx[8];
uniform float u_cy[8];
uniform float u_cm[8];

uniform float u_evGain;
uniform float u_refWhite;
uniform float u_shadowTexture;
uniform float u_highlightRolloff;
uniform float u_saturation;
uniform float u_skinProtect;
uniform float u_gamutCompress;

const vec3 C2020 = vec3(0.2627, 0.6780, 0.0593);

${COLOR_CHUNKS}

float evalCurve(float xin) {
  if (xin <= u_cx[0]) return clamp(u_cy[0] + u_cm[0]*(xin-u_cx[0]), 0.0, 1.0);
  if (xin >= u_cx[7]) return u_cy[7];
  int i = 0;
  for (int k = 0; k < 7; k++) {
    if (xin > u_cx[k+1]) { i = k + 1; }
  }
  float h = u_cx[i+1] - u_cx[i];
  float t = (xin - u_cx[i]) / h;
  float t2 = t*t, t3 = t2*t;
  float h00 = 2.0*t3 - 3.0*t2 + 1.0;
  float h10 = t3 - 2.0*t2 + t;
  float h01 = -2.0*t3 + 3.0*t2;
  float h11 = t3 - t2;
  float v = h00*u_cy[i] + h10*h*u_cm[i] + h01*u_cy[i+1] + h11*h*u_cm[i+1];
  return clamp(v, 0.0, 1.0);
}

vec3 renderDynamic(vec2 uv) {
  vec3 nits = texture(u_scene, uv).rgb;
  float yNit = max(dot(nits, C2020), 0.0);
  float xY = u_evGain * yNit / u_refWhite;
  float vY = evalCurve(xY);

  // 局部纹理：log 域局部反差，只作用于阴影/中间调
  float logY = log(max(yNit, 0.01)) / log(10.0);
  float blurLog = texture(u_blur, uv).r;
  float detailStops = clamp((logY - blurLog) / log(2.0), -1.5, 1.5);
  float shadowMask = 1.0 - smoothstep(0.35, 0.78, vY);
  vY = clamp(vY * (1.0 + u_shadowTexture * 0.55 * shadowMask * detailStops), 0.0, 1.0);

  // 亮度比例保持 RGB 色相
  vec3 xc = u_evGain * max(nits, vec3(0.0)) / u_refWhite;
  float k = vY / max(xY, 1e-6);
  vec3 lin = xc * k;

  vec3 lab = xyzToLab(bt2020ToXyz(lin));
  float skin = skinMask(lab, u_skinProtect);

  // 高光柔和去饱和，肤色楔形内减弱
  float hiMask = smoothstep(0.72, 0.97, vY);
  float desat = hiMask * (0.18 + 0.5*u_highlightRolloff) * (1.0 - 0.75*skin);
  lin = mix(lin, vec3(vY), desat);

  lab = xyzToLab(bt2020ToXyz(lin));
  lab.yz *= u_saturation;

  // BT.2020 -> BT.709 恒色相色域投影
  float s = gamutChromaScale(lab);
  // gamutCompress 创作混合：<1 时混入直接矩阵裁切路径
  vec3 labProj = vec3(lab.x, lab.y*s, lab.z*s);
  vec3 rgbProj = xyzTo709(labToXyz(labProj));
  vec3 rgbClip = clamp(xyzTo709(bt2020ToXyz(lin)), 0.0, 1.0);
  vec3 rgb709 = mix(rgbClip, clamp(rgbProj, 0.0, 1.0), u_gamutCompress);

  return srgbEncode(rgb709);
}

vec3 renderHardClip(vec2 uv) {
  vec3 nits = texture(u_scene, uv).rgb;
  vec3 x = nits / 203.0; // BT.2408 参考白
  vec3 rgb709 = clamp(xyzTo709(bt2020ToXyz(x)), 0.0, 1.0);
  return srgbEncode(rgb709);
}

vec3 renderHazy(vec2 uv) {
  // 模拟“平台不支持 HDR 时的糟糕转码”：强抬黑场 + 欠饱和 + 肩部死白
  vec3 nits = texture(u_scene, uv).rgb;
  vec3 x = nits / 900.0;
  x = x / (1.0 + 0.85*x);
  vec3 rgb709 = clamp(xyzTo709(bt2020ToXyz(x)), 0.0, 1.0);
  vec3 q = srgbEncode(rgb709);
  float l = dot(q, vec3(0.2126, 0.7152, 0.0722));
  q = mix(vec3(l), q, 0.55);
  q = q * 0.82 + vec3(0.16, 0.17, 0.19);
  return clamp(q, 0.0, 1.0);
}

void main() {
  vec3 c;
  if (u_variant == 1) c = renderHardClip(vUv);
  else if (u_variant == 2) c = renderHazy(vUv);
  else c = renderDynamic(vUv);
  // 轻微有序抖动，消除 8bit 色带
  float d = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  c += (d - 0.5) / 255.0;
  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

/**
 * 程序化 HDR 测试场景，输出 BT.2020 nit 线性值。
 * u_scene: 0 逆光人像 1 夜景霓虹 2 雪地
 */
export const FRAG_SCENE = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform int u_scene;
uniform float u_time;
uniform vec2 u_res;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float a = hash21(i), b = hash21(i+vec2(1,0)), c = hash21(i+vec2(0,1)), d = hash21(i+vec2(1,1));
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a*vnoise(p); p *= 2.03; a *= 0.5; }
  return v;
}
// 圆 / 胶囊 SDF
float sdEllipse(vec2 p, vec2 c, vec2 r) {
  vec2 q = (p - c) / r;
  return (length(q) - 1.0) * min(r.x, r.y);
}

vec3 scenePortrait(vec2 uv, float t) {
  float ar = u_res.x / max(u_res.y, 1.0);
  vec2 p = (uv - 0.5) * vec2(ar, 1.0);
  // 天空：暖色地平线 + 冷色顶部，HDR 高亮
  vec3 top = vec3(0.35, 0.5, 0.85) * 260.0;
  vec3 horizon = vec3(1.0, 0.72, 0.45) * 900.0;
  float g = smoothstep(0.15, 0.95, uv.y);
  vec3 col = mix(horizon, top, g);
  // 太阳 + 光晕（4000+ nit）
  vec2 sp = (uv - vec2(0.68, 0.62)) * vec2(ar, 1.0);
  float sd = length(sp);
  col += vec3(1.0, 0.85, 0.6) * exp(-sd*7.0) * 1400.0;
  col += vec3(1.0, 0.92, 0.75) * smoothstep(0.055, 0.045, sd) * 5000.0;
  // 云：亮云边保留层次
  float cl = fbm(uv*vec2(5.0, 9.0) + vec2(t*0.01, 0.0));
  float cloud = smoothstep(0.55, 0.75, cl) * smoothstep(0.35, 0.75, uv.y);
  col = mix(col, vec3(1.0, 0.93, 0.82) * 1500.0, cloud*0.55);
  float cloudDark = smoothstep(0.45, 0.7, fbm(uv*vec2(6.0,11.0)+3.0));
  col *= 1.0 - cloudDark*0.18*smoothstep(0.4,0.8,uv.y);

  // 头肩剪影
  float head = sdEllipse(p, vec2(0.02, 0.06), vec2(0.135, 0.17));
  float shoulders = sdEllipse(p, vec2(0.0, -0.42), vec2(0.46, 0.27));
  float body = min(head, shoulders);
  float mask = smoothstep(0.004, -0.004, body);
  // 衣服纹理（暗部仍有 6~22 nit 细节）
  float fabric = fbm(uv*220.0) * 0.5 + fbm(uv*900.0)*0.5;
  float folds = 0.5 + 0.5*sin(uv.x*90.0 + fbm(uv*8.0)*6.0);
  vec3 cloth = mix(vec3(0.05,0.06,0.09), vec3(0.12,0.13,0.18), fabric) * (7.0 + 16.0*folds);
  // 脖子/脸部微弱补光，保证不是死黑
  vec3 skinShadow = vec3(0.35, 0.2, 0.14) * (14.0 + 26.0*fbm(uv*60.0));
  float headMask = smoothstep(0.004, -0.004, head);
  vec3 figure = mix(cloth, skinShadow, headMask);
  // 逆光轮廓光（rim light）
  float rim = smoothstep(0.012, 0.0, abs(body)) * smoothstep(-0.2, 0.5, p.x + 0.15);
  figure += vec3(1.0, 0.78, 0.5) * rim * 900.0;
  col = mix(col, figure, mask);
  // 轻微呼吸运镜暗角
  col *= 1.0 - 0.25*smoothstep(0.5, 1.1, length(p));
  return max(col, vec3(0.0));
}

vec3 sceneNeon(vec2 uv, float t) {
  float ar = u_res.x / max(u_res.y, 1.0);
  vec2 p = (uv - 0.5) * vec2(ar, 1.0);
  // 夜空 1~4 nit
  vec3 col = mix(vec3(0.012,0.014,0.03)*3.0, vec3(0.02,0.025,0.06)*6.0, uv.y);
  // 楼宇剪影 + 窗格
  for (int i = 0; i < 9; i++) {
    float fi = float(i);
    float bx = -1.05 + fi*0.26 + 0.06*hash21(vec2(fi, 1.0));
    float bw = 0.18 + 0.08*hash21(vec2(fi, 2.0));
    float bh = 0.35 + 0.5*hash21(vec2(fi, 3.0));
    vec2 bc = vec2(bx, bh*0.5 - 0.5);
    float b = sdEllipse(p - bc, vec2(0.0), vec2(bw*0.5, bh*0.5));
    float bm = smoothstep(0.002, -0.002, b);
    // 楼体
    col = mix(col, vec3(0.02,0.022,0.045)*(3.0+2.0*hash21(vec2(fi,4.0))), bm*0.9);
    // 窗户
    vec2 wuv = (p - bc + vec2(bw*0.5, bh*0.5)) / vec2(bw, bh);
    vec2 grid = fract(wuv * vec2(6.0, 14.0));
    float win = step(0.25, grid.x)*step(grid.x,0.72)*step(0.3,grid.y)*step(grid.y,0.7);
    float lit = step(0.55, hash21(floor(wuv*vec2(6.0,14.0)) + fi));
    float tw = 0.75 + 0.25*sin(t*2.0 + fi*3.0 + hash21(floor(wuv*40.0))*20.0);
    vec3 wcol = mix(vec3(1.0,0.75,0.4), vec3(0.6,0.8,1.0), hash21(vec2(fi,9.0)));
    col += wcol * win * lit * tw * 120.0 * bm;
  }
  // 霓虹灯管（高饱和 2500~4500 nit）+ bloom
  vec3 neonPink = vec3(1.0, 0.08, 0.45);
  vec3 neonCyan = vec3(0.05, 0.9, 1.0);
  float tube1 = smoothstep(0.018, 0.0, abs(p.x + 0.42 + 0.05*sin(p.y*6.0+t*0.6)))
              * smoothstep(-0.45,-0.35,p.y) * (1.0-smoothstep(0.35,0.45,p.y));
  float glow1 = exp(-abs(p.x + 0.42)*18.0) * smoothstep(-0.5,-0.3,p.y)*(1.0-smoothstep(0.3,0.5,p.y));
  col += neonPink * tube1 * 4200.0 + neonPink * glow1 * 500.0;
  float tube2 = smoothstep(0.014, 0.0, length(p - vec2(0.45,0.18)) - 0.16);
  float ring = smoothstep(0.02,0.0,abs(length(p-vec2(0.45,0.18))-0.16));
  float glow2 = exp(-abs(length(p-vec2(0.45,0.18))-0.16)*10.0);
  col += neonCyan * ring * 3600.0 + neonCyan * glow2 * 420.0;
  // 湿地面反射
  float refl = smoothstep(0.55, 0.0, uv.y) * smoothstep(0.0, 0.25, uv.y);
  float streak = fbm(vec2(uv.x*60.0, uv.y*8.0 - t*0.4));
  col += (neonPink*glow1 + neonCyan*glow2) * refl * (0.25+0.55*streak);
  return max(col, vec3(0.0));
}

vec3 sceneSnow(vec2 uv, float t) {
  float ar = u_res.x / max(u_res.y, 1.0);
  vec2 p = (uv - 0.5) * vec2(ar, 1.0);
  // 高原蓝天
  vec3 col = mix(vec3(0.72,0.82,0.98)*520.0, vec3(0.35,0.52,0.95)*760.0, smoothstep(0.45,1.0,uv.y));
  // 远山
  float m = 0.42 + 0.08*fbm(vec2(uv.x*3.0, 1.0));
  float mMask = smoothstep(m+0.004, m-0.004, uv.y);
  col = mix(col, vec3(0.82,0.88,0.99)*620.0, mMask*0.8);
  // 雪地：高亮 + 纹理起伏 + 蓝阴影
  float ground = smoothstep(0.55, 0.45, uv.y);
  float snowTex = fbm(uv*vec2(18.0, 60.0));
  vec3 snowCol = mix(vec3(0.82,0.88,1.0)*560.0, vec3(1.0,0.99,0.96)*980.0, snowTex);
  snowCol *= 0.92 + 0.08*fbm(uv*vec2(6.0,30.0));
  col = mix(col, snowCol, ground);
  // 雪地上的深色人物（衣服纹理不能糊）
  float fig = min(sdEllipse(p, vec2(0.0,-0.28), vec2(0.16,0.24)),
                  sdEllipse(p, vec2(0.0,-0.02), vec2(0.07,0.085)));
  float fm = smoothstep(0.004,-0.004,fig);
  float weave = fbm(uv*260.0);
  vec3 coat = mix(vec3(0.04,0.05,0.08), vec3(0.14,0.16,0.22), weave)*(8.0+14.0*fbm(uv*90.0));
  col = mix(col, coat, fm);
  // 飘落雪花（受光亮粒）
  for (int L = 0; L < 3; L++) {
    float fl = float(L);
    vec2 gp = uv * vec2(60.0+fl*40.0, 30.0+fl*20.0);
    gp.y += t*(2.0+fl);
    vec2 id = floor(gp);
    vec2 f = fract(gp)-0.5;
    float h = hash21(id + fl*17.0);
    vec2 drift = vec2(sin(t*0.7+h*20.0)*0.25, 0.0);
    float dotm = smoothstep(0.12+fl*0.03, 0.02, length(f+drift));
    float appear = step(0.82, h);
    col += vec3(1.0) * dotm * appear * (1400.0 - fl*350.0);
  }
  return max(col, vec3(0.0));
}

void main() {
  vec2 uv = vUv;
  // vUv 即屏幕空间 0..1（大三角形构造），但 gl 视口可能不是全屏，这里用 gl_FragCoord 更稳
  uv = gl_FragCoord.xy / u_res;
  vec3 c;
  if (u_scene == 0) c = scenePortrait(uv, u_time);
  else if (u_scene == 1) c = sceneNeon(uv, u_time);
  else c = sceneSnow(uv, u_time);
  fragColor = vec4(c, 1.0);
}
`;
