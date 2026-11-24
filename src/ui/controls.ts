/** controls.ts — 右侧映射参数面板 */

import { h } from './dom';
import { DEFAULT_PARAMS, type ToneParams } from '../core/params';

interface SliderDef {
  key: keyof ToneParams;
  label: string;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  hint?: string;
}

interface GroupDef {
  title: string;
  sliders: SliderDef[];
}

const GROUPS: GroupDef[] = [
  {
    title: '场景分析',
    sliders: [
      { key: 'whitePercentile', label: '白位百分位', min: 95, max: 99.95, step: 0.1, format: (v) => `${v.toFixed(1)}%`, hint: '取场景最亮的稳定百分位，避开单个噪点' },
    ],
  },
  {
    title: '影调映射',
    sliders: [
      { key: 'exposureEV', label: '曝光补偿', min: -2, max: 2, step: 0.05, format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} EV` },
      { key: 'contrast', label: '反差', min: 0.85, max: 1.25, step: 0.01, format: (v) => v.toFixed(2) },
      { key: 'shadowLift', label: '暗部提升', min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%`, hint: '只作用于 x<0.1 的暗趾，深色衣服出纹理但不发灰' },
      { key: 'shadowTexture', label: '暗处局部纹理', min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%`, hint: 'log 域局部反差，强化衣物编织/褶皱' },
      { key: 'highlightRolloff', label: '高光肩部', min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%`, hint: '拉长云、霓虹灯的滚降，保住亮部层次' },
    ],
  },
  {
    title: '色彩 / 色域',
    sliders: [
      { key: 'saturation', label: '饱和度', min: 0.7, max: 1.4, step: 0.01, format: (v) => v.toFixed(2) },
      { key: 'gamutCompress', label: 'BT.2020→709 投影', min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%`, hint: 'Lab 恒明度恒色相压缩，肤色不偏' },
      { key: 'skinProtect', label: '肤色保护', min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%`, hint: '肤色楔形内减弱高光去饱和与局部反差' },
      { key: 'diffuseWhiteNits', label: 'HDR 漫反射白', min: 150, max: 300, step: 1, format: (v) => `${v} nit`, hint: 'BT.2408 参考值 203nit' },
    ],
  },
  {
    title: '时序平滑',
    sliders: [
      { key: 'smoothTimeSec', label: '同场景平滑', min: 0.2, max: 3, step: 0.05, format: (v) => `${v.toFixed(2)} s`, hint: '帧率无关指数阻尼 + 对数死区，杜绝微闪' },
      { key: 'cutTimeSec', label: '切镜过渡', min: 0.2, max: 2.5, step: 0.05, format: (v) => `${v.toFixed(2)} s`, hint: '硬切后仍缓慢滑向新场景参数，不闪' },
      { key: 'cutThreshold', label: '切镜判定阈值', min: 0.2, max: 0.8, step: 0.01, format: (v) => v.toFixed(2), hint: '相邻帧归一化直方图距离阈值' },
    ],
  },
];

export interface ControlsHandle {
  refresh: () => void;
}

export function buildControls(
  root: HTMLElement,
  params: ToneParams,
  onChange: () => void,
): ControlsHandle {
  root.innerHTML = '';

  // 自动场景开关
  const autoSwitch = h('label', { class: 'switch-row' },
    h('span', {}, '按场景亮度分布自动映射'),
    h('span', { class: 'switch' },
      (() => {
        const input = h('input', { type: 'checkbox' }) as HTMLInputElement;
        input.checked = params.autoScene;
        input.addEventListener('change', () => {
          params.autoScene = input.checked;
          onChange();
        });
        return input;
      })(),
      h('span', { class: 'slider-sw' }),
    ),
  );
  root.appendChild(autoSwitch);

  const valueLabels = new Map<keyof ToneParams, HTMLOutputElement>();

  for (const group of GROUPS) {
    root.appendChild(h('div', { class: 'group-title' }, group.title));
    const g = h('div', { class: 'group' });
    for (const def of group.sliders) {
      const out = h('output', {});
      valueLabels.set(def.key, out);
      const input = h('input', {
        type: 'range', min: def.min, max: def.max, step: def.step,
      }) as HTMLInputElement;
      input.value = String(params[def.key] as number);
      const renderValue = () => {
        const v = params[def.key] as number;
        out.textContent = def.format ? def.format(v) : String(v);
      };
      renderValue();
      input.addEventListener('input', () => {
        (params[def.key] as number) = Number(input.value);
        renderValue();
        onChange();
      });
      const ctrl = h('div', { class: 'ctrl' },
        h('div', { class: 'ctrl-head' }, h('span', {}, def.label), out),
        input,
        def.hint ? h('div', { class: 'hint' }, def.hint) : null,
      );
      g.appendChild(ctrl);
    }
    root.appendChild(g);
  }

  return {
    refresh() {
      for (const def of GROUPS.flatMap((g) => g.sliders)) {
        const out = valueLabels.get(def.key);
        if (out) {
          const v = params[def.key] as number;
          out.textContent = def.format ? def.format(v) : String(v);
        }
      }
    },
  };
}

export function resetParams(params: ToneParams): void {
  Object.assign(params, DEFAULT_PARAMS);
}
