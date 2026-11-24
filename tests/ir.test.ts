import { describe, expect, it } from 'vitest';
import { evaluateModel, fitCurve, inversionRecoverySignal, MODELS } from '../dist/index.js';

/** Deterministic pseudo-random Gaussian noise (as in fit.test.ts). */
function gaussian(seed: number): () => number {
  let s = seed;
  const u = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s + 1) / 4294967297;
  };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

/**
 * Inversion recovery with inversion efficiency A (Mz -> (1 - 2A) Mz), a 90°
 * readout at TI that saturates, and free recovery until the next inversion
 * TR later: S = M0 (1 - 2A e^(-TI/T1) + (2A - 1) e^(-TR/T1)). Written out
 * here, independently of the library.
 */
const irSignal = (m0: number, t1: number, ti: number, tr: number, a: number): number =>
  m0 * (1 - 2 * a * Math.exp(-ti / t1) + (2 * a - 1) * Math.exp(-tr / t1));

const TI = [50, 100, 200, 400, 800, 1600, 2400];
const M0 = 1000;

interface Case {
  tr: number;
  t1: number;
  a: number;
  clean: number[];
  noisy: number[];
}

/** The 18 cases, each noise-free and with Gaussian noise of SD 5 (0.5% of M0). */
function cases(): Case[] {
  const rand = gaussian(2026);
  const out: Case[] = [];
  for (const tr of [2550, 6000]) {
    for (const t1 of [300, 1500, 2500]) {
      for (const a of [0.8, 0.9, 1.0]) {
        const clean = TI.map((ti) => irSignal(M0, t1, ti, tr, a));
        const noisy = clean.map((v) => v + 5 * rand());
        out.push({ tr, t1, a, clean, noisy });
      }
    }
  }
  return out;
}

/**
 * T1 from the t1ir-a fit of the pre-correction code (commit b2dfd2c, whose
 * model was M0 (1 - 2A e^(-TI/T1) + e^(-TR/T1))) on the same data, in the
 * order of cases(): [clean, noisy] per case.
 */
const T1_BEFORE: [number, number][] = [
  [300, 304.5054101956465],
  [299.9999999998606, 299.76793118255483],
  [300.0000000000009, 294.056417734155],
  [1499.9999999999998, 1417.7556700948712],
  [1499.9999999999966, 1482.242269962666],
  [1499.9999999997033, 1482.2279718342934],
  [2499.9999999982606, 2389.624890724679],
  [2499.9999999975776, 2452.0202132110257],
  [2500.000000000013, 2465.5453874702757],
  [300, 303.944021864868],
  [299.9999999998524, 297.6400181852455],
  [300.00000000000085, 299.5741343663797],
  [1499.9999999988052, 1502.6328284599874],
  [1499.9999999999347, 1562.2483574473217],
  [1499.999999999996, 1513.8376740656945],
  [2499.9999999999973, 2562.4006765124473],
  [2499.999999997239, 2476.362556916703],
  [2500.0000000034456, 2465.5588468262813],
];

describe('inversion recovery with inversion efficiency A', () => {
  it('uses the derived signal equation, unchanged for A = 1', () => {
    for (const a of [0.5, 0.8, 0.9, 1]) {
      for (const ti of [10, 500, 2000]) {
        const s = inversionRecoverySignal(0.8, 900, ti, 2550, a);
        expect(s).toBeCloseTo(irSignal(0.8, 900, ti, 2550, a), 14);
      }
    }
    // A = 1: the classic form, to the last bit.
    const ti = 400;
    expect(inversionRecoverySignal(0.8, 900, ti, 2550)).toBe(
      0.8 * (1 - 2 * Math.exp(-ti / 900) + Math.exp(-2550 / 900)),
    );
    expect(inversionRecoverySignal(0.8, 900, ti, Infinity, 0.9)).toBeCloseTo(
      0.8 * (1 - 1.8 * Math.exp(-ti / 900)),
      15,
    );
    expect(MODELS['t1ir-a'].equation).toContain('(2A − 1) e<sup>−TR/T<sub>1</sub></sup>');
  });

  it('recovers A, T1 and M0 from noise-free data, signed or magnitude', () => {
    for (const c of cases()) {
      for (const magnitude of [false, true]) {
        const y = magnitude ? c.clean.map(Math.abs) : c.clean;
        const fit = fitCurve({ model: 't1ir-a', x: TI, y, tr: c.tr, magnitude });
        const label = `TR ${c.tr} T1 ${c.t1} A ${c.a}${magnitude ? ' magnitude' : ''}`;
        expect(Math.abs(fit.value / c.t1 - 1), label).toBeLessThan(1e-9);
        expect(Math.abs(fit.a - c.a), label).toBeLessThan(1e-9);
        expect(Math.abs(fit.m0 / M0 - 1), label).toBeLessThan(1e-9);
      }
    }
  });

  it('gives the same T1 as the pre-correction code, to fit precision', () => {
    cases().forEach((c, i) => {
      const [clean, noisy] = T1_BEFORE[i]!;
      const label = `TR ${c.tr} T1 ${c.t1} A ${c.a}`;
      const fitClean = fitCurve({ model: 't1ir-a', x: TI, y: c.clean, tr: c.tr });
      const fitNoisy = fitCurve({ model: 't1ir-a', x: TI, y: c.noisy, tr: c.tr });
      expect(Math.abs(fitClean.value / clean - 1), label).toBeLessThan(1e-8);
      expect(Math.abs(fitNoisy.value / noisy - 1), label).toBeLessThan(1e-7);
      // With noise the fitted T1 moves away from the truth, so the agreement is not trivial.
      if (c.tr === 2550 && c.t1 === 2500) expect(Math.abs(noisy / c.t1 - 1)).toBeGreaterThan(0.01);
    });
  });

  it('leaves the A = 1 model t1ir unchanged', () => {
    for (const c of cases().filter((c) => c.a === 1)) {
      const fit = fitCurve({ model: 't1ir', x: TI, y: c.clean, tr: c.tr });
      expect(Math.abs(fit.value / c.t1 - 1)).toBeLessThan(1e-9);
      expect(Math.abs(fit.m0 / M0 - 1)).toBeLessThan(1e-9);
      expect(fit.a).toBe(1);
      // The t1ir curve is the classic 1 - 2 e^(-TI/T1) + e^(-TR/T1), bit for bit.
      const curve = evaluateModel('t1ir', TI, { param: c.t1, m0: M0, a: 1, c: 0 }, { tr: c.tr });
      const k = 1 / c.t1;
      TI.forEach((ti, j) =>
        expect(curve[j]).toBe(M0 * (1 - 2 * Math.exp(-ti * k) + Math.exp(-c.tr * k))),
      );
    }
  });
});
