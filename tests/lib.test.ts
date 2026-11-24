import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  InvalidInputError,
  checkFit,
  DATABASE,
  RAW_DATABASE,
  fitCurve,
  searchDatabase,
  DEG,
  ernstAngleDeg,
  optimiseContrast,
  simulateMprage,
  simulateMprageImage,
  spgrSignal,
} from '../dist/index.js';

describe('Ernst angle', () => {
  it('matches the values of the previous site', () => {
    expect(ernstAngleDeg(750, 10)).toBeCloseTo(9.336, 3);
    expect(ernstAngleDeg(1450, 10)).toBeCloseTo(6.721, 3);
  });
  it('maximises the SPGR signal', () => {
    const peak = ernstAngleDeg(1000, 20);
    const s = (deg: number): number => spgrSignal(1, 1000, 1e9, 20, 0, deg * DEG);
    expect(s(peak)).toBeGreaterThan(s(peak - 0.5));
    expect(s(peak)).toBeGreaterThan(s(peak + 0.5));
  });
});

describe('Contrastinator', () => {
  const tissues: [{ pd: number; t1: number; t2: number }, { pd: number; t1: number; t2: number }] =
    [
      { pd: 0.92, t1: 750, t2: 75 },
      { pd: 1, t1: 1450, t2: 100 },
    ];
  it('GRE reproduces the previous site', () => {
    const r = optimiseContrast({ mode: 'gre', tissues, te: 5, tr: 100 });
    expect(r.optimum).toBeCloseTo(45, 0);
    expect(r.signals[0]).toBeCloseTo(0.199, 3);
    expect(r.signals[1]).toBeCloseTo(0.132, 3);
    expect(r.ratio).toBeCloseTo(1.512, 2);
  });
  it('T1-weighted SE finds the analytic optimum TR', () => {
    const r = optimiseContrast({ mode: 'se-t1', tissues, te: 5 });
    const a1 = 0.92 * Math.exp(-5 / 75);
    const a2 = Math.exp(-5 / 100);
    const analytic = Math.log((a1 * 1450) / (a2 * 750)) / (1 / 750 - 1 / 1450);
    expect(r.optimum).toBeCloseTo(analytic, 3);
    expect(r.signals[0]).toBeCloseTo(0.59, 2);
    expect(r.signals[1]).toBeCloseTo(0.428, 2);
  });
  it('T2-weighted SE warns when TR is short and no optimum exists', () => {
    const r = optimiseContrast({ mode: 'se-t2', tissues, tr: 100 });
    expect(r.optimum).toBeLessThan(0.01);
    expect(r.warnings.length).toBe(2);
  });
  it('T2-weighted SE finds an interior TE with long TR', () => {
    const r = optimiseContrast({ mode: 'se-t2', tissues, tr: 5000 });
    expect(r.optimum).toBeGreaterThan(20);
    expect(r.warnings).toEqual([]);
  });
});

describe('MP-RAGE EPG simulation', () => {
  const seq = { flipAngle: 9, spoilIncrement: 50, tr: 7, td1: 330, td2: 830, np: 160 };
  const a = { pd: 1, t1: 1450, t2: 100 };
  const b = { pd: 0.92, t1: 750, t2: 75 };
  it('gives the corrected values on the previous site case', () => {
    // The 2012 algorithm gave 0.024424690025312324 and 0.047124053975078295.
    // These values are the corrected code's; tests/epg.test.ts shows that its
    // signal trains for both tissues match an isochromat simulation to 1e-6.
    const r = simulateMprageImage(a, b, seq);
    expect(r.signalA).toBeCloseTo(0.02435879570540178, 12);
    expect(r.signalB).toBeCloseTo(0.047107333947596135, 12);
    expect(r.steadyState).toBe(true);
  });
  it('ideal spoiling gives a smooth approach to steady state', () => {
    const r = simulateMprage(b, { ...seq, idealSpoiling: true });
    const mag = Array.from(r.re, (re, i) => Math.hypot(re, r.im[i]!));
    expect(mag.every(Number.isFinite)).toBe(true);
    expect(mag[159]!).toBeGreaterThan(0);
  });
});

describe('database', () => {
  it('ships every record, normalised, and keeps the published file as its source', () => {
    const file = JSON.parse(
      readFileSync('data/parameter-database.json', 'utf8'),
    ) as unknown[];
    expect(RAW_DATABASE).toEqual(file);
    expect(DATABASE.length).toBe(232);
    expect(DATABASE.every((e) => e.field > 0 && e.pmid !== '' && e.tissue !== '')).toBe(true);
  });

  it('matches every word, filters by field and sorts alphabetically', () => {
    const liver = searchDatabase('liver', 3);
    expect(liver.length).toBeGreaterThan(0);
    expect(liver.every((e) => e.field === 3 && e.haystack.includes('liver'))).toBe(true);
    const all = searchDatabase('');
    expect(all.length).toBe(232);
    expect(
      all.every((e, i) => i === 0 || all[i - 1]!.tissue.localeCompare(e.tissue, 'en') <= 0),
    ).toBe(true);
    expect(searchDatabase('white matter brain').length).toBeGreaterThan(0);
    expect(searchDatabase('no such tissue')).toEqual([]);
  });
});

describe('fitCurve', () => {
  it('fits a T2 decay from plain arrays and reports uncertainty', () => {
    const x = [10, 20, 40, 60, 80, 120, 160, 240];
    const y = x.map((te) => 1000 * Math.exp(-te / 85));
    const fit = fitCurve({ model: 't2', x, y });
    expect(fit.parameter).toEqual({ name: 'T2', unit: 'ms' });
    expect(fit.value).toBeCloseTo(85, 4);
    expect(fit.m0).toBeCloseTo(1000, 3);
    expect(fit.r2).toBeCloseTo(1, 8);
    expect(fit.predicted.length).toBe(x.length);
    expect(fit.standardError.value).toBeGreaterThanOrEqual(0);
  });

  it('fits magnitude inversion recovery from signed data', () => {
    const x = [50, 150, 400, 800, 1500, 2500, 4000];
    const y = x.map((ti) => 1000 * (1 - 2 * Math.exp(-ti / 900) + Math.exp(-8000 / 900)));
    expect(fitCurve({ model: 't1ir', x, y, tr: 8000, magnitude: true }).value).toBeCloseTo(900, 3);
  });

  it('explains bad input', () => {
    expect(() => fitCurve({ model: 't2', x: [1, 2, 3], y: [1, 2] })).toThrow(
      /x has 3 values but y has 2/,
    );
    expect(() => fitCurve({ model: 't1vfa', x: [2, 5, 10], y: [1, 2, 3] })).toThrow(
      /repetition time/,
    );
  });
});

describe('input checks', () => {
  const wm = { pd: 0.69, t1: 830, t2: 53 };
  const gm = { pd: 0.82, t1: 1330, t2: 66 };

  it('rejects a TE that is not shorter than TR, and other impossible contrast inputs', () => {
    const gre = (te: number, tr: number): unknown =>
      optimiseContrast({ mode: 'gre', tissues: [wm, gm], te, tr });
    expect(() => gre(120, 100)).toThrow(/TE \(120 ms\) must be shorter than TR \(100 ms\)/);
    expect(() => gre(100, 100)).toThrow(InvalidInputError);
    expect(() => gre(-1, 100)).toThrow(/TE cannot be negative/);
    expect(() => gre(5, 0)).toThrow(/TR must be greater than zero/);
    expect(() =>
      optimiseContrast({
        mode: 'gre',
        tissues: [
          { ...wm, pd: 1.4 },
          { ...gm, t1: -5 },
        ],
        te: 5,
        tr: 100,
      }),
    ).toThrow(
      /PD of tissue 1 must be between 0 and 1\. T1 of tissue 2 must be greater than zero\./,
    );
    expect(() => gre(5, 100)).not.toThrow();
  });

  it('keeps the optimised spin-echo timing consistent with the fixed one', () => {
    // T2-weighted: TE is searched no further than TR.
    const t2w = optimiseContrast({ mode: 'se-t2', tissues: [wm, gm], tr: 60 });
    expect(t2w.optimum).toBeLessThanOrEqual(60);
    expect(Math.max(...t2w.curve.x)).toBeLessThanOrEqual(60);
    // T1-weighted: TR is searched no shorter than TE.
    const t1w = optimiseContrast({ mode: 'se-t1', tissues: [wm, gm], te: 15 });
    expect(t1w.optimum).toBeGreaterThanOrEqual(15);
    expect(Math.min(...t1w.curve.x)).toBeGreaterThanOrEqual(15);
  });

  it('warns when T2 exceeds T1 for spin echo but not for the gradient-echo T2* trick', () => {
    const odd = { pd: 0.8, t1: 500, t2: 10000 };
    expect(
      optimiseContrast({ mode: 'se-t1', tissues: [odd, gm], te: 10 }).warnings.join(' '),
    ).toMatch(/T2 of tissue 1 .* longer than its T1/);
    expect(
      optimiseContrast({ mode: 'gre', tissues: [odd, gm], te: 5, tr: 100 }).warnings.join(' '),
    ).not.toMatch(/longer than its T1/);
  });

  it('checks curve-fitting inputs for each model', () => {
    expect(checkFit('t1ir', [50, 400, 3000], { tr: 2000 }).errors.join(' ')).toMatch(
      /Every inversion time must be shorter than TR: the longest is 3000 ms and TR is 2000 ms/,
    );
    expect(checkFit('t1ir', [50, 400, 3000], {}).errors).toEqual([]); // fully relaxed
    expect(checkFit('t2', [-10, 20, 40]).errors.join(' ')).toMatch(/Echo times cannot be negative/);
    expect(checkFit('dwi', [0, -500, 1000]).errors.join(' ')).toMatch(/cannot be negative/);
    expect(checkFit('t1vfa', [0, 10, 20], { tr: 15 }).errors.join(' ')).toMatch(/greater than 0°/);
    expect(checkFit('t1vfa', [5, 10, 190], { tr: 15 }).errors.join(' ')).toMatch(/less than 180°/);
    expect(checkFit('t1vfa', [5, 10, 120], { tr: 15 }).warnings.join(' ')).toMatch(/above 90°/);
    expect(checkFit('t2', [20, 20, 20, 20]).errors.join(' ')).toMatch(
      /at least 2 different echo times/,
    );
    expect(checkFit('t2', [10, 20, 40], { tr: -5 }).errors.join(' ')).toMatch(
      /TR must be greater than zero/,
    );
    expect(checkFit('t2', [10, 20, 40, 80])).toEqual({ errors: [], warnings: [] });
  });

  it('makes fitCurve refuse what cannot be fitted and pass warnings on', () => {
    expect(() =>
      fitCurve({ model: 't1ir', x: [50, 400, 3000], y: [-800, -200, 900], tr: 2000 }),
    ).toThrow(/shorter than TR/);
    expect(() => fitCurve({ model: 't2', x: [10, 20, 40], y: [900, NaN, 600] })).toThrow(
      /Every measurement in y must be a number/,
    );
    expect(
      fitCurve({ model: 't2', x: [10, 20, 40, 80], y: [889, 791, 624, 390] }).warnings,
    ).toEqual([]);
  });

  it('checks MP-RAGE inputs', () => {
    const seq = { flipAngle: 9, spoilIncrement: 50, tr: 8, td1: 900, td2: 1000, np: 160 };
    const a = { pd: 0.69, t1: 830, t2: 80 };
    const b = { pd: 0.82, t1: 1330, t2: 110 };
    expect(() => simulateMprageImage(a, b, { ...seq, np: 161 })).toThrow(/even whole number/);
    expect(() => simulateMprageImage(a, b, { ...seq, flipAngle: 0 })).toThrow(/flip angle/);
    expect(() => simulateMprageImage(a, b, { ...seq, td1: -1 })).toThrow(/cannot be negative/);
    expect(() => simulateMprageImage({ ...a, t2: 0 }, b, seq)).toThrow(/T2 of tissue A/);
    expect(simulateMprageImage(a, b, { ...seq, flipAngle: 45 }).warnings.join(' ')).toMatch(
      /far above/,
    );
    expect(simulateMprageImage(a, b, seq).warnings).toEqual([]);
  });
});
