/** Signal models offered by the curve-fitting and parametric-mapping tools. */

export type ModelId = 'dwi' | 't1ir' | 't1ir-a' | 't1vfa' | 't2';
export type ModelKind = 'exp' | 'ir' | 'vfa';
/** Acquisition parameter that acts as the independent variable. */
export type XKey = 'b' | 'ti' | 'fa' | 'te';

export interface ModelDef {
  id: ModelId;
  label: string;
  kind: ModelKind;
  /** Independent variable. */
  x: { key: XKey; label: string; short: string; unit: string };
  /** Primary fitted parameter as shown to the user. */
  param: { name: string; symbol: string; unit: string };
  /** True when the user-facing parameter is the rate itself (D), false when it is 1/rate (T1, T2). */
  rateIsParam: boolean;
  needsTR: boolean;
  /** Inversion efficiency A is fitted. */
  fitA: boolean;
  /** Default search range for the primary parameter, in user units. */
  range: [number, number];
  /** Equation as HTML (sub/sup only), without the optional constant. */
  equation: string;
  /** Example data for the curve-fitting tool. */
  example: { x: number[]; y: number[]; tr?: number };
}

export const MODELS: Record<ModelId, ModelDef> = {
  t2: {
    id: 't2',
    label: 'T2 / T2*',
    kind: 'exp',
    x: { key: 'te', label: 'Echo times', short: 'TE', unit: 'ms' },
    param: { name: 'T2', symbol: 'T<sub>2</sub>', unit: 'ms' },
    rateIsParam: false,
    needsTR: false,
    fitA: false,
    range: [1, 5000],
    equation: 'M = M<sub>0</sub> e<sup>−TE/T<sub>2</sub></sup>',
    example: {
      x: [10, 20, 40, 60, 80, 120, 160, 240],
      y: [900, 792, 636, 501, 394, 239, 157, 66],
    },
  },
  dwi: {
    id: 'dwi',
    label: 'DWI (ADC)',
    kind: 'exp',
    x: { key: 'b', label: 'b-values', short: 'b', unit: 's/mm²' },
    param: { name: 'D', symbol: 'D', unit: 'mm²/s' },
    rateIsParam: true,
    needsTR: false,
    fitA: false,
    range: [1e-6, 0.05],
    equation: 'M = M<sub>0</sub> e<sup>−bD</sup>',
    example: { x: [0, 50, 200, 400, 600, 800, 1000], y: [1015, 963, 856, 726, 620, 535, 458] },
  },
  t1ir: {
    id: 't1ir',
    label: 'T1 inversion recovery',
    kind: 'ir',
    x: { key: 'ti', label: 'Inversion times', short: 'TI', unit: 'ms' },
    param: { name: 'T1', symbol: 'T<sub>1</sub>', unit: 'ms' },
    rateIsParam: false,
    needsTR: true,
    fitA: false,
    range: [10, 10000],
    equation:
      'M = M<sub>0</sub> (1 − 2 e<sup>−TI/T<sub>1</sub></sup> + e<sup>−TR/T<sub>1</sub></sup>)',
    example: {
      x: [50, 100, 200, 400, 800, 1600, 3200],
      y: [-928, -819, -668, -389, 37, 536, 901],
      tr: 6000,
    },
  },
  't1ir-a': {
    id: 't1ir-a',
    label: 'T1 inversion recovery (imperfect 180°)',
    kind: 'ir',
    x: { key: 'ti', label: 'Inversion times', short: 'TI', unit: 'ms' },
    param: { name: 'T1', symbol: 'T<sub>1</sub>', unit: 'ms' },
    rateIsParam: false,
    needsTR: true,
    fitA: true,
    range: [10, 10000],
    equation:
      'M = M<sub>0</sub> (1 − 2A e<sup>−TI/T<sub>1</sub></sup> + (2A − 1) e<sup>−TR/T<sub>1</sub></sup>)',
    example: {
      x: [50, 100, 200, 400, 800, 1600, 3200],
      y: [-709, -644, -501, -249, 131, 593, 907],
      tr: 6000,
    },
  },
  t1vfa: {
    id: 't1vfa',
    label: 'T1 variable flip angle',
    kind: 'vfa',
    x: { key: 'fa', label: 'Flip angles', short: 'α', unit: '°' },
    param: { name: 'T1', symbol: 'T<sub>1</sub>', unit: 'ms' },
    rateIsParam: false,
    needsTR: true,
    fitA: false,
    range: [10, 10000],
    equation:
      'M = M<sub>0</sub> sin α (1 − e<sup>−TR/T<sub>1</sub></sup>) / (1 − cos α e<sup>−TR/T<sub>1</sub></sup>)',
    example: {
      x: [2, 4, 6, 10, 15, 20, 30],
      y: [33.1, 58.2, 73.6, 79.4, 69.5, 58.9, 42.1],
      tr: 15,
    },
  },
};

/** Models in the order they are listed: alphabetical by label. */
export const MODEL_ORDER: ModelId[] = (Object.keys(MODELS) as ModelId[]).sort((a, b) =>
  MODELS[a].label.localeCompare(MODELS[b].label, 'en'),
);
/** Model selected before the visitor or the image headers choose one. */
export const DEFAULT_MODEL: ModelId = 't2';

export interface FitOptions {
  /** Repetition time in ms; Infinity (or omitted) drops the TR term for IR. */
  tr?: number;
  /** Add a constant offset C to the model. */
  fitConstant?: boolean;
  /** Data are magnitude images: fit |M| for inversion recovery. */
  magnitude?: boolean;
  /** Search range for the primary parameter in user units. */
  range?: [number, number];
}
