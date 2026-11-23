/** Canonical MRI signal equations. Times in ms, angles in radians unless noted. */

export const DEG = Math.PI / 180;

/** Ernst angle in degrees for a spoiled gradient echo: acos(exp(-TR/T1)). */
export function ernstAngleDeg(t1: number, tr: number): number {
  return Math.acos(Math.exp(-tr / t1)) / DEG;
}

/** Steady-state spoiled GRE signal (ideal spoiling). */
export function spgrSignal(
  pd: number,
  t1: number,
  t2star: number,
  tr: number,
  te: number,
  alpha: number,
): number {
  const e1 = Math.exp(-tr / t1);
  return (pd * (1 - e1) * Math.sin(alpha) * Math.exp(-te / t2star)) / (1 - Math.cos(alpha) * e1);
}

/** Spin-echo signal with ideal 90°/180° pulses and TE << TR. */
export function spinEchoSignal(pd: number, t1: number, t2: number, tr: number, te: number): number {
  return pd * (1 - Math.exp(-tr / t1)) * Math.exp(-te / t2);
}

/** Inversion-recovery signal (signed), optional inversion efficiency. */
export function inversionRecoverySignal(
  pd: number,
  t1: number,
  ti: number,
  tr: number,
  efficiency = 1,
): number {
  return pd * (1 - 2 * efficiency * Math.exp(-ti / t1) + Math.exp(-tr / t1));
}

export interface Tissue {
  pd: number;
  t1: number;
  /** T2 for spin echo, T2* for gradient echo. */
  t2: number;
}

/** Evenly spaced samples including both end points. */
export function linspace(low: number, high: number, n: number): Float64Array {
  const out = new Float64Array(n);
  if (n === 1) {
    out[0] = low;
    return out;
  }
  const step = (high - low) / (n - 1);
  for (let i = 0; i < n; i++) out[i] = low + i * step;
  out[n - 1] = high;
  return out;
}
