/**
 * Non-linear least squares for the separable signal models in ./models.
 *
 * Every model has the form  S(x) = M0 · g(x; k, A) + C  with one rate k
 * (1/T1, 1/T2 or D), optionally an inversion efficiency A, and linear
 * parameters M0 and C. Fitting runs in two stages:
 *
 *  1. Variable projection on a log-spaced grid of k. The basis g(x; k) is the
 *     same for every voxel, so it is tabulated once and each grid point costs
 *     one dot product per voxel. This gives a start that is robust to noise
 *     and to the sign ambiguity of magnitude inversion recovery.
 *  2. Levenberg–Marquardt refinement with analytic Jacobians.
 *
 * A Fitter owns all its work arrays; fitting allocates nothing, which keeps
 * pixel-wise mapping free of garbage-collection pauses.
 */
import { DEG } from '../signal.js';
import { assertValid, checkFit } from '../validate.js';
import { MODELS, type FitOptions, type ModelDef, type ModelId } from './models.js';

/** Layout of the result vector written by {@link Fitter.fit}. */
export const OUT = { param: 0, m0: 1, a: 2, c: 3, sse: 4, r2: 5, iterations: 6, size: 7 } as const;

const GRID = 48;
const MAX_ITER = 60;

export interface InitialGuess {
  /** Primary parameter in user units (T1, T2 or D). */
  param: number;
  m0: number;
  a?: number;
  c?: number;
}

export class Fitter {
  readonly model: ModelDef;
  readonly n: number;
  /** Number of fitted parameters. */
  readonly m: number;
  readonly fitA: boolean;
  readonly fitC: boolean;
  private readonly x: Float64Array;
  private readonly tr: number;
  /** Inputs that can be fitted but look unintended (see checkFit). */
  readonly warnings: string[];
  private readonly magnitude: boolean;
  /** |y| of the curve being fitted, when fitting magnitudes. */
  private readonly absY: Float64Array;
  private readonly kMin: number;
  private readonly kMax: number;
  private readonly sinA: Float64Array;
  private readonly cosA: Float64Array;
  // Grid tables.
  private readonly gridK = new Float64Array(GRID);
  private readonly gridG: Float64Array;
  private readonly gridSg = new Float64Array(GRID);
  private readonly gridSgg = new Float64Array(GRID);
  // Work arrays.
  private readonly g: Float64Array;
  private readonly dgk: Float64Array;
  private readonly dga: Float64Array;
  private readonly sgn: Float64Array;
  private readonly res: Float64Array;
  private readonly jac: Float64Array;
  private readonly jtj: Float64Array;
  private readonly jtr: Float64Array;
  private readonly lhs: Float64Array;
  private readonly delta: Float64Array;
  private readonly p: Float64Array;
  private readonly trial: Float64Array;

  /**
   * Throws InvalidInputError when the x values or options cannot be fitted
   * (see checkFit), and a plain Error when there are too few points.
   */
  constructor(modelId: ModelId, x: ArrayLike<number>, options: FitOptions = {}) {
    this.warnings = assertValid(checkFit(modelId, x, options));
    const model = MODELS[modelId];
    this.model = model;
    this.n = x.length;
    this.x = Float64Array.from(x);
    this.tr = options.tr !== undefined && options.tr > 0 ? options.tr : Infinity;
    if (model.kind === 'vfa' && !Number.isFinite(this.tr)) {
      throw new Error('Variable flip angle fitting needs a repetition time (TR).');
    }
    this.fitA = model.fitA;
    this.fitC = options.fitConstant ?? false;
    this.magnitude = (options.magnitude ?? false) && model.kind === 'ir';
    this.m = 2 + (this.fitA ? 1 : 0) + (this.fitC ? 1 : 0);
    if (this.n < this.m) {
      throw new Error(
        `This model has ${this.m} free parameters and needs at least ${this.m} data points; ${this.n} given.`,
      );
    }
    const [lo, hi] = options.range ?? model.range;
    if (!(lo > 0) || !(hi > lo))
      throw new Error('The parameter search range must be positive and increasing.');
    this.kMin = model.rateIsParam ? lo : 1 / hi;
    this.kMax = model.rateIsParam ? hi : 1 / lo;

    const n = this.n;
    this.sinA = new Float64Array(n);
    this.cosA = new Float64Array(n);
    if (model.kind === 'vfa') {
      for (let i = 0; i < n; i++) {
        this.sinA[i] = Math.sin(this.x[i]! * DEG);
        this.cosA[i] = Math.cos(this.x[i]! * DEG);
      }
    }
    this.absY = new Float64Array(n);
    this.g = new Float64Array(n);
    this.dgk = new Float64Array(n);
    this.dga = new Float64Array(n);
    this.sgn = new Float64Array(n).fill(1);
    this.res = new Float64Array(n);
    this.jac = new Float64Array(n * this.m);
    this.jtj = new Float64Array(this.m * this.m);
    this.jtr = new Float64Array(this.m);
    this.lhs = new Float64Array(this.m * this.m);
    this.delta = new Float64Array(this.m);
    this.p = new Float64Array(4);
    this.trial = new Float64Array(4);

    this.gridG = new Float64Array(GRID * n);
    const logLo = Math.log(this.kMin);
    const logHi = Math.log(this.kMax);
    for (let j = 0; j < GRID; j++) {
      const k = Math.exp(logLo + ((logHi - logLo) * j) / (GRID - 1));
      this.gridK[j] = k;
      this.basis(k, 1, false);
      let sg = 0;
      let sgg = 0;
      for (let i = 0; i < n; i++) {
        const v = this.magnitude ? Math.abs(this.g[i]!) : this.g[i]!;
        this.gridG[j * n + i] = v;
        sg += v;
        sgg += v * v;
      }
      this.gridSg[j] = sg;
      this.gridSgg[j] = sgg;
    }
  }

  /** Evaluate g (and optionally its derivatives) for rate k and efficiency a. */
  private basis(k: number, a: number, derivatives: boolean): void {
    const { x, g, dgk, dga, n, tr } = this;
    switch (this.model.kind) {
      case 'exp':
        for (let i = 0; i < n; i++) {
          const e = Math.exp(-x[i]! * k);
          g[i] = e;
          if (derivatives) dgk[i] = -x[i]! * e;
        }
        break;
      case 'ir': {
        const eTr = Number.isFinite(tr) ? Math.exp(-tr * k) : 0;
        const dTr = Number.isFinite(tr) ? -tr * eTr : 0;
        for (let i = 0; i < n; i++) {
          const e = Math.exp(-x[i]! * k);
          g[i] = 1 - 2 * a * e + eTr;
          if (derivatives) {
            dgk[i] = 2 * a * x[i]! * e + dTr;
            dga[i] = -2 * e;
          }
        }
        break;
      }
      case 'vfa': {
        const e1 = Math.exp(-tr * k);
        for (let i = 0; i < n; i++) {
          const s = this.sinA[i]!;
          const c = this.cosA[i]!;
          const den = 1 - c * e1;
          g[i] = (s * (1 - e1)) / den;
          if (derivatives) dgk[i] = ((s * (c - 1)) / (den * den)) * (-tr * e1);
        }
        break;
      }
    }
  }

  /** Model value S(x_i) for the given parameter vector [k, M0, A, C]; returns the SSE. */
  private residuals(
    p: Float64Array,
    y: ArrayLike<number>,
    offset: number,
    derivatives: boolean,
  ): number {
    const { n, g, res, sgn } = this;
    this.basis(p[0]!, p[2]!, derivatives);
    const m0 = p[1]!;
    const c = p[3]!;
    let sse = 0;
    for (let i = 0; i < n; i++) {
      let gi = g[i]!;
      if (this.magnitude) {
        // |M0 g|: keep the sign so the Jacobian follows the rectified branch.
        const s = m0 * gi < 0 ? -1 : 1;
        sgn[i] = s;
        gi *= s;
        g[i] = gi;
      }
      const r = y[offset + i]! - (m0 * gi + c);
      res[i] = r;
      sse += r * r;
    }
    return sse;
  }

  private gridStart(y: ArrayLike<number>, offset: number): void {
    const { n, gridG, gridSg, gridSgg, p } = this;
    let sy = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
      const v = y[offset + i]!;
      sy += v;
      syy += v * v;
    }
    let best = Infinity;
    let bestK = this.gridK[0]!;
    let bestM0 = 0;
    let bestC = 0;
    for (let j = 0; j < GRID; j++) {
      let sgy = 0;
      const row = j * n;
      for (let i = 0; i < n; i++) sgy += gridG[row + i]! * y[offset + i]!;
      const sgg = gridSgg[j]!;
      let m0: number;
      let c = 0;
      if (this.fitC) {
        const sg = gridSg[j]!;
        const det = sgg * n - sg * sg;
        if (Math.abs(det) < 1e-12 * sgg * n) continue;
        m0 = (sgy * n - sg * sy) / det;
        c = (sgg * sy - sg * sgy) / det;
      } else {
        if (sgg === 0) continue;
        m0 = sgy / sgg;
      }
      if (this.magnitude && m0 < 0) continue;
      // SSE of the projected linear fit.
      const sse =
        syy - 2 * m0 * sgy - 2 * c * sy + m0 * m0 * sgg + 2 * m0 * c * gridSg[j]! + n * c * c;
      if (sse < best) {
        best = sse;
        bestK = this.gridK[j]!;
        bestM0 = m0;
        bestC = c;
      }
    }
    p[0] = bestK;
    p[1] = bestM0;
    p[2] = 1;
    p[3] = bestC;
  }

  /**
   * Fit one curve. `y[offset .. offset+n)` holds the measurements.
   * Results go to `out[outOffset ..]` using the {@link OUT} layout.
   * Returns false when the fit failed (non-finite data or result).
   * With the magnitude option the magnitude of every measurement is fitted,
   * so signed data (for example phase-sensitive images) are accepted too.
   */
  fit(
    y: ArrayLike<number>,
    offset: number,
    out: Float64Array | Float32Array,
    outOffset = 0,
    init?: InitialGuess,
  ): boolean {
    const { n, m, p, trial, jac, jtj, jtr, lhs, delta, res, g, dgk, dga, sgn } = this;
    if (this.magnitude) {
      for (let i = 0; i < n; i++) this.absY[i] = Math.abs(y[offset + i]!);
      y = this.absY;
      offset = 0;
    }
    if (init) {
      const k = this.model.rateIsParam ? init.param : 1 / init.param;
      p[0] = Math.min(this.kMax, Math.max(this.kMin, k));
      p[1] = init.m0;
      p[2] = this.fitA ? (init.a ?? 1) : 1;
      p[3] = this.fitC ? (init.c ?? 0) : 0;
    } else {
      this.gridStart(y, offset);
    }

    const aCol = this.fitA ? 2 : -1;
    const cCol = this.fitC ? (this.fitA ? 3 : 2) : -1;
    let sse = this.residuals(p, y, offset, true);
    if (!Number.isFinite(sse)) return false;
    let lambda = 1e-3;
    let iterations = 0;

    for (; iterations < MAX_ITER; iterations++) {
      // Jacobian of the model with respect to [k, M0, (A), (C)].
      const m0 = p[1]!;
      for (let i = 0; i < n; i++) {
        const row = i * m;
        const s = sgn[i]!;
        jac[row] = m0 * s * dgk[i]!;
        jac[row + 1] = g[i]!; // already sign-corrected
        if (aCol >= 0) jac[row + aCol] = m0 * s * dga[i]!;
        if (cCol >= 0) jac[row + cCol] = 1;
      }
      jtj.fill(0);
      jtr.fill(0);
      for (let i = 0; i < n; i++) {
        const row = i * m;
        const r = res[i]!;
        for (let a = 0; a < m; a++) {
          const ja = jac[row + a]!;
          jtr[a] = jtr[a]! + ja * r;
          for (let b = a; b < m; b++) jtj[a * m + b] = jtj[a * m + b]! + ja * jac[row + b]!;
        }
      }
      for (let a = 0; a < m; a++) for (let b = 0; b < a; b++) jtj[a * m + b] = jtj[b * m + a]!;

      let improved = false;
      let converged = false;
      for (let attempt = 0; attempt < 12; attempt++) {
        lhs.set(jtj);
        for (let a = 0; a < m; a++) {
          const d = jtj[a * m + a]!;
          lhs[a * m + a] = d + lambda * (d > 0 ? d : 1);
        }
        delta.set(jtr);
        if (!solveSymmetric(lhs, delta, m)) {
          lambda *= 8;
          continue;
        }
        trial[0] = Math.min(this.kMax, Math.max(this.kMin, p[0]! + delta[0]!));
        trial[1] = p[1]! + delta[1]!;
        trial[2] = aCol >= 0 ? Math.min(2, Math.max(0, p[2]! + delta[aCol]!)) : 1;
        trial[3] = cCol >= 0 ? p[3]! + delta[cCol]! : 0;
        const trialSse = this.residuals(trial, y, offset, true);
        if (Number.isFinite(trialSse) && trialSse <= sse) {
          let step = 0;
          for (let a = 0; a < 4; a++) {
            step = Math.max(step, Math.abs(trial[a]! - p[a]!) / (Math.abs(p[a]!) + 1e-12));
          }
          converged = sse - trialSse <= 1e-10 * sse || step < 1e-8;
          p.set(trial);
          sse = trialSse;
          lambda = Math.max(lambda / 5, 1e-12);
          improved = true;
          break;
        }
        lambda *= 4;
      }
      if (!improved) {
        // No downhill step: restore the work arrays for the current point and stop.
        this.residuals(p, y, offset, true);
        break;
      }
      if (converged) {
        iterations++;
        break;
      }
    }

    let mean = 0;
    for (let i = 0; i < n; i++) mean += y[offset + i]!;
    mean /= n;
    let sst = 0;
    for (let i = 0; i < n; i++) sst += (y[offset + i]! - mean) ** 2;

    const param = this.model.rateIsParam ? p[0]! : 1 / p[0]!;
    out[outOffset + OUT.param] = param;
    out[outOffset + OUT.m0] = p[1]!;
    out[outOffset + OUT.a] = p[2]!;
    out[outOffset + OUT.c] = p[3]!;
    out[outOffset + OUT.sse] = sse;
    out[outOffset + OUT.r2] = sst > 0 ? 1 - sse / sst : 0;
    out[outOffset + OUT.iterations] = iterations;
    return Number.isFinite(param) && Number.isFinite(p[1]!);
  }

  /**
   * Standard errors [param, M0, A, C] at the solution of the most recent
   * {@link fit} call (NaN where a parameter is not fitted or n == m).
   */
  standardErrors(sse: number): [number, number, number, number] {
    const { n, m, jac, p } = this;
    const nan: [number, number, number, number] = [NaN, NaN, NaN, NaN];
    if (n <= m) return nan;
    // The work arrays hold g / dg for the accepted point; rebuild J and invert JᵀJ.
    const a = new Float64Array(m * m);
    const m0 = p[1]!;
    const aCol = this.fitA ? 2 : -1;
    const cCol = this.fitC ? (this.fitA ? 3 : 2) : -1;
    for (let i = 0; i < n; i++) {
      const row = i * m;
      const s = this.sgn[i]!;
      jac[row] = m0 * s * this.dgk[i]!;
      jac[row + 1] = this.g[i]!;
      if (aCol >= 0) jac[row + aCol] = m0 * s * this.dga[i]!;
      if (cCol >= 0) jac[row + cCol] = 1;
      for (let u = 0; u < m; u++)
        for (let v = 0; v < m; v++) a[u * m + v] = a[u * m + v]! + jac[row + u]! * jac[row + v]!;
    }
    const variance = sse / (n - m);
    const diag: number[] = [];
    for (let j = 0; j < m; j++) {
      const lhs = Float64Array.from(a);
      const e = new Float64Array(m);
      e[j] = 1;
      if (!solveSymmetric(lhs, e, m)) return nan;
      diag.push(Math.sqrt(Math.max(0, variance * e[j]!)));
    }
    const k = p[0]!;
    const seParam = this.model.rateIsParam ? diag[0]! : diag[0]! / (k * k);
    return [seParam, diag[1]!, aCol >= 0 ? diag[aCol]! : NaN, cCol >= 0 ? diag[cCol]! : NaN];
  }
}

/** Solve A·x = b in place for a small symmetric positive-definite A (Cholesky). */
function solveSymmetric(a: Float64Array, b: Float64Array, m: number): boolean {
  for (let j = 0; j < m; j++) {
    let d = a[j * m + j]!;
    for (let k = 0; k < j; k++) d -= a[j * m + k]! ** 2;
    if (!(d > 0)) return false;
    d = Math.sqrt(d);
    a[j * m + j] = d;
    for (let i = j + 1; i < m; i++) {
      let s = a[i * m + j]!;
      for (let k = 0; k < j; k++) s -= a[i * m + k]! * a[j * m + k]!;
      a[i * m + j] = s / d;
    }
  }
  for (let i = 0; i < m; i++) {
    let s = b[i]!;
    for (let k = 0; k < i; k++) s -= a[i * m + k]! * b[k]!;
    b[i] = s / a[i * m + i]!;
  }
  for (let i = m - 1; i >= 0; i--) {
    let s = b[i]!;
    for (let k = i + 1; k < m; k++) s -= a[k * m + i]! * b[k]!;
    b[i] = s / a[i * m + i]!;
  }
  return true;
}

/** Evaluate a fitted model at arbitrary x for plotting. */
export function evaluateModel(
  modelId: ModelId,
  x: ArrayLike<number>,
  fit: { param: number; m0: number; a: number; c: number },
  options: FitOptions = {},
): Float64Array {
  const model = MODELS[modelId];
  const k = model.rateIsParam ? fit.param : 1 / fit.param;
  const tr = options.tr !== undefined && options.tr > 0 ? options.tr : Infinity;
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const xi = x[i]!;
    let g: number;
    switch (model.kind) {
      case 'exp':
        g = Math.exp(-xi * k);
        break;
      case 'ir':
        g = 1 - 2 * fit.a * Math.exp(-xi * k) + (Number.isFinite(tr) ? Math.exp(-tr * k) : 0);
        break;
      case 'vfa': {
        const e1 = Math.exp(-tr * k);
        g = (Math.sin(xi * DEG) * (1 - e1)) / (1 - Math.cos(xi * DEG) * e1);
        break;
      }
    }
    const s = fit.m0 * g;
    out[i] = (options.magnitude && model.kind === 'ir' ? Math.abs(s) : s) + fit.c;
  }
  return out;
}
