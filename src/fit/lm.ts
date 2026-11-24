/**
 * Non-linear least squares for the separable signal models in ./models.
 *
 * Every model has the form  S(x) = M0 · g(x; k, A) + C  with one rate k
 * (1/T1, 1/T2 or D), optionally an inversion efficiency A, and linear
 * parameters M0 and C; with magnitude data it is |M0 · g| + C.
 *
 * At a fixed rate the other parameters enter linearly (M0 and C; for the
 * imperfect-inversion model M0 and A·M0), so their least-squares values have
 * a closed form and the sum of squares becomes a function of k alone, the
 * profile φ(k) (variable projection: Golub and Pereyra, SIAM J Numer Anal
 * 1973;10:413-432). The fit returns the lowest φ over the search range:
 *
 *  1. φ on a log-spaced grid of k. The exponentials are tabulated once per
 *     Fitter, so each grid point costs a few passes over the data.
 *  2. Brent's minimisation in ln k (golden section with parabolic
 *     interpolation; R. P. Brent, Algorithms for Minimization without
 *     Derivatives, 1973, chapter 5) from every local minimum of the grid,
 *     and from the initial value when one is given.
 *  3. The lowest minimum wins. When φ is lowest at an end of the range the
 *     estimate is that bound.
 *
 * Magnitude inversion recovery. g increases with TI whenever A ≥ 0, so over
 * the sorted inversion times M0·g is negative at the first p points and
 * positive after (p = 0..n). Fitting |M0 g| + C with those signs is a signed
 * problem on polarity-restored data (Barral et al., Magn Reson Med
 * 2010;64:1057-1067), linear at a fixed rate. Where a measurement lies near
 * the null, φ has a peak at the rate that puts the null on it and a minimum
 * close on either side, often closer than any affordable grid spacing; but
 * each pattern's own profile is smooth there. So each pattern's profile is
 * searched on its own (with 0 ≤ A ≤ 2 and M0 ≥ 0), and a minimum counts only
 * if its signs match the pattern. With an offset the minimum can also sit
 * where one g vanishes (there (y − C − |M0 g|)² can have a corner, as y − C
 * may be negative); for the imperfect-inversion model those are searched
 * too, one profile per point, and for A = 1 they are fixed rates, evaluated
 * directly. Without an offset they cannot be minima: there (y − |M0 g|)² has
 * a peak, since y ≥ 0.
 *
 * The constants below were chosen by measurement (scripts/fit-study.mjs, on
 * 276,000 synthetic curves per seed: every model and option of the curve
 * fitting tool, minimal protocols, offsets, magnitude data, SNR 5 to 200).
 * At 16 grid points per decade no estimate moved against a grid of 512 per
 * decade (seeds 2 and 3; 8 per decade moved 1 and 4 per decade 16), with or
 * without the sign-match pruning. At REFINE_TOL = 1e-9, 99.9 % of estimates
 * lie within 5e-8 (relative) of those at 1e-13; the tools display four
 * significant digits. The rest are flat profiles, such as T2 against a
 * constant at the 1 ms bound, whose minimum the data do not define.
 *
 * A Fitter owns all its work arrays; fitting allocates nothing, which keeps
 * pixel-wise mapping free of garbage-collection pauses.
 */
import { DEG } from '../signal.js';
import { assertValid, checkFit } from '../validate.js';
import { MODELS, type FitOptions, type ModelDef, type ModelId } from './models.js';

/** Layout of the result vector written by {@link Fitter.fit}. */
export const OUT = { param: 0, m0: 1, a: 2, c: 3, sse: 4, r2: 5, iterations: 6, size: 7 } as const;

/** Profile grid points per decade of the rate (scripts/fit-study.mjs). */
const POINTS_PER_DECADE = 16;
const MIN_POINTS = 8;
/** Brent's tolerance in ln k, i.e. the relative precision of the estimate (scripts/fit-study.mjs). */
const REFINE_TOL = 1e-9;
const REFINE_MAX_ITER = 200;
/** A pattern's grid minimum is refined when its signs match within this many grid points (scripts/fit-study.mjs). */
const SIGN_NEAR = 2;
const GOLDEN = (3 - Math.sqrt(5)) / 2;

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
  /** Indices of x in increasing order, and the position of each point in it. */
  private readonly order: Int32Array;
  private readonly rank: Int32Array;
  /**
   * Profiles searched: 1 (φ itself), or for magnitude inversion recovery one
   * per polarity pattern, plus (A and C fitted) one per point where g vanishes.
   */
  private readonly branches: number;
  private readonly patterns: number;
  /** Magnitude, A = 1, offset: the rates (in range) at which one g vanishes. */
  private readonly nullRates: Float64Array;
  // Profile grid: ln k, k, per point e^(-x k) (exp, ir) or g (vfa), e^(-TR k),
  // and per point and branch the profile and whether its signs match.
  private readonly nGrid: number;
  private readonly gridU: Float64Array;
  private readonly gridK: Float64Array;
  private readonly gridRow: Float64Array;
  private readonly gridETr: Float64Array;
  private readonly gridPhi: Float64Array;
  private readonly gridOk: Uint8Array;
  // Work arrays and the results of the last profile evaluation.
  private readonly row: Float64Array;
  private readonly h: Float64Array;
  private readonly v: Float64Array;
  private readonly sol: Float64Array;
  private readonly gram: Float64Array;
  private linMu = 0;
  private linC = 0;
  private pM0 = 0;
  private pA = 1;
  private pC = 0;
  private ok = true;
  // Sums over the data at the current rate (inversion recovery, magnitude).
  private readonly preY: Float64Array;
  private readonly preVY: Float64Array;
  private readonly preV: Float64Array;
  private curY: ArrayLike<number> = [];
  private curYo = 0;
  private irU = 0;
  private sy = 0;
  private sv = 0;
  private svv = 0;
  private svy = 0;
  private cvv = 0;
  // Result of the last refinement.
  private refU = 0;
  private refSse = 0;
  private refOk = true;
  private refIter = 0;
  // Model work arrays at the solution (for standardErrors).
  private readonly g: Float64Array;
  private readonly dgk: Float64Array;
  private readonly dga: Float64Array;
  private readonly sgn: Float64Array;
  private readonly res: Float64Array;
  private readonly jac: Float64Array;
  private readonly p: Float64Array;

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
    this.order = Int32Array.from(
      Array.from({ length: n }, (_, i) => i).sort((a, b) => this.x[a]! - this.x[b]! || a - b),
    );
    this.rank = new Int32Array(n);
    for (let r = 0; r < n; r++) this.rank[this.order[r]!] = r;
    this.patterns = this.magnitude ? n + 1 : 0;
    this.branches = this.magnitude ? n + 1 + (this.fitA && this.fitC ? n : 0) : 1;
    this.absY = new Float64Array(n);
    this.row = new Float64Array(n);
    this.h = new Float64Array(n);
    this.v = new Float64Array(n);
    this.sol = new Float64Array(3);
    this.gram = new Float64Array(9);
    this.preY = new Float64Array(n + 1);
    this.preVY = new Float64Array(n + 1);
    this.preV = new Float64Array(n + 1);
    this.g = new Float64Array(n);
    this.dgk = new Float64Array(n);
    this.dga = new Float64Array(n);
    this.sgn = new Float64Array(n).fill(1);
    this.res = new Float64Array(n);
    this.jac = new Float64Array(n * this.m);
    this.p = new Float64Array(4);

    const logLo = Math.log(this.kMin);
    const logHi = Math.log(this.kMax);
    const decades = Math.log10(this.kMax / this.kMin);
    const points = Math.max(MIN_POINTS, Math.ceil(POINTS_PER_DECADE * decades) + 1);
    this.nGrid = points;
    this.gridU = new Float64Array(points);
    this.gridK = new Float64Array(points);
    this.gridRow = new Float64Array(points * n);
    this.gridETr = new Float64Array(points);
    this.gridPhi = new Float64Array(points * this.branches);
    this.gridOk = new Uint8Array(points * this.branches);
    for (let j = 0; j < points; j++) {
      // The ends are the bounds exactly, so a minimum at a bound is reported at it.
      const last = j === points - 1;
      const u = j === 0 ? logLo : last ? logHi : logLo + ((logHi - logLo) * j) / (points - 1);
      const k = j === 0 ? this.kMin : last ? this.kMax : Math.exp(u);
      this.gridU[j] = u;
      this.gridK[j] = k;
      this.gridETr[j] = this.tabulate(k, this.gridRow, j * n);
    }

    // g = 1 - 2 e^(-TI k) + e^(-TR k) vanishes at most once in k > 0 (it starts at 0,
    // falls while TI < TR/2 and rises to 1), so a change of sign over the range brackets it.
    const nulls: number[] = [];
    if (this.magnitude && !this.fitA && this.fitC) {
      const gAt = (xi: number, k: number): number =>
        1 - 2 * Math.exp(-xi * k) + (Number.isFinite(this.tr) ? Math.exp(-this.tr * k) : 0);
      for (let i = 0; i < n; i++) {
        let a = logLo;
        let b = logHi;
        const ga = gAt(this.x[i]!, this.kMin);
        if (!(ga * gAt(this.x[i]!, this.kMax) < 0)) continue;
        for (let it = 0; it < 200 && b - a > 1e-15 * Math.max(1, Math.abs(a)); it++) {
          const mid = 0.5 * (a + b);
          if (gAt(this.x[i]!, Math.exp(mid)) * ga > 0) a = mid;
          else b = mid;
        }
        nulls.push(0.5 * (a + b));
      }
    }
    this.nullRates = Float64Array.from(nulls);
  }

  /**
   * Write the rate-dependent part of the basis at rate k into row[off ..]:
   * e^(-x k) for the exponential and inversion-recovery models, g for VFA.
   * Returns e^(-TR k) (0 when TR is infinite or not used).
   */
  private tabulate(k: number, row: Float64Array, off: number): number {
    const { x, n, tr } = this;
    switch (this.model.kind) {
      case 'exp':
        for (let i = 0; i < n; i++) row[off + i] = Math.exp(-x[i]! * k);
        return 0;
      case 'ir':
        for (let i = 0; i < n; i++) row[off + i] = Math.exp(-x[i]! * k);
        return Number.isFinite(tr) ? Math.exp(-tr * k) : 0;
      case 'vfa': {
        const e1 = Math.exp(-tr * k);
        for (let i = 0; i < n; i++) {
          row[off + i] = (this.sinA[i]! * (1 - e1)) / (1 - this.cosA[i]! * e1);
        }
        return e1;
      }
    }
  }

  /**
   * Least squares of y on mu·h (+ c when `intercept`), with mu ≥ 0 when
   * `nonneg`. Sets linMu and linC; returns the sum of squared residuals.
   */
  private lin(
    h: Float64Array,
    ho: number,
    y: ArrayLike<number>,
    yo: number,
    intercept: boolean,
    nonneg: boolean,
  ): number {
    const n = this.n;
    let mu = 0;
    let c = 0;
    if (intercept) {
      let sh = 0;
      let sy = 0;
      for (let i = 0; i < n; i++) {
        sh += h[ho + i]!;
        sy += y[yo + i]!;
      }
      const hb = sh / n;
      const yb = sy / n;
      let shh = 0;
      let shy = 0;
      for (let i = 0; i < n; i++) {
        const d = h[ho + i]! - hb;
        shh += d * d;
        shy += d * (y[yo + i]! - yb);
      }
      // A constant h (to rounding) leaves only the mean.
      if (shh > 1e-20 * n * hb * hb) mu = shy / shh;
      if (nonneg && mu < 0) mu = 0;
      c = yb - mu * hb;
    } else {
      let shh = 0;
      let shy = 0;
      for (let i = 0; i < n; i++) {
        const hv = h[ho + i]!;
        shh += hv * hv;
        shy += hv * y[yo + i]!;
      }
      if (shh > 0) mu = shy / shh;
      if (nonneg && mu < 0) mu = 0;
    }
    let sse = 0;
    for (let i = 0; i < n; i++) {
      const r = y[yo + i]! - mu * h[ho + i]! - c;
      sse += r * r;
    }
    this.linMu = mu;
    this.linC = c;
    return sse;
  }

  /**
   * φ at one rate, exactly: the least-squares linear parameters for the
   * tabulated basis row[off ..] (see tabulate) go to pM0, pA and pC; returns
   * the sum of squared residuals.
   */
  private profile(
    row: Float64Array,
    off: number,
    eTr: number,
    y: ArrayLike<number>,
    yo: number,
  ): number {
    if (this.model.kind !== 'ir') {
      const sse = this.lin(row, off, y, yo, this.fitC, false);
      this.pM0 = this.linMu;
      this.pA = 1;
      this.pC = this.linC;
      return sse;
    }
    if (this.fitA) {
      return this.magnitude
        ? this.envelopeIrA(row, off, eTr, y, yo)
        : this.profileIrASigned(row, off, eTr, y, yo);
    }
    // A = 1: g = 1 - 2 e^(-TI k) + e^(-TR k); with magnitudes |M0 g| = |M0| |g|.
    const { n, h } = this;
    for (let i = 0; i < n; i++) {
      const gi = 1 - 2 * row[off + i]! + eTr;
      h[i] = this.magnitude ? Math.abs(gi) : gi;
    }
    const sse = this.lin(h, 0, y, yo, this.fitC, this.magnitude);
    this.pM0 = this.linMu;
    this.pA = 1;
    this.pC = this.linC;
    return sse;
  }

  /**
   * Imperfect inversion, signed data: M0 g = P u + Q v_i with u = 1 - e^(-TR k),
   * v_i = -2 (e^(-TI_i k) - e^(-TR k)), P = M0 and Q = A M0, 0 ≤ A ≤ 2.
   */
  private profileIrASigned(
    row: Float64Array,
    off: number,
    eTr: number,
    y: ArrayLike<number>,
    yo: number,
  ): number {
    const { n, v, h } = this;
    const u = 1 - eTr;
    for (let i = 0; i < n; i++) v[i] = -2 * (row[off + i]! - eTr);
    // P u is the same at every point, so the fit is a straight line in v.
    let best = this.lin(v, 0, y, yo, true, false);
    const q = this.linMu;
    const k0 = this.linC;
    if (this.fitC) {
      // The offset is a second constant: only Q and P u + C are identifiable. Report A = 1.
      this.pM0 = q;
      this.pA = 1;
      this.pC = k0 - q * u;
      return best;
    }
    const p = k0 / u;
    const a = q / p;
    if (p !== 0 && a >= 0 && a <= 2) {
      this.pM0 = p;
      this.pA = a;
      this.pC = 0;
      return best;
    }
    // Outside 0 ≤ A ≤ 2 the minimum lies on A = 0 or A = 2.
    best = Infinity;
    for (let face = 0; face <= 2; face += 2) {
      for (let i = 0; i < n; i++) h[i] = u + face * v[i]!;
      const sse = this.lin(h, 0, y, yo, false, false);
      if (sse < best) {
        best = sse;
        this.pM0 = this.linMu;
        this.pA = face;
        this.pC = 0;
      }
    }
    return best;
  }

  /**
   * Inversion recovery, magnitude: u, v_i = -2 (e^(-TI_i k) - e^(-TR k)) and the
   * sums the polarity patterns need, with running sums over the sorted points.
   */
  private irSums(
    row: Float64Array,
    off: number,
    eTr: number,
    y: ArrayLike<number>,
    yo: number,
  ): void {
    const { n, v, order, preY, preVY, preV } = this;
    this.curY = y;
    this.curYo = yo;
    this.irU = 1 - eTr;
    let sy = 0;
    let sv = 0;
    let svv = 0;
    let svy = 0;
    for (let i = 0; i < n; i++) {
      const vi = -2 * (row[off + i]! - eTr);
      const yi = y[yo + i]!;
      v[i] = vi;
      sy += yi;
      sv += vi;
      svv += vi * vi;
      svy += vi * yi;
    }
    const vb = sv / n;
    let cvv = 0;
    for (let i = 0; i < n; i++) cvv += (v[i]! - vb) ** 2;
    this.sy = sy;
    this.sv = sv;
    this.svv = svv;
    this.svy = svy;
    this.cvv = cvv;
    preY[0] = 0;
    preVY[0] = 0;
    preV[0] = 0;
    for (let r = 0; r < n; r++) {
      const i = order[r]!;
      const yi = y[yo + i]!;
      preY[r + 1] = preY[r]! + yi;
      preVY[r + 1] = preVY[r]! + v[i]! * yi;
      preV[r + 1] = preV[r]! + v[i]!;
    }
  }

  /** Whether M0 g = P u + Q v has the signs of pattern p (negative at the first p sorted points). */
  private signsMatch(pat: number, P: number, Q: number): boolean {
    const { n, v, order, irU } = this;
    if (pat > 0 && P * irU + Q * v[order[pat - 1]!]! > 0) return false;
    if (pat < n && P * irU + Q * v[order[pat]!]! < 0) return false;
    return true;
  }

  /** Sum of squares of y_i - s_i (P u + Q v_i) - C, s_i = -1 at the first p sorted points. */
  private patternSse(pat: number, P: number, Q: number, C: number): number {
    const { n, v, rank, irU, curY, curYo } = this;
    let sse = 0;
    for (let i = 0; i < n; i++) {
      const mi = P * irU + Q * v[i]!;
      const r = curY[curYo + i]! - (rank[i]! < pat ? -mi : mi) - C;
      sse += r * r;
    }
    return sse;
  }

  /**
   * Pattern p with A fixed at `a`: z_i = s_i y_i ≈ P (u + a v_i) (+ C s_i), P ≥ 0.
   * Sets pM0, pA, pC and ok (signs match); returns the pattern's sum of squares.
   * The sum is computed from the residuals, not from the normal equations: in
   * nearly degenerate fits φ varies by less than the rounding of the latter.
   */
  private patternFixed(pat: number, a: number): number {
    const { n, irU: u, sy, sv, svv } = this;
    const z = sy - 2 * this.preY[pat]!;
    const vz = this.svy - 2 * this.preVY[pat]!;
    const sww = n * u * u + 2 * a * u * sv + a * a * svv;
    const swz = u * z + a * vz;
    let P = 0;
    let C = 0;
    if (!this.fitC) {
      if (sww > 0) P = Math.max(0, swz / sww);
    } else {
      const sws = u * (n - 2 * pat) + a * (sv - 2 * this.preV[pat]!);
      const det = sww * n - sws * sws;
      if (det > 1e-14 * sww * n) {
        P = (swz * n - sws * sy) / det;
        C = (sww * sy - sws * swz) / det;
      }
      if (!(P > 0)) {
        P = 0;
        C = sy / n;
      }
    }
    this.pM0 = P;
    this.pA = this.fitA ? a : 1;
    this.pC = C;
    this.ok = this.signsMatch(pat, P, a * P);
    return this.patternSse(pat, P, a * P, C);
  }

  /**
   * Pattern p of the imperfect-inversion model: P ≥ 0, 0 ≤ Q ≤ 2P. Sets pM0,
   * pA, pC and ok; returns the pattern's sum of squares (as patternFixed).
   */
  private patternA(pat: number): number {
    const { n, irU: u, v, order, sy, sv, cvv } = this;
    const z = sy - 2 * this.preY[pat]!;
    const vz = this.svy - 2 * this.preVY[pat]!;
    const vb = sv / n;
    if (this.fitC && (pat === 0 || pat === n)) {
      // One sign throughout, so u and the offset are one column: z ≈ Q v + K.
      // Any M0 ≥ Q/2 keeps A ≤ 2; it is chosen for the signs, A = 1 when they allow.
      let Q = cvv > 0 ? (vz - vb * z) / cvv : 0;
      if (Q < 0) Q = 0;
      const K = z / n - Q * vb;
      const s = pat === 0 ? 1 : -1;
      let P: number;
      if (pat === 0) {
        P = Math.max(Q, (-Q * v[order[0]!]!) / u);
        this.ok = true;
      } else {
        const top = (-Q * v[order[n - 1]!]!) / u;
        this.ok = Q === 0 || Q / 2 <= top;
        P = this.ok ? Math.min(Q, top) : Q;
      }
      // z = P u + Q v + s C, so s C = K - P u.
      const C = s * (K - P * u);
      this.pM0 = P;
      this.pA = P > 0 ? Q / P : 1;
      this.pC = C;
      return this.patternSse(pat, P, Q, C);
    }
    let P = NaN;
    let Q = NaN;
    let C = 0;
    if (!this.fitC) {
      if (cvv > 0) {
        Q = (vz - vb * z) / cvv;
        P = (z / n - Q * vb) / u;
      }
    } else {
      // Normal equations for z ≈ P u + Q v + C s.
      const gram = this.gram;
      const sol = this.sol;
      const s = n - 2 * pat;
      const svs = sv - 2 * this.preV[pat]!;
      gram[0] = n * u * u;
      gram[1] = u * sv;
      gram[2] = u * s;
      gram[3] = gram[1]!;
      gram[4] = this.svv;
      gram[5] = svs;
      gram[6] = gram[2]!;
      gram[7] = svs;
      gram[8] = n;
      sol[0] = u * z;
      sol[1] = vz;
      sol[2] = sy;
      if (solveSymmetric(gram, sol, 3)) {
        P = sol[0]!;
        Q = sol[1]!;
        C = sol[2]!;
      }
    }
    if (P > 0 && Q >= 0 && Q <= 2 * P) {
      this.pM0 = P;
      this.pA = Q / P;
      this.pC = C;
      this.ok = this.signsMatch(pat, P, Q);
      return this.patternSse(pat, P, Q, C);
    }
    // Outside the cone the minimum lies on A = 0 or A = 2.
    const s0 = this.patternFixed(pat, 0);
    const m0 = this.pM0;
    const c0 = this.pC;
    const ok0 = this.ok;
    const s2 = this.patternFixed(pat, 2);
    if (s0 < s2) {
      this.pM0 = m0;
      this.pA = 0;
      this.pC = c0;
      this.ok = ok0;
      return s0;
    }
    return s2;
  }

  /** Magnitude fit at a fixed A (μ |g| + C, μ ≥ 0); keeps it when below `best`. */
  private faceIrA(a: number, y: ArrayLike<number>, yo: number, best: number): number {
    const { n, v, h, irU } = this;
    for (let i = 0; i < n; i++) h[i] = Math.abs(irU + a * v[i]!);
    const sse = this.lin(h, 0, y, yo, this.fitC, true);
    if (!(sse < best)) return best;
    this.pM0 = this.linMu;
    this.pA = a;
    this.pC = this.linC;
    return sse;
  }

  /**
   * Imperfect inversion, magnitude: φ exactly, the lowest of every pattern whose
   * signs match, A = 0 and A = 2, and (with an offset) every A at which one g vanishes.
   */
  private envelopeIrA(
    row: Float64Array,
    off: number,
    eTr: number,
    y: ArrayLike<number>,
    yo: number,
  ): number {
    this.irSums(row, off, eTr, y, yo);
    let best = Infinity;
    let m0 = 0;
    let a = 1;
    let c = 0;
    for (let pat = 0; pat <= this.n; pat++) {
      const sse = this.patternA(pat);
      if (this.ok && sse < best) {
        best = sse;
        m0 = this.pM0;
        a = this.pA;
        c = this.pC;
      }
    }
    this.pM0 = m0;
    this.pA = a;
    this.pC = c;
    best = this.faceIrA(0, y, yo, best);
    best = this.faceIrA(2, y, yo, best);
    if (this.fitC) {
      for (let j = 0; j < this.n; j++) {
        const aj = -this.irU / this.v[j]!;
        if (aj > 0 && aj < 2) best = this.faceIrA(aj, y, yo, best);
      }
    }
    return best;
  }

  /**
   * Branch b of a magnitude inversion-recovery fit at the rate whose sums
   * irSums last computed: pattern b, or (b ≥ n + 1) the point b - n - 1 at
   * which g vanishes. Sets pM0, pA, pC and ok.
   */
  private branchAtSums(b: number): number {
    if (b < this.patterns) return this.fitA ? this.patternA(b) : this.patternFixed(b, 1);
    const aj = -this.irU / this.v[b - this.patterns]!;
    if (!(aj > 0 && aj <= 2)) {
      this.ok = false;
      return Infinity;
    }
    const sse = this.faceIrA(aj, this.curY, this.curYo, Infinity);
    this.ok = true;
    return sse;
  }

  /** Profile b at ln k = t; b < 0 (or a single branch) is φ itself. */
  private evaluate(t: number, b: number, y: ArrayLike<number>, yo: number): number {
    const eTr = this.tabulate(Math.exp(t), this.row, 0);
    if (b < 0 || this.branches === 1) {
      this.ok = true;
      return this.profile(this.row, 0, eTr, y, yo);
    }
    this.irSums(this.row, 0, eTr, y, yo);
    return this.branchAtSums(b);
  }

  /**
   * Brent's minimisation of profile b over ln k in [lo, hi], from x0 inside it
   * with value f0 (signs matching: ok0; both NaN/false to evaluate them here).
   * Leaves the minimum in refU, refSse, refOk and refIter.
   */
  private refine(
    lo: number,
    hi: number,
    x0: number,
    f0: number,
    ok0: boolean,
    b: number,
    y: ArrayLike<number>,
    yo: number,
  ): void {
    if (Number.isNaN(f0)) {
      f0 = this.evaluate(x0, b, y, yo);
      ok0 = this.ok;
    }
    let a = lo;
    let bb = hi;
    let x = x0;
    let w = x0;
    let v = x0;
    let fx = f0;
    let fw = f0;
    let fv = f0;
    let okx = ok0;
    let d = 0;
    let e = 0;
    let iter = 0;
    const tol = REFINE_TOL;
    const tol2 = 2 * tol;
    for (; iter < REFINE_MAX_ITER; iter++) {
      const mid = 0.5 * (a + bb);
      if (Math.abs(x - mid) <= tol2 - 0.5 * (bb - a)) break;
      let golden = true;
      if (Math.abs(e) > tol) {
        // Parabola through (v, fv), (w, fw), (x, fx).
        const r = (x - w) * (fx - fv);
        let q = (x - v) * (fx - fw);
        let p = (x - v) * q - (x - w) * r;
        q = 2 * (q - r);
        if (q > 0) p = -p;
        else q = -q;
        const previous = e;
        e = d;
        if (Math.abs(p) < Math.abs(0.5 * q * previous) && p > q * (a - x) && p < q * (bb - x)) {
          d = p / q;
          const t = x + d;
          if (t - a < tol2 || bb - t < tol2) d = x < mid ? tol : -tol;
          golden = false;
        }
      }
      if (golden) {
        e = (x < mid ? bb : a) - x;
        d = GOLDEN * e;
      }
      const t = x + (Math.abs(d) >= tol ? d : d > 0 ? tol : -tol);
      const ft = this.evaluate(t, b, y, yo);
      if (ft <= fx) {
        if (t < x) bb = x;
        else a = x;
        v = w;
        fv = fw;
        w = x;
        fw = fx;
        x = t;
        fx = ft;
        okx = this.ok;
      } else {
        if (t < x) a = t;
        else bb = t;
        if (ft <= fw || w === x) {
          v = w;
          fv = fw;
          w = t;
          fw = ft;
        } else if (ft <= fv || v === x || v === w) {
          v = t;
          fv = ft;
        }
      }
    }
    this.refU = x;
    this.refSse = fx;
    this.refOk = okx;
    this.refIter = iter;
  }

  /**
   * Whether branch b's signs match at a grid point within two of j. A branch's
   * minimum counts only where its signs match, and where they match it is φ,
   * whose basins span several grid points; elsewhere it need not be refined.
   */
  private okNear(b: number, j: number): boolean {
    const B = this.branches;
    const lo = Math.max(0, j - SIGN_NEAR);
    const hi = Math.min(this.nGrid - 1, j + SIGN_NEAR);
    for (let q = lo; q <= hi; q++) if (this.gridOk[q * B + b] === 1) return true;
    return false;
  }

  /** Refine profile b around t, which may sit on the edge of [lo, hi]. */
  private refineFrom(
    lo: number,
    hi: number,
    t: number,
    b: number,
    y: ArrayLike<number>,
    yo: number,
  ): void {
    const x0 = t > lo && t < hi ? t : lo + GOLDEN * (hi - lo);
    this.refine(lo, hi, x0, NaN, false, b, y, yo);
  }

  /**
   * Fit one curve. `y[offset .. offset+n)` holds the measurements.
   * Results go to `out[outOffset ..]` using the {@link OUT} layout.
   * Returns false when the fit failed (non-finite data or result).
   * With the magnitude option the magnitude of every measurement is fitted,
   * so signed data (for example phase-sensitive images) are accepted too.
   * `init` adds its rate as one more starting point of the refinement; the
   * whole range is searched regardless, so a poor guess cannot trap the fit.
   */
  fit(
    y: ArrayLike<number>,
    offset: number,
    out: Float64Array | Float32Array,
    outOffset = 0,
    init?: InitialGuess,
  ): boolean {
    const { n, nGrid, gridU, gridPhi, gridOk, branches: B, p } = this;
    if (this.magnitude) {
      for (let i = 0; i < n; i++) this.absY[i] = Math.abs(y[offset + i]!);
      y = this.absY;
      offset = 0;
    }
    for (let j = 0; j < nGrid; j++) {
      if (B === 1) {
        gridPhi[j] = this.profile(this.gridRow, j * n, this.gridETr[j]!, y, offset);
        gridOk[j] = 1;
      } else {
        this.irSums(this.gridRow, j * n, this.gridETr[j]!, y, offset);
        for (let b = 0; b < B; b++) {
          gridPhi[j * B + b] = this.branchAtSums(b);
          gridOk[j * B + b] = this.ok ? 1 : 0;
        }
      }
    }

    // Candidates: φ at the ends of the range (and, magnitude with A = 1 and an
    // offset, at the rates where one g vanishes), then every local minimum of
    // every branch on the grid, refined, whose signs match.
    const last = nGrid - 1;
    let best = Infinity;
    let bestJ = -1;
    let bestB = -1;
    let bestU = NaN;
    let iterations = 0;
    for (let end = 0; end < 2; end++) {
      const j = end === 0 ? 0 : last;
      const f =
        B === 1 ? gridPhi[j]! : this.profile(this.gridRow, j * n, this.gridETr[j]!, y, offset);
      if (f < best) {
        best = f;
        bestJ = j;
      }
    }
    for (let q = 0; q < this.nullRates.length; q++) {
      const t = this.nullRates[q]!;
      const f = this.evaluate(t, -1, y, offset);
      if (f < best) {
        best = f;
        bestJ = -1;
        bestB = -1;
        bestU = t;
        iterations = 0;
      }
    }
    for (let b = 0; b < B; b++) {
      for (let j = 0; j <= last; j++) {
        const f = gridPhi[j * B + b]!;
        if (
          (j > 0 && !(f < gridPhi[(j - 1) * B + b]!)) ||
          (j < last && !(f <= gridPhi[(j + 1) * B + b]!))
        )
          continue;
        if (B > 1 && !this.okNear(b, j)) continue;
        const lo = gridU[Math.max(j - 1, 0)]!;
        const hi = gridU[Math.min(j + 1, last)]!;
        if (j > 0 && j < last)
          this.refine(lo, hi, gridU[j]!, f, gridOk[j * B + b] === 1, b, y, offset);
        else this.refineFrom(lo, hi, gridU[j]!, b, y, offset);
        if (this.refOk && this.refSse < best) {
          best = this.refSse;
          bestJ = -1;
          bestB = b;
          bestU = this.refU;
          iterations = this.refIter;
        }
      }
    }
    if (init) {
      const k = this.model.rateIsParam ? init.param : 1 / init.param;
      if (!Number.isNaN(k)) {
        const t = Math.log(Math.min(this.kMax, Math.max(this.kMin, k)));
        const step = gridU[1]! - gridU[0]!;
        this.refineFrom(
          Math.max(gridU[0]!, t - step),
          Math.min(gridU[last]!, t + step),
          t,
          -1,
          y,
          offset,
        );
        if (this.refSse < best) {
          best = this.refSse;
          bestJ = -1;
          bestB = -1;
          bestU = this.refU;
          iterations = this.refIter;
        }
      }
    }
    if (!(best < Infinity)) return false;

    // Linear parameters at the minimum, and the model's work arrays for standardErrors.
    let k: number;
    if (bestJ >= 0) {
      k = this.gridK[bestJ]!;
      this.profile(this.gridRow, bestJ * n, this.gridETr[bestJ]!, y, offset);
    } else {
      k = Math.exp(bestU);
      this.evaluate(bestU, bestB, y, offset);
    }
    p[0] = k;
    p[1] = this.pM0;
    p[2] = this.pA;
    p[3] = this.pC;
    const sse = this.residuals(p, y, offset, true);
    if (!Number.isFinite(sse)) return false;

    let mean = 0;
    for (let i = 0; i < n; i++) mean += y[offset + i]!;
    mean /= n;
    let sst = 0;
    for (let i = 0; i < n; i++) sst += (y[offset + i]! - mean) ** 2;

    const param = this.model.rateIsParam ? k : 1 / k;
    out[outOffset + OUT.param] = param;
    out[outOffset + OUT.m0] = p[1]!;
    out[outOffset + OUT.a] = p[2]!;
    out[outOffset + OUT.c] = p[3]!;
    out[outOffset + OUT.sse] = sse;
    out[outOffset + OUT.r2] = sst > 0 ? 1 - sse / sst : 0;
    out[outOffset + OUT.iterations] = iterations;
    return Number.isFinite(param) && Number.isFinite(p[1]!);
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
        // g = 1 - 2A e^(-TI k) + (2A - 1) e^(-TR k): see inversionRecoverySignal.
        // A is fitted as the inversion efficiency itself and M0 as the
        // equilibrium magnetisation; for A = 1 (model t1ir) this is the
        // usual 1 - 2 e^(-TI k) + e^(-TR k).
        const eTr = Number.isFinite(tr) ? Math.exp(-tr * k) : 0;
        const dTr = Number.isFinite(tr) ? -tr * eTr : 0;
        const b = 2 * a - 1;
        for (let i = 0; i < n; i++) {
          const e = Math.exp(-x[i]! * k);
          g[i] = 1 - 2 * a * e + b * eTr;
          if (derivatives) {
            dgk[i] = 2 * a * x[i]! * e + b * dTr;
            dga[i] = -2 * e + 2 * eTr;
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
        g =
          1 -
          2 * fit.a * Math.exp(-xi * k) +
          (Number.isFinite(tr) ? (2 * fit.a - 1) * Math.exp(-tr * k) : 0);
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
