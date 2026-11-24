/**
 * Isochromat (Bloch) simulation of the MP-RAGE experiment that src/epg.ts
 * models, written from the physics rather than from the EPG code, so that
 * the two can check each other.
 *
 * A voxel holds `n` isochromats. Every readout TR, and the TD1 delay after the
 * inversion, ends with a spoiler gradient that winds the transverse
 * magnetisation through one full cycle across the voxel, so isochromat i
 * precesses by 2 pi i / n in each of those intervals. RF pulses are
 * instantaneous rotations about an axis in the transverse plane: the
 * inversion is 180 degrees about x, readout pulse j (j = 0, 1, ...) is the
 * flip angle about the axis at the quadratic phase
 * increment * (j + 1) (j + 2) / 2. The signal of pulse j is the mean
 * transverse magnetisation Mx + i My just after it. After the readout train
 * the transverse magnetisation is destroyed and Mz recovers through TD2.
 *
 * With n isochromats the EPG orders are aliased modulo n, so the signal
 * converges to the continuous-dephasing (EPG) limit as n grows;
 * convergedIsochromats doubles n until the signal stops changing.
 */

export interface IsoTissue {
  pd: number;
  t1: number;
  t2: number;
}

export interface IsoSequence {
  flipAngle: number;
  spoilIncrement: number;
  tr: number;
  td1: number;
  td2: number;
  np: number;
}

export interface IsoSignal {
  re: Float64Array;
  im: Float64Array;
}

/** Rotation matrix (row-major) by `angle` radians about (cos phi, sin phi, 0), right-handed. */
function rotation(angle: number, phi: number): number[] {
  const ux = Math.cos(phi);
  const uy = Math.sin(phi);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const v = 1 - c;
  // Rodrigues: R = c I + s [u]x + (1 - c) u u^T, with u_z = 0.
  return [c + ux * ux * v, ux * uy * v, uy * s, ux * uy * v, c + uy * uy * v, -ux * s, -uy * s, ux * s, c];
}

/** Signal of the last of `cycles` inversion cycles, from `n` isochromats. */
export function isochromatMprage(
  tissue: IsoTissue,
  seq: IsoSequence,
  cycles: number,
  n: number,
): IsoSignal {
  const { pd, t1, t2 } = tissue;
  const mx = new Float64Array(n);
  const my = new Float64Array(n);
  const mz = new Float64Array(n).fill(pd);
  const cosT = new Float64Array(n);
  const sinT = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    cosT[i] = Math.cos((2 * Math.PI * i) / n);
    sinT[i] = Math.sin((2 * Math.PI * i) / n);
  }

  const rotate = (r: number[]): void => {
    const [r00, r01, r02, r10, r11, r12, r20, r21, r22] = r as [
      number, number, number, number, number, number, number, number, number,
    ];
    for (let i = 0; i < n; i++) {
      const x = mx[i]!;
      const y = my[i]!;
      const z = mz[i]!;
      mx[i] = r00 * x + r01 * y + r02 * z;
      my[i] = r10 * x + r11 * y + r12 * z;
      mz[i] = r20 * x + r21 * y + r22 * z;
    }
  };
  /** Free precession for `tau` ms with one gradient cycle across the voxel. */
  const dephaseAndRelax = (tau: number): void => {
    const e1 = Math.exp(-tau / t1);
    const e2 = Math.exp(-tau / t2);
    for (let i = 0; i < n; i++) {
      const x = mx[i]! * e2;
      const y = my[i]! * e2;
      mx[i] = cosT[i]! * x - sinT[i]! * y;
      my[i] = sinT[i]! * x + cosT[i]! * y;
      mz[i] = mz[i]! * e1 + pd * (1 - e1);
    }
  };

  const inversion = rotation(Math.PI, 0);
  const alpha = (seq.flipAngle * Math.PI) / 180;
  const readout: number[][] = [];
  for (let j = 0; j < seq.np; j++) {
    // Quadratic phase cycling, reduced in degrees (exact for whole-degree increments).
    const deg = (seq.spoilIncrement * (((j + 1) * (j + 2)) / 2)) % 360;
    readout.push(rotation(alpha, (deg * Math.PI) / 180));
  }

  const re = new Float64Array(seq.np);
  const im = new Float64Array(seq.np);
  for (let cycle = 0; cycle < cycles; cycle++) {
    rotate(inversion);
    dephaseAndRelax(seq.td1);
    for (let j = 0; j < seq.np; j++) {
      rotate(readout[j]!);
      let sx = 0;
      let sy = 0;
      for (let i = 0; i < n; i++) {
        sx += mx[i]!;
        sy += my[i]!;
      }
      re[j] = sx / n;
      im[j] = sy / n;
      dephaseAndRelax(seq.tr);
    }
    // TD2: transverse magnetisation destroyed, longitudinal recovery.
    const e1 = Math.exp(-seq.td2 / t1);
    for (let i = 0; i < n; i++) {
      mx[i] = 0;
      my[i] = 0;
      mz[i] = mz[i]! * e1 + pd * (1 - e1);
    }
  }
  return { re, im };
}

/** Largest |a_j - b_j| over the train, as complex numbers. */
export function maxDifference(a: IsoSignal, b: IsoSignal): number {
  let worst = 0;
  for (let j = 0; j < a.re.length; j++) {
    worst = Math.max(worst, Math.hypot(a.re[j]! - b.re[j]!, a.im[j]! - b.im[j]!));
  }
  return worst;
}

/**
 * Double the isochromat count from `start` until the signal changes by no
 * more than `tol` (fraction of M0) at any pulse; returns the larger run.
 */
export function convergedIsochromats(
  tissue: IsoTissue,
  seq: IsoSequence,
  cycles: number,
  tol = 1e-10,
  start = 64,
  limit = 1 << 15,
): IsoSignal & { n: number; change: number } {
  let n = start;
  let previous = isochromatMprage(tissue, seq, cycles, n);
  while (2 * n <= limit) {
    n *= 2;
    const next = isochromatMprage(tissue, seq, cycles, n);
    const change = maxDifference(previous, next);
    if (change <= tol) return { ...next, n, change };
    previous = next;
  }
  throw new Error(`isochromat signal did not converge to ${tol} with ${limit} isochromats`);
}
