import { describe, expect, it } from 'vitest';
import { simulateMprage, simulateMprageImage } from '../dist/index.js';
import { epg2012 } from './helpers/epg2012.ts';
import { convergedIsochromats, maxDifference } from './helpers/isochromat.ts';

const WM = { pd: 0.69, t1: 830, t2: 80 };
const CSF = { pd: 1, t1: 4000, t2: 2000 };
// The case pinned in lib.test.ts and tests/node (the previous site's example).
const SITE_SEQ = { flipAngle: 9, spoilIncrement: 50, tr: 7, td1: 330, td2: 830, np: 160 };
const SITE_A = { pd: 1, t1: 1450, t2: 100 };
const SITE_B = { pd: 0.92, t1: 750, t2: 75 };

type Tissue = typeof WM;
type Sequence = typeof SITE_SEQ;

/**
 * Largest deviation from the converged isochromat simulation, run for the same
 * number of inversion cycles as the EPG, for the corrected code and for the
 * 2012 algorithm.
 */
function againstIsochromats(tissue: Tissue, seq: Sequence): { fixed: number; old: number } {
  const fixed = simulateMprage(tissue, seq);
  const old = epg2012(tissue, seq);
  const iso = convergedIsochromats(tissue, seq, fixed.loops);
  const isoOld = old.loops === fixed.loops ? iso : convergedIsochromats(tissue, seq, old.loops);
  return { fixed: maxDifference(fixed, iso), old: maxDifference(old, isoOld) };
}

describe('MP-RAGE EPG against an isochromat simulation', () => {
  for (const [name, tissue] of [
    ['WM-like', WM],
    ['CSF-like', CSF],
  ] as const) {
    for (const np of [32, 176]) {
      it(`matches for ${name} tissue, np ${np}; the 2012 algorithm does not`, () => {
        for (const flipAngle of [8, 20]) {
          for (const spoilIncrement of [0, 50, 117]) {
            const seq = { flipAngle, spoilIncrement, tr: 8, td1: 900, td2: 1000, np };
            const d = againstIsochromats(tissue, seq);
            const label = `${name} np ${np} flip ${flipAngle} increment ${spoilIncrement}`;
            expect(d.fixed, label).toBeLessThanOrEqual(1e-6);
            expect(d.old, label).toBeGreaterThan(1e-6);
          }
        }
      });
    }
  }

  it('matches on the pinned previous-site case, which justifies its new values', () => {
    for (const tissue of [SITE_A, SITE_B]) {
      const d = againstIsochromats(tissue, SITE_SEQ);
      expect(d.fixed).toBeLessThanOrEqual(1e-6);
      expect(d.old).toBeGreaterThan(1e-6);
    }
  });
});

describe('MP-RAGE EPG first inversion cycle', () => {
  it('equals the 2012 algorithm exactly with maxLoops 1', () => {
    for (const tissue of [WM, CSF, SITE_A, SITE_B]) {
      for (const spoilIncrement of [0, 50, 117]) {
        const seq = { ...SITE_SEQ, spoilIncrement };
        const fixed = simulateMprage(tissue, { ...seq, maxLoops: 1 });
        const old = epg2012(tissue, seq, 1);
        expect(fixed.loops).toBe(1);
        expect(fixed.steadyState).toBe(false);
        expect(Array.from(fixed.re)).toEqual(Array.from(old.re));
        expect(Array.from(fixed.im)).toEqual(Array.from(old.im));
      }
    }
  });

  it('equals the 2012 Java (setMaxLoops(1)) on the previous-site case', () => {
    // EPG_MPRAGE.java at uw-rad-mitrp/MPRAGE_Simulator 760e61f, run with
    // setSeqParams(9, 50, 7, 330, 830, 160): pulse, Re and Im of the signal.
    const java: Record<'A1' | 'B1' | 'A25' | 'B25', [number, number, number][]> = {
      A1: [
        [0, -0.07105151861070685, 0.05961930306082977],
        [1, -0.04520734141801361, -0.07830141221111243],
        [80, 0.011066034975459755, -0.0006554729123077464],
        [159, -0.02310575557838956, -0.027337483284486278],
      ],
      B1: [
        [0, -0.03175971179198472, 0.026649562450951087],
        [1, -0.019615756126479752, -0.03397548623994341],
        [80, 0.0446724866802476, -0.0002456939839625236],
        [159, -0.038100370774283694, -0.04515600047630611],
      ],
      // The default 25 loops: the 2012 multi-cycle result, which epg2012 reproduces.
      A25: [
        [0, -0.03023473162335136, 0.025369952153898173],
        [80, 0.024074963455720893, -0.0005102013482017854],
        [159, -0.02511022177022554, -0.0296986868728922],
      ],
      B25: [
        [0, -0.017806304176435313, 0.014941263267077334],
        [80, 0.04785131607658851, -0.0002748713055672899],
        [159, -0.03844579787494933, -0.04556305170415467],
      ],
    };
    const check = (got: { re: Float64Array; im: Float64Array }, rows: [number, number, number][]) => {
      for (const [j, re, im] of rows) {
        expect(Math.abs(got.re[j]! - re), `pulse ${j}`).toBeLessThan(1e-15);
        expect(Math.abs(got.im[j]! - im), `pulse ${j}`).toBeLessThan(1e-15);
      }
    };
    check(simulateMprage(SITE_A, { ...SITE_SEQ, maxLoops: 1 }), java.A1);
    check(simulateMprage(SITE_B, { ...SITE_SEQ, maxLoops: 1 }), java.B1);
    check(epg2012(SITE_A, SITE_SEQ), java.A25);
    check(epg2012(SITE_B, SITE_SEQ), java.B25);
    // After the first cycle the corrected code departs from the Java.
    const later = simulateMprage(SITE_A, SITE_SEQ);
    expect(Math.abs(later.re[80]! - java.A25[1]![1])).toBeGreaterThan(1e-5);
  });
});

describe('MP-RAGE maxLoops', () => {
  it('defaults to 25 cycles', () => {
    const seq = { ...SITE_SEQ, td1: 0, td2: 0 };
    const byDefault = simulateMprage(CSF, seq);
    expect(byDefault.loops).toBe(25);
    expect(simulateMprage(CSF, { ...seq, maxLoops: 25 })).toEqual(byDefault);
    expect(simulateMprage(CSF, { ...seq, maxLoops: 3 }).loops).toBe(3);
  });

  it('accepts only whole numbers from 1 to 1000', () => {
    for (const maxLoops of [0, -1, 1.5, 1001, NaN, Infinity]) {
      expect(() => simulateMprage(WM, { ...SITE_SEQ, maxLoops })).toThrow(/maxLoops/);
      expect(() => simulateMprageImage(WM, CSF, { ...SITE_SEQ, maxLoops })).toThrow(/maxLoops/);
    }
    expect(simulateMprageImage(WM, CSF, { ...SITE_SEQ, maxLoops: 1 }).loops).toEqual([1, 1]);
  });

  it('leaves ideal spoiling as it was', () => {
    for (const tissue of [WM, CSF]) {
      const seq = { ...SITE_SEQ, idealSpoiling: true };
      const fixed = simulateMprage(tissue, seq);
      const old = epg2012(tissue, seq);
      expect(fixed.loops).toBe(old.loops);
      expect(Array.from(fixed.re)).toEqual(Array.from(old.re));
      expect(Array.from(fixed.im)).toEqual(Array.from(old.im));
    }
  });
});
