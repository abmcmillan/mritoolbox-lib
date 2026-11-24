/**
 * MP-RAGE simulation with the extended phase graph (EPG) algorithm.
 *
 * Port of the reference Java implementation published with
 * "Optimized inversion-prepared gradient echo imaging" (J Magn Reson Imaging,
 * doi:10.1002/jmri.23669), https://github.com/mimrtl/MPRAGE_Simulator, with
 * one correction. The 2012 code applied readout pulse j, and the relaxation
 * after it, to EPG orders 0..j only. That is exact in the first inversion
 * cycle, where no higher order is populated yet, but the Z states that
 * survive TD2 carry orders up to np - 1 into the next cycle (and further in
 * each cycle after it), and the early pulses of that cycle neither rotated
 * nor relaxed them. Here every pulse acts on every order that can be
 * non-zero, up to an order above which the dropped states provably change no
 * echo by more than 1e-12 PD (see orderLimit). The first cycle is computed
 * exactly as before.
 */
import { DEG, linspace } from './signal.js';
import { assertValid, checkMprage } from './validate.js';

export interface MprageTissue {
  /** Relative proton density, 0–1. */
  pd: number;
  t1: number;
  t2: number;
}

export interface MprageSequence {
  /** Flip angle of the readout train, degrees. */
  flipAngle: number;
  /** Quadratic RF phase-spoiling increment, degrees. */
  spoilIncrement: number;
  /** Repetition time within the readout train, ms. */
  tr: number;
  /** Delay between inversion and the readout train, ms. */
  td1: number;
  /** Recovery delay after the readout train, ms. */
  td2: number;
  /** Number of RF pulses (phase-encoding lines) per inversion. */
  np: number;
  /** Assume transverse magnetisation is fully destroyed each TR. */
  idealSpoiling?: boolean;
  /**
   * Most inversion cycles to run while approaching the longitudinal steady
   * state (default 25). 1 runs only the first cycle, from equilibrium.
   */
  maxLoops?: number;
}

export interface EpgResult {
  /** Real / imaginary transverse magnetisation after each pulse. */
  re: Float64Array;
  im: Float64Array;
  /** RF phase of each pulse, radians. */
  phase: Float64Array;
  /** Outer loops needed to reach the longitudinal steady state. */
  loops: number;
  steadyState: boolean;
}

const MAX_LOOPS = 25;
const STEADY_STATE_EPS = 1e-10;
/** Most that dropping the EPG orders above orderLimit() can change any echo, in units of PD. */
const ORDER_EPS = 1e-12;

/**
 * Highest EPG order K the simulation keeps, for at most `loops` cycles.
 *
 * The populated orders grow by np - 1 in every inversion cycle, so `loops`
 * cycles reach order loops * (np - 1) at most; keeping all of them is exact.
 * The cost is bounded further by T2: an order-k state has spent at least k
 * TRs as transverse magnetisation and needs k more to rephase into an echo.
 *
 * Bound. Let e_k = |F_k|^2 + |F_-k|^2 + 2|Z_k|^2 be the energy of order k
 * (e_0 = |F_0|^2 + Z_0^2) and q = exp(-2 TR/T2). RF pulses preserve every e_k.
 * T1/T2 decay and the shift of F by one order per TR increase neither
 * N+ = sqrt(sum_k q^-k e_k) nor N- = sqrt(sum_k q^k e_k): a shifted F state
 * moves one order and loses a factor q of its energy. TD2 spoiling only
 * removes energy, and the inversion leaves no transverse magnetisation for
 * the TD1 shift to act on (up to sin(pi) ~ 1e-16). N+ starts at PD and the
 * recovery term adds at most PD (1 - E1) <= PD tau/T1 per interval tau, so
 * after a time t, |F_(K+1)| <= q^((K+1)/2) PD (1 + t/T1). Dropping that
 * state is a perturbation with N- = q^((K+1)/2) |F_(K+1)|; N- cannot grow
 * and bounds |F_0|, so it changes no later echo by more than
 * q^(K+1) PD (1 + t/T1). At most loops (np + 1) states are dropped, so all
 * echoes stay within ORDER_EPS * PD of the untruncated EPG when
 *   (K + 1) * 2 TR/T2 >= ln(loops (np + 1) (1 + span/T1) / ORDER_EPS),
 * span being the duration of `loops` cycles. K is never below np - 1, so the
 * first cycle is always computed in full.
 */
function orderLimit(
  t1: number,
  t2: number,
  seq: MprageSequence,
  np: number,
  loops: number,
): number {
  const grown = loops * (np - 1);
  const steps = loops * (np + 1);
  const span = loops * (np * seq.tr + seq.td1 + seq.td2);
  const relaxed = Math.ceil((Math.log((steps * (1 + span / t1)) / ORDER_EPS) * t2) / (2 * seq.tr));
  return Math.max(np - 1, Math.min(grown, relaxed));
}

/** Apply an RF pulse (flip `angle`, phase `phi`) to EPG states k = 0..kMax. */
function applyPulse(
  angle: number,
  phi: number,
  kMax: number,
  /** Array index of order 0 in fx, fy, pfx and pfy. */
  centre: number,
  fx: Float64Array,
  fy: Float64Array,
  zx: Float64Array,
  zy: Float64Array,
  pfx: Float64Array,
  pfy: Float64Array,
  pzx: Float64Array,
  pzy: Float64Array,
): void {
  const a = Math.cos(angle / 2) ** 2;
  const b = Math.sin(angle / 2) ** 2;
  const c = Math.sin(angle);
  const d = Math.cos(angle);
  const e = Math.sin(phi);
  const f = Math.cos(phi);
  const hb = Math.cos(2 * phi) * b;
  const gb = Math.sin(2 * phi) * b;
  const ec = e * c;
  const fc = f * c;
  for (let k = 0; k <= kMax; k++) {
    const n = centre + k;
    const m = centre - k;
    const fxn = fx[n]!;
    const fyn = fy[n]!;
    const fxm = fx[m]!;
    const fym = fy[m]!;
    const zxk = zx[k + 1]!;
    const zyk = zy[k + 1]!;
    pfx[n] = a * fxn + hb * fxm + gb * fym + ec * zxk + fc * zyk;
    pfy[n] = a * fyn - hb * fym + gb * fxm - fc * zxk + ec * zyk;
    pfx[m] = hb * fxn + gb * fyn + a * fxm + ec * zxk - fc * zyk;
    pfy[m] = gb * fxn - hb * fyn + a * fym - fc * zxk - ec * zyk;
    pzx[k + 1] = (-ec * fxn + fc * fyn - ec * fxm + fc * fym + 2 * d * zxk) / 2;
    pzy[k + 1] = (-fc * fxn - ec * fyn + fc * fxm + ec * fym + 2 * d * zyk) / 2;
  }
}

/** Simulate the transverse magnetisation along one MP-RAGE readout train. */
export function simulateMprage(tissue: MprageTissue, seq: MprageSequence): EpgResult {
  assertValid(checkMprage([tissue], seq));
  const { pd: m0, t1, t2 } = tissue;
  const np = Math.round(seq.np);
  const alpha = seq.flipAngle * DEG;
  const increment = seq.spoilIncrement * DEG;
  const twoPi = 2 * Math.PI;

  const er1 = Math.exp(-seq.tr / t1);
  const er2 = Math.exp(-seq.tr / t2);
  const ed11 = Math.exp(-seq.td1 / t1);
  const ed12 = Math.exp(-seq.td1 / t2);
  const ed21 = Math.exp(-seq.td2 / t1);

  // F_k is stored at fx[centre + k] (k = -kCap..kCap + 1), Z_k at zx[k + 1].
  // With ideal spoiling only order 0 is ever populated, and the arrays have
  // the size of the 2012 code.
  const maxLoops = seq.maxLoops ?? MAX_LOOPS;
  const kCap = seq.idealSpoiling ? np - 1 : orderLimit(t1, t2, seq, np, maxLoops);
  const centre = kCap + 1;
  const fx = new Float64Array(2 * kCap + 4);
  const fy = new Float64Array(2 * kCap + 4);
  const pfx = new Float64Array(2 * kCap + 4);
  const pfy = new Float64Array(2 * kCap + 4);
  const zx = new Float64Array(kCap + 3);
  const zy = new Float64Array(kCap + 3);
  const pzx = new Float64Array(kCap + 3);
  const pzy = new Float64Array(kCap + 3);
  // The steady-state test looks at orders 0..np, as in the 2012 code.
  const tested = np + 2;
  const zxPrev = new Float64Array(tested).fill(Infinity);
  const zyPrev = new Float64Array(tested).fill(Infinity);
  zx[1] = m0;

  const re = new Float64Array(np);
  const im = new Float64Array(np);
  const phase = new Float64Array(np);

  // Highest order populated when an inversion cycle starts: Z_0 alone in the
  // first cycle, then every Z order the previous readout train reached.
  let top = 0;
  let loops = 0;
  let steadyState = false;
  while (!steadyState && loops < maxLoops) {
    loops++;

    // Inversion pulse followed by the TD1 delay.
    applyPulse(Math.PI, 0, top, centre, fx, fy, zx, zy, pfx, pfy, pzx, pzy);
    for (let k = -top; k <= top; k++) {
      const n = centre + k;
      fx[n + 1] = pfx[n]! * ed12;
      fy[n + 1] = pfy[n]! * ed12;
      if (k > 0) zx[k + 1] = pzx[k + 1]! * ed11;
      if (k === 0) zx[1] = pzx[1]! * ed11 + m0 * (1 - ed11);
      if (k >= 0) zy[k + 1] = pzy[k + 1]! * ed11;
    }

    // Readout train with quadratic RF phase cycling. Before pulse j, orders up
    // to top + j can be populated (one more per TR), and the pulse and the
    // relaxation after it act on all of them. In the first cycle top = 0, so
    // pulse j acts on orders 0..j, exactly as in the 2012 code.
    let phi = 0;
    let inc = 0;
    let kMax = 0;
    for (let j = 0; j < np; j++) {
      inc = (inc + increment) % twoPi;
      phi = (phi + inc) % twoPi;
      kMax = Math.min(top + j, kCap);
      applyPulse(alpha, phi, kMax, centre, fx, fy, zx, zy, pfx, pfy, pzx, pzy);
      re[j] = pfx[centre]!;
      im[j] = pfy[centre]!;
      phase[j] = phi;
      for (let k = -kMax; k <= kMax; k++) {
        const n = centre + k;
        fx[n + 1] = pfx[n]! * er2;
        fy[n + 1] = pfy[n]! * er2;
        if (k > 0) zx[k + 1] = pzx[k + 1]! * er1;
        if (k === 0) zx[1] = pzx[1]! * er1 + m0 * (1 - er1);
        if (k >= 0) zy[k + 1] = pzy[k + 1]! * er1;
      }
      if (seq.idealSpoiling) {
        fx.fill(0);
        fy.fill(0);
      }
    }

    // TD2 recovery: transverse magnetisation is assumed fully dephased.
    fx.fill(0);
    fy.fill(0);
    const e = ed21 * er1;
    for (let k = 0; k <= kMax; k++) {
      if (k > 0) zx[k + 1] = pzx[k + 1]! * e;
      else zx[1] = pzx[1]! * e + m0 * (1 - e);
      zy[k + 1] = pzy[k + 1]! * e;
    }
    // Ideal spoiling leaves every order above 0 exactly zero.
    top = seq.idealSpoiling ? 0 : kMax;

    let err = 0;
    for (let k = 0; k < tested; k++) {
      err += Math.abs(Math.hypot(zx[k]!, zy[k]!) - Math.hypot(zxPrev[k]!, zyPrev[k]!));
    }
    steadyState = err < STEADY_STATE_EPS;
    zxPrev.set(zx.subarray(0, tested));
    zyPrev.set(zy.subarray(0, tested));
  }

  return { re, im, phase, loops, steadyState };
}

/** Swap the two halves of an interleaved-free complex vector (re, im separately). */
function fftShift(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  const half = Math.ceil(n / 2);
  const r = Float64Array.from(re);
  const i = Float64Array.from(im);
  for (let k = 0; k < n; k++) {
    const src = (k + half) % n;
    re[k] = r[src]!;
    im[k] = i[src]!;
  }
}

/** Unnormalised discrete Fourier transform, sign = -1 forward, +1 backward. */
function dft(re: Float64Array, im: Float64Array, sign: 1 | -1): void {
  const n = re.length;
  const cos = new Float64Array(n);
  const sin = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    cos[k] = Math.cos((2 * Math.PI * k) / n);
    sin[k] = sign * Math.sin((2 * Math.PI * k) / n);
  }
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sr = 0;
    let si = 0;
    for (let t = 0; t < n; t++) {
      const idx = (k * t) % n;
      const c = cos[idx]!;
      const s = sin[idx]!;
      sr += re[t]! * c - im[t]! * s;
      si += re[t]! * s + im[t]! * c;
    }
    outRe[k] = sr;
    outIm[k] = si;
  }
  re.set(outRe);
  im.set(outIm);
}

export interface MprageImageResult {
  /** Magnitude of the simulated 1-D image (two adjacent tissue blocks). */
  profile: Float64Array;
  /** Per-pulse transverse signal magnitude for each tissue. */
  evolutionA: Float64Array;
  evolutionB: Float64Array;
  /** Mean image magnitude inside each tissue block. */
  signalA: number;
  signalB: number;
  maskA: Uint8Array;
  maskB: Uint8Array;
  loops: [number, number];
  steadyState: boolean;
  /** Inputs that compute but look unintended (see checkMprage). */
  warnings: string[];
}

/**
 * Simulate a 1-D image of two adjacent tissue blocks with linearly ordered
 * phase encoding, so that signal evolution along the readout train appears as
 * the k-space filter it is in a real acquisition.
 */
export function simulateMprageImage(
  tissueA: MprageTissue,
  tissueB: MprageTissue,
  seq: MprageSequence,
): MprageImageResult {
  const warnings = assertValid(checkMprage([tissueA, tissueB], seq, true));
  const np = Math.round(seq.np);
  const half = Math.floor(np / 2);
  const quarter = Math.floor(np / 4);
  const eighth = Math.floor(np / 8);
  const maskA = new Uint8Array(np);
  const maskB = new Uint8Array(np);
  for (let j = quarter - eighth; j < half; j++) maskA[j] = 1;
  for (let j = half; j < 3 * quarter + eighth; j++) maskB[j] = 1;

  const phaseEnc = linspace(-Math.PI, Math.PI, np);
  const kRe = new Float64Array(np);
  const kIm = new Float64Array(np);
  const evolution: Float64Array[] = [];
  const loops: number[] = [];
  let steadyState = true;

  for (const [tissue, mask] of [
    [tissueA, maskA],
    [tissueB, maskB],
  ] as const) {
    const sim = simulateMprage(tissue, seq);
    loops.push(sim.loops);
    steadyState &&= sim.steadyState;
    const mag = new Float64Array(np);
    const mRe = Float64Array.from(mask);
    const mIm = new Float64Array(np);
    fftShift(mRe, mIm);
    dft(mRe, mIm, -1);
    fftShift(mRe, mIm);
    for (let i = 0; i < np; i++) {
      mag[i] = Math.hypot(sim.re[i]!, sim.im[i]!);
      // Object spectrum weighted by the signal at the time line i was acquired.
      let r = sim.re[i]! * mRe[i]! - sim.im[i]! * mIm[i]!;
      let m = sim.re[i]! * mIm[i]! + sim.im[i]! * mRe[i]!;
      const ang = phaseEnc[i]! - sim.phase[i]!;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      [r, m] = [r * c - m * s, r * s + m * c];
      kRe[i] = kRe[i]! + r;
      kIm[i] = kIm[i]! + m;
    }
    evolution.push(mag);
  }

  fftShift(kRe, kIm);
  dft(kRe, kIm, 1);
  fftShift(kRe, kIm);

  const profile = new Float64Array(np);
  let sumA = 0;
  let sumB = 0;
  let countA = 0;
  let countB = 0;
  for (let i = 0; i < np; i++) {
    // The forward/backward transform pair is unnormalised, hence the 1/np.
    profile[i] = Math.hypot(kRe[i]!, kIm[i]!) / np;
    if (maskA[i]) {
      sumA += profile[i]!;
      countA++;
    }
    if (maskB[i]) {
      sumB += profile[i]!;
      countB++;
    }
  }

  return {
    profile,
    evolutionA: evolution[0]!,
    evolutionB: evolution[1]!,
    signalA: sumA / countA,
    signalB: sumB / countB,
    maskA,
    maskB,
    loops: [loops[0]!, loops[1]!],
    steadyState,
    warnings,
  };
}
