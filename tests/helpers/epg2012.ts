/**
 * The 2012 MP-RAGE EPG algorithm, as published in EPG_MPRAGE.java
 * (github.com/uw-rad-mitrp/MPRAGE_Simulator) and as src/epg.ts computed it
 * before the correction: readout pulse j, and the relaxation after it, act on
 * EPG orders 0..j only, in every inversion cycle. Kept for the tests that
 * show where the correction changes the result and where it does not.
 * `maxLoops` plays the role of the Java's setMaxLoops (default 25).
 */
export interface Epg2012Result {
  re: Float64Array;
  im: Float64Array;
  loops: number;
  steadyState: boolean;
}

export function epg2012(
  tissue: { pd: number; t1: number; t2: number },
  seq: {
    flipAngle: number;
    spoilIncrement: number;
    tr: number;
    td1: number;
    td2: number;
    np: number;
    idealSpoiling?: boolean;
  },
  maxLoops = 25,
): Epg2012Result {
  const { pd: m0, t1, t2 } = tissue;
  const np = seq.np;
  const deg = Math.PI / 180;
  const alpha = seq.flipAngle * deg;
  const increment = seq.spoilIncrement * deg;
  const twoPi = 2 * Math.PI;
  const er1 = Math.exp(-seq.tr / t1);
  const er2 = Math.exp(-seq.tr / t2);
  const ed11 = Math.exp(-seq.td1 / t1);
  const ed12 = Math.exp(-seq.td1 / t2);
  const ed21 = Math.exp(-seq.td2 / t1);

  const fx = new Float64Array(2 * np + 2);
  const fy = new Float64Array(2 * np + 2);
  const pfx = new Float64Array(2 * np + 2);
  const pfy = new Float64Array(2 * np + 2);
  const zx = new Float64Array(np + 2);
  const zy = new Float64Array(np + 2);
  const pzx = new Float64Array(np + 2);
  const pzy = new Float64Array(np + 2);
  const zxPrev = new Float64Array(np + 2).fill(Infinity);
  const zyPrev = new Float64Array(np + 2).fill(Infinity);
  zx[1] = m0;

  const pulse = (angle: number, phi: number, kMax: number): void => {
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
      const n = np + k;
      const m = np - k;
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
  };

  const re = new Float64Array(np);
  const im = new Float64Array(np);
  let loops = 0;
  let steadyState = false;
  while (!steadyState && loops < maxLoops) {
    loops++;
    pulse(Math.PI, 0, np - 1);
    for (let k = -(np - 1); k <= np - 1; k++) {
      const n = np + k;
      fx[n + 1] = pfx[n]! * ed12;
      fy[n + 1] = pfy[n]! * ed12;
      if (k > 0) zx[k + 1] = pzx[k + 1]! * ed11;
      if (k === 0) zx[1] = pzx[1]! * ed11 + m0 * (1 - ed11);
      if (k >= 0) zy[k + 1] = pzy[k + 1]! * ed11;
    }
    let phi = 0;
    let inc = 0;
    for (let j = 0; j < np; j++) {
      inc = (inc + increment) % twoPi;
      phi = (phi + inc) % twoPi;
      pulse(alpha, phi, j); // orders 0..j only: the truncation
      re[j] = pfx[np]!;
      im[j] = pfy[np]!;
      for (let k = -j; k <= j; k++) {
        const n = np + k;
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
    fx.fill(0, 0, 2 * np);
    fy.fill(0, 0, 2 * np);
    const e = ed21 * er1;
    for (let k = 0; k <= np - 1; k++) {
      if (k > 0) zx[k + 1] = pzx[k + 1]! * e;
      else zx[1] = pzx[1]! * e + m0 * (1 - e);
      zy[k + 1] = pzy[k + 1]! * e;
    }
    let err = 0;
    for (let k = 0; k < zx.length; k++) {
      err += Math.abs(Math.hypot(zx[k]!, zy[k]!) - Math.hypot(zxPrev[k]!, zyPrev[k]!));
    }
    steadyState = err < 1e-10;
    zxPrev.set(zx);
    zyPrev.set(zy);
  }
  return { re, im, loops, steadyState };
}
