/** Contrastinator: two-tissue contrast optimisation for GRE and SE sequences. */
import { DEG, spgrSignal, spinEchoSignal, type Tissue, linspace } from './signal.js';
import { assertValid, checkContrast } from './validate.js';

export type ContrastMode = 'gre' | 'se-t1' | 'se-t2';

export interface ContrastInput {
  mode: ContrastMode;
  tissues: [Tissue, Tissue];
  /** Echo time, ms (GRE and T1-weighted SE). */
  te?: number;
  /** Repetition time, ms (GRE and T2-weighted SE). */
  tr?: number;
}

export interface ContrastResult {
  mode: ContrastMode;
  /** Name and unit of the optimised variable. */
  variable: { name: string; symbol: string; unit: string };
  optimum: number;
  signals: [number, number];
  difference: number;
  ratio: number;
  warnings: string[];
  /** Sampled curves for plotting. */
  curve: { x: Float64Array; s1: Float64Array; s2: Float64Array; diff: Float64Array };
  /** Signal of an arbitrary tissue at an arbitrary value of the optimised variable. */
  signalAt: (tissue: Tissue, value: number) => number;
}

const GOLDEN = (Math.sqrt(5) - 1) / 2;

/** Maximise f on [lo, hi]: coarse grid to pick the right lobe, golden-section to refine. */
export function maximise(f: (x: number) => number, lo: number, hi: number, samples = 2000): number {
  let best = lo;
  let bestValue = -Infinity;
  const step = (hi - lo) / samples;
  for (let i = 0; i <= samples; i++) {
    const x = lo + i * step;
    const v = f(x);
    if (v > bestValue) {
      bestValue = v;
      best = x;
    }
  }
  let a = Math.max(lo, best - step);
  let b = Math.min(hi, best + step);
  let c = b - GOLDEN * (b - a);
  let d = a + GOLDEN * (b - a);
  let fc = f(c);
  let fd = f(d);
  for (let i = 0; i < 80 && b - a > 1e-10 * (1 + Math.abs(a)); i++) {
    if (fc > fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - GOLDEN * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + GOLDEN * (b - a);
      fd = f(d);
    }
  }
  return (a + b) / 2;
}

/**
 * Find the flip angle, TR or TE with the largest signal difference between two tissues.
 * Throws {@link InvalidInputError} for inputs that cannot be computed (see checkContrast).
 */
export function optimiseContrast(input: ContrastInput): ContrastResult {
  const [a, b] = input.tissues;
  const warnings = assertValid(checkContrast(input));
  let signalAt: (t: Tissue, v: number) => number;
  let lo: number;
  let hi: number;
  let variable: ContrastResult['variable'];

  switch (input.mode) {
    case 'gre': {
      const te = input.te ?? 0;
      const tr = input.tr ?? 0;
      signalAt = (t, deg) => spgrSignal(t.pd, t.t1, t.t2, tr, te, deg * DEG);
      lo = 0;
      hi = 90;
      variable = { name: 'flip angle', symbol: 'α', unit: '°' };
      break;
    }
    case 'se-t1': {
      const te = input.te ?? 0;
      signalAt = (t, tr) => spinEchoSignal(t.pd, t.t1, t.t2, tr, te);
      // TR cannot be shorter than TE.
      lo = te;
      hi = Math.max(5 * Math.max(a.t1, b.t1), 2 * te);
      variable = { name: 'TR', symbol: 'TR', unit: 'ms' };
      if (te > 30) {
        warnings.push(
          `TE (${te} ms) is long for T1-weighted imaging; T2 decay will mix into the contrast.`,
        );
      }
      break;
    }
    case 'se-t2': {
      const tr = input.tr ?? 0;
      signalAt = (t, te) => spinEchoSignal(t.pd, t.t1, t.t2, tr, te);
      // TE cannot be longer than TR.
      lo = 0;
      hi = Math.min(5 * Math.max(a.t2, b.t2), tr);
      variable = { name: 'TE', symbol: 'TE', unit: 'ms' };
      if (tr <= 2000) {
        warnings.push(
          `TR (${tr} ms) is short for T2-weighted imaging (2000 ms or less); T1 weighting will mix into the contrast.`,
        );
      }
      break;
    }
  }

  const absDiff = (v: number): number => Math.abs(signalAt(a, v) - signalAt(b, v));
  const optimum = maximise(absDiff, lo, hi);
  const s1 = signalAt(a, optimum);
  const s2 = signalAt(b, optimum);

  const span = hi - lo;
  if (input.mode !== 'gre') {
    if (optimum - lo < 1e-3 * span) {
      warnings.push(
        `The largest difference is at the shortest ${variable.symbol} allowed, so there is no useful optimum. Check the other timing parameter and the tissue values.`,
      );
    } else if (hi - optimum < 1e-3 * span) {
      warnings.push(
        `The difference keeps growing with ${variable.symbol}; the value shown is the edge of the search range (${hi.toFixed(0)} ms).`,
      );
    }
  }

  const n = 361;
  const x = linspace(lo, hi, n);
  const c1 = new Float64Array(n);
  const c2 = new Float64Array(n);
  const diff = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    c1[i] = signalAt(a, x[i]!);
    c2[i] = signalAt(b, x[i]!);
    diff[i] = Math.abs(c1[i]! - c2[i]!);
  }

  return {
    mode: input.mode,
    variable,
    optimum,
    signals: [s1, s2],
    difference: Math.abs(s1 - s2),
    ratio: Math.max(s1, s2) / Math.min(s1, s2),
    warnings,
    curve: { x, s1: c1, s2: c2, diff },
    signalAt,
  };
}
