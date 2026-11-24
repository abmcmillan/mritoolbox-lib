/**
 * The fitter returns the global least-squares minimum over its search range,
 * to many more digits than the tools display. Checked against an independent
 * brute-force grid (tests/helpers/bruteforce.ts) on hard cases: magnitude
 * inversion recovery with A and few inversion times, offsets, low SNR, and a
 * measurement at the null.
 */
import { describe, expect, it } from 'vitest';
import { evaluateModel, Fitter, MODELS, OUT, type ModelId } from '../dist/index.js';
import { bruteForce, rateOf, sseAt, type Model, type Problem } from './helpers/bruteforce.ts';

/** Deterministic pseudo-random Gaussian noise. */
function gaussian(seed: number): () => number {
  let s = seed;
  const u = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s + 1) / 4294967297;
  };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

const IR7 = { x: [50, 100, 200, 400, 800, 1600, 3200], tr: 6000 };
const RRSG = { x: [50, 400, 1100, 2500], tr: 2550 };
/** Minimal protocols: number of parameters + 1 points. */
const IR4 = { x: [50, 1100, 2150, 3200], tr: 6000 };
const IR5 = { x: [50, 838, 1625, 2413, 3200], tr: 6000 };
const T2 = { x: [10, 20, 40, 60, 80, 120, 160, 240] };
const DWI = { x: [0, 50, 200, 400, 600, 800, 1000] };

interface Hard {
  name: string;
  model: Model;
  protocol: { x: number[]; tr?: number };
  truths: number[];
  snr: number[];
  magnitude: boolean;
  fitConstant: boolean;
  rician: boolean;
}

const HARD: Hard[] = [
  {
    name: 'magnitude IR with A, RRSG protocol',
    model: 't1ir-a',
    protocol: RRSG,
    truths: [100, 300, 800, 1500, 2000],
    snr: [5, 10, 20],
    magnitude: true,
    fitConstant: false,
    rician: true,
  },
  {
    name: 'magnitude IR with A, four TIs',
    model: 't1ir-a',
    protocol: IR4,
    truths: [100, 300, 800, 1500, 3000],
    snr: [5, 20],
    magnitude: true,
    fitConstant: false,
    rician: true,
  },
  {
    name: 'magnitude IR with A and C, five TIs',
    model: 't1ir-a',
    protocol: IR5,
    truths: [100, 300, 800, 1500, 3000],
    snr: [10, 50],
    magnitude: true,
    fitConstant: true,
    rician: false,
  },
  {
    name: 'magnitude IR with A, seven TIs',
    model: 't1ir-a',
    protocol: IR7,
    truths: [100, 300, 800, 1500, 3000],
    snr: [5, 10],
    magnitude: true,
    fitConstant: false,
    rician: true,
  },
  {
    name: 'magnitude IR with C, RRSG protocol',
    model: 't1ir',
    protocol: RRSG,
    truths: [100, 300, 800, 1500, 2000],
    snr: [5, 20],
    magnitude: true,
    fitConstant: true,
    rician: false,
  },
  {
    name: 'magnitude IR, seven TIs',
    model: 't1ir',
    protocol: IR7,
    truths: [100, 300, 800, 1500, 3000],
    snr: [5, 20],
    magnitude: true,
    fitConstant: false,
    rician: true,
  },
  {
    name: 'T2 with an offset',
    model: 't2',
    protocol: T2,
    truths: [20, 50, 100, 200, 500],
    snr: [5, 10],
    magnitude: false,
    fitConstant: true,
    rician: false,
  },
  {
    name: 'DWI with an offset',
    model: 'dwi',
    protocol: DWI,
    truths: [2e-4, 5e-4, 1e-3, 2e-3, 3e-3],
    snr: [5, 10],
    magnitude: false,
    fitConstant: true,
    rician: false,
  },
];

function curves(h: Hard, perCell: number, seed: number): Problem[] {
  const rand = gaussian(seed);
  const out: Problem[] = [];
  const opts = { ...(h.protocol.tr ? { tr: h.protocol.tr } : {}), fitConstant: h.fitConstant };
  for (const truth of h.truths) {
    const fit = {
      param: truth,
      m0: 1,
      a: h.model === 't1ir-a' ? 0.95 : 1,
      c: h.fitConstant ? 0.05 : 0,
    };
    const signed = evaluateModel(h.model, h.protocol.x, { ...fit, c: 0 }, opts);
    const shown = evaluateModel(h.model, h.protocol.x, fit, { ...opts, magnitude: h.magnitude });
    const top = Math.max(...Array.from(signed, Math.abs));
    for (const snr of h.snr) {
      const sigma = top / snr;
      for (let r = 0; r < perCell; r++) {
        const y = Array.from(shown, (v, i) =>
          h.rician ? Math.hypot(signed[i]! + sigma * rand(), sigma * rand()) : v + sigma * rand(),
        );
        out.push({
          model: h.model,
          x: h.protocol.x,
          y,
          magnitude: h.magnitude,
          fitConstant: h.fitConstant,
          range: MODELS[h.model as ModelId].range,
          ...(h.protocol.tr ? { tr: h.protocol.tr } : {}),
        });
      }
    }
  }
  return out;
}

function fitProblem(p: Problem, init?: { param: number; m0: number }): Float64Array {
  const fitter = new Fitter(p.model, p.x, {
    ...(p.tr ? { tr: p.tr } : {}),
    magnitude: p.magnitude ?? false,
    fitConstant: p.fitConstant ?? false,
    range: [p.range[0], p.range[1]],
  });
  const out = new Float64Array(OUT.size);
  expect(fitter.fit(p.y, 0, out, 0, init)).toBe(true);
  return out;
}

describe('global minimum', () => {
  for (const h of HARD) {
    it(`is at or below a brute-force grid: ${h.name}`, () => {
      for (const p of curves(h, 2, 11)) {
        const out = fitProblem(p);
        const brute = bruteForce(p);
        const scale = p.y.reduce((s, v) => s + v * v, 0);
        expect(out[OUT.sse]!).toBeLessThanOrEqual(brute.sse * (1 + 1e-9) + 1e-14 * scale);
      }
    });
  }

  it('finds the lower of the two minima beside a measurement at the null', () => {
    // Magnitude IR with the TI = 200 ms point near the null: the profile has a peak where the
    // null falls on 200 ms and a minimum about 1 % to either side, closer than the profile grid.
    const p: Problem = {
      model: 't1ir',
      ...IR7,
      y: [0.7522, 0.3988, 0.0124, 0.5244, 0.8686, 0.9497, 0.9866],
      magnitude: true,
      range: MODELS.t1ir.range,
    };
    const out = fitProblem(p);
    const brute = bruteForce({ ...p, range: [250, 330] }, 20000);
    expect(out[OUT.sse]!).toBeLessThanOrEqual(brute.sse * (1 + 1e-12));
    expect(out[OUT.param]! / brute.param).toBeCloseTo(1, 4);
    // A start in the other minimum does not trap the fit.
    const started = fitProblem(p, { param: 290, m0: 1 });
    expect(started[OUT.param]).toBe(out[OUT.param]);
  });
});

describe('precision', () => {
  const cases: { model: ModelId; x: number[]; tr?: number; param: number }[] = [
    { model: 't2', ...T2, param: 85 },
    { model: 'dwi', ...DWI, param: 8e-4 },
    { model: 't1ir', ...IR7, param: 1100 },
    { model: 't1ir-a', ...IR7, param: 1100 },
    { model: 't1vfa', x: [2, 4, 6, 10, 15, 20, 30], tr: 15, param: 1200 },
  ];
  for (const c of cases) {
    for (const magnitude of c.model.startsWith('t1ir') ? [false, true] : [false]) {
      for (const fitConstant of [false, true]) {
        it(`recovers noise-free ${c.model}${magnitude ? ' magnitude' : ''}${fitConstant ? ' with C' : ''} to 1e-8`, () => {
          const opts = { ...(c.tr ? { tr: c.tr } : {}), magnitude, fitConstant };
          const truth = {
            param: c.param,
            m0: 1000,
            a: c.model === 't1ir-a' ? 0.9 : 1,
            c: fitConstant ? 40 : 0,
          };
          const y = evaluateModel(c.model, c.x, truth, opts);
          const out = new Float64Array(OUT.size);
          expect(new Fitter(c.model, c.x, opts).fit(y, 0, out)).toBe(true);
          expect(Math.abs(out[OUT.param]! / c.param - 1)).toBeLessThan(1e-8);
        });
      }
    }
  }

  it('stops at a minimum of the profile to 1e-7 in noisy data', () => {
    const rand = gaussian(3);
    for (const c of cases.filter((q) => q.model !== 't1ir-a')) {
      for (const magnitude of c.model === 't1ir' ? [false, true] : [false]) {
        for (const fitConstant of [false, true]) {
          const opts = { ...(c.tr ? { tr: c.tr } : {}), magnitude, fitConstant };
          const clean = evaluateModel(c.model, c.x, { param: c.param, m0: 1, a: 1, c: 0 }, opts);
          for (let r = 0; r < 5; r++) {
            const y = Array.from(clean, (v) => v + 0.02 * rand());
            const out = new Float64Array(OUT.size);
            new Fitter(c.model, c.x, opts).fit(y, 0, out);
            const p: Problem = { model: c.model, x: c.x, y, ...opts, range: MODELS[c.model].range };
            const k = rateOf(c.model, out[OUT.param]!);
            const here = sseAt(p, k, 1);
            for (const step of [1 - 1e-7, 1 + 1e-7]) {
              expect(sseAt(p, k * step, 1)).toBeGreaterThanOrEqual(here * (1 - 1e-14));
            }
          }
        }
      }
    }
  });

  it('reports a minimum beyond the range at the bound', () => {
    const y = evaluateModel('t2', T2.x, { param: 50, m0: 1, a: 1, c: 0 });
    const out = new Float64Array(OUT.size);
    new Fitter('t2', T2.x, { range: [100, 400] }).fit(y, 0, out);
    expect(out[OUT.param]! / 100).toBeCloseTo(1, 12);
    const high = new Float64Array(OUT.size);
    new Fitter('t2', T2.x, { range: [10, 25] }).fit(y, 0, high);
    expect(high[OUT.param]! / 25).toBeCloseTo(1, 12);
  });
});
