/**
 * Brute-force least squares for the curve-fitting models, written from the
 * model equations rather than from src/fit/lm.ts, so that the two can check
 * each other.
 *
 * The non-linear parameters, the rate k (log-spaced over the search range)
 * and, for the imperfect-inversion model, A (evenly spaced on [0, 2]), run
 * over a dense grid. At each grid point the model is linear in M0 and C
 * (|M0 g| = |M0| |g| for magnitude data), solved in closed form, and the sum
 * of squared residuals is computed from the residuals. Every grid point is a
 * feasible fit, so the true minimum is at or below the grid's: a fitter that
 * finds the global minimum is never above it.
 */

export type Model = 'dwi' | 't1ir' | 't1ir-a' | 't1vfa' | 't2';

export interface Problem {
  model: Model;
  x: readonly number[];
  y: readonly number[];
  tr?: number;
  magnitude?: boolean;
  fitConstant?: boolean;
  /** Search range of the fitted parameter in its own unit (T1, T2 in ms; D in mm²/s). */
  range: readonly [number, number];
}

export interface BruteMinimum {
  sse: number;
  /** Fitted parameter (T1, T2 or D) and A at the grid minimum. */
  param: number;
  a: number;
}

/** g(x; k, A) of each model; k is 1/T1, 1/T2 or D. */
export function basis(model: Model, x: number, k: number, a: number, tr: number): number {
  switch (model) {
    case 't2':
    case 'dwi':
      return Math.exp(-x * k);
    case 't1ir':
    case 't1ir-a': {
      const eTr = Number.isFinite(tr) ? Math.exp(-tr * k) : 0;
      return 1 - 2 * a * Math.exp(-x * k) + (2 * a - 1) * eTr;
    }
    case 't1vfa': {
      const e1 = Math.exp(-tr * k);
      const alpha = (x * Math.PI) / 180;
      return (Math.sin(alpha) * (1 - e1)) / (1 - Math.cos(alpha) * e1);
    }
  }
}

/**
 * Least-squares sum of squares of y on mu·h (+ c), mu ≥ 0 when `nonneg`;
 * returns [sse, mu, c].
 */
export function linearFit(
  h: readonly number[],
  y: readonly number[],
  intercept: boolean,
  nonneg: boolean,
): [number, number, number] {
  const n = y.length;
  let mu = 0;
  let c = 0;
  if (intercept) {
    const hb = h.reduce((s, v) => s + v, 0) / n;
    const yb = y.reduce((s, v) => s + v, 0) / n;
    let shh = 0;
    let shy = 0;
    for (let i = 0; i < n; i++) {
      shh += (h[i]! - hb) ** 2;
      shy += (h[i]! - hb) * (y[i]! - yb);
    }
    mu = shh > 1e-24 * n * hb * hb ? shy / shh : 0;
    if (nonneg && mu < 0) mu = 0;
    c = yb - mu * hb;
  } else {
    let shh = 0;
    let shy = 0;
    for (let i = 0; i < n; i++) {
      shh += h[i]! * h[i]!;
      shy += h[i]! * y[i]!;
    }
    mu = shh > 0 ? shy / shh : 0;
    if (nonneg && mu < 0) mu = 0;
  }
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (y[i]! - mu * h[i]! - c) ** 2;
  return [sse, mu, c];
}

/** Sum of squares at rate k and efficiency a, with M0 and C solved. */
export function sseAt(p: Problem, k: number, a: number): number {
  const tr = p.tr !== undefined && p.tr > 0 ? p.tr : Infinity;
  const mag = (p.magnitude ?? false) && (p.model === 't1ir' || p.model === 't1ir-a');
  const y = mag ? p.y.map(Math.abs) : p.y;
  const h = p.x.map((xi) => {
    const g = basis(p.model, xi, k, a, tr);
    return mag ? Math.abs(g) : g;
  });
  return linearFit(h, y, p.fitConstant ?? false, mag)[0];
}

/** The rate of a parameter value (D is a rate; T1 and T2 are its inverse). */
export const rateOf = (model: Model, param: number): number =>
  model === 'dwi' ? param : 1 / param;

/** Grid minimum over `rates` log-spaced rates and (t1ir-a) `effs` values of A. */
export function bruteForce(p: Problem, rates = 2000, effs = 101): BruteMinimum {
  const n = p.x.length;
  const tr = p.tr !== undefined && p.tr > 0 ? p.tr : Infinity;
  const mag = (p.magnitude ?? false) && (p.model === 't1ir' || p.model === 't1ir-a');
  const y = mag ? p.y.map(Math.abs) : [...p.y];
  const k1 = rateOf(p.model, p.range[0]);
  const k2 = rateOf(p.model, p.range[1]);
  const lo = Math.log(Math.min(k1, k2));
  const hi = Math.log(Math.max(k1, k2));
  const as =
    p.model === 't1ir-a' ? Array.from({ length: effs }, (_, i) => (2 * i) / (effs - 1)) : [1];
  const h = new Array<number>(n);
  let best: BruteMinimum = { sse: Infinity, param: NaN, a: NaN };
  for (let j = 0; j < rates; j++) {
    const k = Math.exp(lo + ((hi - lo) * j) / (rates - 1));
    for (const a of as) {
      for (let i = 0; i < n; i++) {
        const g = basis(p.model, p.x[i]!, k, a, tr);
        h[i] = mag ? Math.abs(g) : g;
      }
      const sse = linearFit(h, y, p.fitConstant ?? false, mag)[0];
      if (sse < best.sse) best = { sse, param: p.model === 'dwi' ? k : 1 / k, a };
    }
  }
  return best;
}
