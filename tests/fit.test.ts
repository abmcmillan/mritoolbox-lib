import { describe, expect, it } from 'vitest';
import { evaluateModel, Fitter, MODEL_ORDER, type ModelId, MODELS, OUT } from '../dist/index.js';

/** Deterministic pseudo-random Gaussian noise. */
function gaussian(seed: number): () => number {
  let s = seed;
  const u = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s + 1) / 4294967297;
  };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

const CASES: { id: ModelId; x: number[]; param: number; tr?: number }[] = [
  { id: 't2', x: [10, 20, 40, 60, 80, 120, 160, 240], param: 85 },
  { id: 'dwi', x: [0, 50, 200, 400, 600, 800, 1000], param: 0.0008 },
  { id: 't1ir', x: [50, 100, 200, 400, 800, 1600, 3200], param: 1100, tr: 6000 },
  { id: 't1ir-a', x: [50, 100, 200, 400, 800, 1600, 3200], param: 1100, tr: 6000 },
  { id: 't1vfa', x: [2, 4, 6, 10, 15, 20, 30], param: 1200, tr: 15 },
];

describe('Fitter', () => {
  for (const c of CASES) {
    for (const fitConstant of [false, true]) {
      it(`recovers ${c.id}${fitConstant ? ' with constant' : ''} from noise-free data`, () => {
        const truth = {
          param: c.param,
          m0: 1000,
          a: c.id === 't1ir-a' ? 0.9 : 1,
          c: fitConstant ? 40 : 0,
        };
        const opts = { ...(c.tr ? { tr: c.tr } : {}), fitConstant };
        const y = evaluateModel(c.id, c.x, truth, opts);
        const fitter = new Fitter(c.id, c.x, opts);
        const out = new Float64Array(OUT.size);
        expect(fitter.fit(y, 0, out)).toBe(true);
        expect(out[OUT.param]! / truth.param).toBeCloseTo(1, 4);
        // With TR >> T1, M0, A and C are jointly degenerate; only T1 is identifiable.
        if (!(c.id === 't1ir-a' && fitConstant)) {
          expect(out[OUT.m0]! / truth.m0).toBeCloseTo(1, 4);
          expect(out[OUT.c]!).toBeCloseTo(truth.c, 1);
          if (c.id === 't1ir-a') expect(out[OUT.a]!).toBeCloseTo(0.9, 4);
        }
        expect(out[OUT.r2]!).toBeGreaterThan(0.999999);
      });
    }
  }

  it('takes the magnitude of signed data when fitting magnitudes', () => {
    const ti = [50, 150, 400, 800, 1500, 2500, 4000];
    const truth = { param: 900, m0: 1000, a: 1, c: 0 };
    const signed = evaluateModel('t1ir', ti, truth, { tr: 8000, magnitude: false });
    expect(signed.some((v) => v < 0)).toBe(true);
    const run = (y: ArrayLike<number>): Float64Array => {
      const out = new Float64Array(OUT.size);
      expect(new Fitter('t1ir', ti, { tr: 8000, magnitude: true }).fit(y, 0, out)).toBe(true);
      return out;
    };
    const fromSigned = run(signed);
    const fromMagnitude = run(Array.from(signed, Math.abs));
    expect(fromSigned[OUT.param]).toBeCloseTo(900, 3);
    expect(fromSigned[OUT.m0]).toBeCloseTo(1000, 3);
    expect(Array.from(fromSigned)).toEqual(Array.from(fromMagnitude));
    // Mixed signs (a partly rectified series) give the same answer as well.
    const mixed = Array.from(signed, (v, n) => (n % 2 ? Math.abs(v) : v));
    expect(run(mixed)[OUT.param]).toBeCloseTo(900, 3);
    // The caller's data are left untouched.
    expect(signed.some((v) => v < 0)).toBe(true);
  });

  it('fits magnitude inversion-recovery data', () => {
    const x = [50, 100, 200, 400, 800, 1600, 3200];
    const opts = { tr: 6000, magnitude: true };
    const y = evaluateModel('t1ir', x, { param: 900, m0: 500, a: 1, c: 0 }, opts);
    expect(Math.min(...y)).toBeGreaterThanOrEqual(0);
    const out = new Float64Array(OUT.size);
    new Fitter('t1ir', x, opts).fit(y, 0, out);
    expect(out[OUT.param]!).toBeCloseTo(900, 1);
    expect(out[OUT.m0]!).toBeCloseTo(500, 1);
  });

  it('is unbiased within noise and reports sensible standard errors', () => {
    const x = [10, 20, 40, 60, 80, 120, 160, 240];
    const rand = gaussian(7);
    const fitter = new Fitter('t2', x);
    const out = new Float64Array(OUT.size);
    let sum = 0;
    let se = 0;
    const trials = 400;
    const estimates: number[] = [];
    for (let t = 0; t < trials; t++) {
      const y = Array.from(
        evaluateModel('t2', x, { param: 85, m0: 1000, a: 1, c: 0 }),
        (v) => v + 10 * rand(),
      );
      fitter.fit(y, 0, out);
      sum += out[OUT.param]!;
      estimates.push(out[OUT.param]!);
      se += fitter.standardErrors(out[OUT.sse]!)[0];
    }
    const mean = sum / trials;
    const sd = Math.sqrt(estimates.reduce((a, v) => a + (v - mean) ** 2, 0) / (trials - 1));
    expect(mean).toBeGreaterThan(84.5);
    expect(mean).toBeLessThan(85.5);
    expect(se / trials / sd).toBeGreaterThan(0.8);
    expect(se / trials / sd).toBeLessThan(1.25);
  });

  it('honours user initial parameters and offsets into a packed array', () => {
    const x = [0, 500, 1000];
    const y = [0, 0, 0, ...evaluateModel('dwi', x, { param: 0.001, m0: 200, a: 1, c: 0 })];
    const out = new Float32Array(2 * OUT.size);
    new Fitter('dwi', x).fit(y, 3, out, OUT.size, { param: 0.002, m0: 100 });
    expect(out[OUT.size + OUT.param]!).toBeCloseTo(0.001, 6);
  });

  it('rejects under-determined problems', () => {
    expect(() => new Fitter('t1ir-a', [100, 200], { tr: 5000 })).toThrow(/at least 3/);
    expect(() => new Fitter('t1vfa', [5, 10, 15])).toThrow(/TR/);
  });

  it('ships example data that fit their own model well', () => {
    for (const id of MODEL_ORDER) {
      const ex = MODELS[id].example;
      const out = new Float64Array(OUT.size);
      new Fitter(id, ex.x, ex.tr ? { tr: ex.tr } : {}).fit(ex.y, 0, out);
      expect(out[OUT.r2]!, id).toBeGreaterThan(0.995);
    }
  });
});
