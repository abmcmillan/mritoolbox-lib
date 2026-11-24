#!/usr/bin/env node
/**
 * How dense the fitter's profile grid must be, and how tight its refinement.
 *
 *   npm run build && node scripts/fit-study.mjs [--realizations 100] [--seed 1]
 *
 * Builds copies of dist/ that differ only in POINTS_PER_DECADE or REFINE_TOL
 * (src/fit/lm.ts), fits the same synthetic curves with each, and compares
 * them with a grid 32 times finer than the densest candidate:
 *
 *  - a miss is a curve whose estimate differs from the fine grid's by more
 *    than half a unit in the 4th significant digit (the precision the tools
 *    display) while its sum of squares is higher (relative 1e-9);
 *  - precision is the largest relative difference from a run at
 *    REFINE_TOL = 1e-13, among curves that are not misses;
 *  - time is the mean time of Fitter.fit per curve in this Node; with
 *    --baseline <dist dir> the same curves are also timed with that build,
 *    per configuration.
 *
 * Curves: every configuration of the paper's noisy-curve study (models,
 * protocols, offsets, magnitude, Gaussian or Rician noise, SNR 5 to 200),
 * plus magnitude inversion recovery with an offset and the minimal
 * protocols (number of parameters + 1 points), all with this script's own
 * random numbers.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    realizations: { type: 'string', default: '100' },
    seed: { type: 'string', default: '1' },
    densities: { type: 'string', default: '2,4,8,16,32,64' },
    tolerances: { type: 'string', default: '1e-6,1e-8,1e-9,1e-10' },
    density: { type: 'string', default: '8' },
    near: { type: 'string', default: '1,2,1000000000' },
    baseline: { type: 'string' },
  },
});
const R = Number(values.realizations);
const densities = values.densities.split(',').map(Number);
const tolerances = values.tolerances.split(',');
const FINE = 32 * Math.max(...densities);

const dist = new URL('../dist/', import.meta.url).pathname;
const source = readFileSync(join(dist, 'fit/lm.js'), 'utf8');
const work = mkdtempSync(join(tmpdir(), 'fit-study-'));
let copies = 0;
async function variant(ppd, tol, near = 1e9) {
  const dir = join(work, String(copies++));
  cpSync(dist, dir, { recursive: true });
  const PPD = /const POINTS_PER_DECADE = [^;]+;/u;
  const TOL = /const REFINE_TOL = [^;]+;/u;
  const NEAR = /const SIGN_NEAR = [^;]+;/u;
  if (![PPD, TOL, NEAR].every((re) => re.test(source)))
    throw new Error('constants not found in dist/fit/lm.js');
  const text = source
    .replace(PPD, `const POINTS_PER_DECADE = ${ppd};`)
    .replace(TOL, `const REFINE_TOL = ${tol};`)
    .replace(NEAR, `const SIGN_NEAR = ${near};`);
  writeFileSync(join(dir, 'fit/lm.js'), text);
  return import(join(dir, 'index.js'));
}

// xorshift128+ and Box-Muller: this script's own random numbers.
let s0 = 0x9e3779b9 ^ Number(values.seed);
let s1 = 0x85ebca6b;
function uniform() {
  let a = s0;
  const b = s1;
  s0 = b;
  a ^= a << 23;
  a ^= a >>> 17;
  a ^= b ^ (b >>> 26);
  s1 = a;
  return ((s0 + s1) >>> 0) / 4294967296 + 1 / 8589934592;
}
const normal = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());

const P = {
  t2: { x: [10, 20, 40, 60, 80, 120, 160, 240] },
  dwi: { x: [0, 50, 200, 400, 600, 800, 1000] },
  ir: { x: [50, 100, 200, 400, 800, 1600, 3200], tr: 6000 },
  rrsg: { x: [50, 400, 1100, 2500], tr: 2550 },
  vfa: { x: [2, 4, 6, 10, 15, 20, 30], tr: 15 },
};
const T = {
  t2: [20, 50, 100, 200, 500],
  dwi: [2e-4, 5e-4, 1e-3, 2e-3, 3e-3],
  ir: [100, 300, 800, 1500, 3000],
  rrsg: [100, 300, 800, 1500, 2000],
  vfa: [300, 600, 1000, 1500, 2500],
};
const minimal = (x, m) =>
  Array.from({ length: m + 1 }, (_, i) => Math.round(x[0] + ((x[x.length - 1] - x[0]) * i) / m));
// [model, protocol, truths, magnitude, fitConstant, noise]
const CONFIGS = [
  ['t2', P.t2, T.t2, false, false, 'g'],
  ['t2', P.t2, T.t2, false, false, 'r'],
  ['t2', P.t2, T.t2, false, true, 'g'],
  ['t2', P.t2, T.t2, false, true, 'r'],
  ['dwi', P.dwi, T.dwi, false, false, 'g'],
  ['dwi', P.dwi, T.dwi, false, false, 'r'],
  ['dwi', P.dwi, T.dwi, false, true, 'g'],
  ['dwi', P.dwi, T.dwi, false, true, 'r'],
  ['t1ir', P.ir, T.ir, false, false, 'g'],
  ['t1ir', P.ir, T.ir, true, false, 'r'],
  ['t1ir-a', P.ir, T.ir, false, false, 'g'],
  ['t1ir-a', P.ir, T.ir, true, false, 'r'],
  ['t1ir-a', P.rrsg, T.rrsg, true, false, 'r'],
  ['t1vfa', P.vfa, T.vfa, false, false, 'g'],
  ['t1vfa', P.vfa, T.vfa, false, false, 'r'],
  // Harder still: magnitude with an offset, signed imperfect inversion with an offset,
  // and the minimal protocols.
  ['t1ir', P.rrsg, T.rrsg, true, true, 'g'],
  ['t1ir-a', P.ir, T.ir, true, true, 'g'],
  ['t1ir-a', P.rrsg, T.rrsg, true, true, 'g'],
  ['t1ir-a', P.ir, T.ir, false, true, 'g'],
  ['t1ir-a', { x: minimal(P.ir.x, 3), tr: 6000 }, T.ir, true, false, 'r'],
  ['t1ir-a', { x: minimal(P.ir.x, 4), tr: 6000 }, T.ir, true, true, 'g'],
  ['t2', { x: minimal(P.t2.x, 3) }, T.t2, false, true, 'g'],
  ['dwi', { x: minimal(P.dwi.x, 3) }, T.dwi, false, true, 'g'],
];
const SNR = [5, 10, 20, 50, 100, 200];

const base = await variant(16, '1e-9');
const sets = [];
for (const [model, protocol, truths, magnitude, fitConstant, noise] of CONFIGS) {
  const options = { fitConstant, magnitude, ...(protocol.tr ? { tr: protocol.tr } : {}) };
  const n = protocol.x.length;
  const curves = [];
  for (const truth of truths) {
    const fit = {
      param: truth,
      m0: 1,
      a: model === 't1ir-a' ? 0.95 : 1,
      c: fitConstant ? 0.05 : 0,
    };
    const clean = base.evaluateModel(model, protocol.x, fit, { ...options, magnitude: false });
    const shown = base.evaluateModel(model, protocol.x, fit, options);
    const top = Math.max(...Array.from(clean, Math.abs));
    for (const snr of SNR) {
      const sigma = top / snr;
      for (let r = 0; r < R; r++) {
        const y = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          y[i] =
            noise === 'g'
              ? shown[i] + sigma * normal()
              : Math.hypot(clean[i] + sigma * normal(), sigma * normal());
        }
        curves.push(y);
      }
    }
  }
  sets.push({
    id: `${model}${magnitude ? '-m' : ''}${fitConstant ? '-c' : ''}-${noise} n=${n}`,
    model,
    x: protocol.x,
    options,
    curves,
  });
}
const total = sets.reduce((a, s) => a + s.curves.length, 0);
console.log(
  `${total} curves in ${sets.length} configurations; fine grid ${FINE} points per decade`,
);

function runAll(lib) {
  const res = [];
  let time = 0;
  for (const s of sets) {
    const fitter = new lib.Fitter(s.model, s.x, s.options);
    const out = new Float64Array(lib.OUT.size);
    const theta = new Float64Array(s.curves.length);
    const sse = new Float64Array(s.curves.length);
    const iter = new Float64Array(s.curves.length);
    const t0 = performance.now();
    for (let c = 0; c < s.curves.length; c++) {
      fitter.fit(s.curves[c], 0, out);
      theta[c] = out[lib.OUT.param];
      sse[c] = out[lib.OUT.sse];
      iter[c] = out[lib.OUT.iterations];
    }
    time += performance.now() - t0;
    res.push({ theta, sse, iter });
  }
  return { res, usPerCurve: (1000 * time) / total };
}
const tolOf = (ref) => 0.5 * 10 ** (Math.floor(Math.log10(Math.abs(ref))) - 3);

function compare(run, ref) {
  let misses = 0;
  let worse = 0;
  const rel = [];
  const bySet = {};
  run.res.forEach((r, k) => {
    const f = ref.res[k];
    for (let c = 0; c < r.theta.length; c++) {
      const dev = Math.abs(r.theta[c] - f.theta[c]);
      if (dev > tolOf(f.theta[c])) {
        if (r.sse[c] > f.sse[c] * (1 + 1e-9)) {
          misses++;
          bySet[sets[k].id] = (bySet[sets[k].id] ?? 0) + 1;
        } else if (r.sse[c] < f.sse[c] * (1 - 1e-9)) worse++;
      } else rel.push(dev / Math.abs(f.theta[c]));
    }
  });
  rel.sort((a, b) => a - b);
  const q = (f) => rel[Math.min(rel.length - 1, Math.floor(f * rel.length))];
  return { misses, refWorse: worse, p999: q(0.999), maxRel: rel[rel.length - 1], bySet };
}

const fine = runAll(await variant(FINE, '1e-9'));
const nears = values.near.split(',').map(Number);
console.log(`\nGrid density and SIGN_NEAR (REFINE_TOL 1e-9), against ${FINE} points per decade:`);
console.log('points/decade  SIGN_NEAR  misses  fine-grid-worse  us/curve');
for (const d of densities) {
  for (const near of nears) {
    const run = runAll(await variant(d, '1e-9', near));
    const c = compare(run, fine);
    console.log(
      `${String(d).padStart(13)}  ${String(near > 1e6 ? 'all' : near).padStart(9)}  ${String(c.misses).padStart(6)}  ${String(c.refWorse).padStart(15)}  ${run.usPerCurve.toFixed(1).padStart(8)}` +
        (c.misses ? `  ${JSON.stringify(c.bySet)}` : ''),
    );
  }
}

const D = Number(values.density);
const N = Number(process.env.STUDY_NEAR ?? 2);
const tight = runAll(await variant(D, '1e-13', N));
console.log(`\nRefinement tolerance (${D} points per decade), against REFINE_TOL 1e-13:`);
console.log('REFINE_TOL  relative difference: 99.9th pct, max  mean iterations  us/curve');
for (const t of tolerances) {
  const run = runAll(await variant(D, t, N));
  const c = compare(run, tight);
  const it = run.res.reduce((a, r) => a + r.iter.reduce((x, y) => x + y, 0), 0) / total;
  console.log(
    `${t.padStart(10)}  ${c.p999.toExponential(2).padStart(19)}, ${c.maxRel.toExponential(2)}  ${it.toFixed(1).padStart(15)}  ${run.usPerCurve.toFixed(1).padStart(8)}  misses ${c.misses}`,
  );
}
if (values.baseline) {
  const now = await variant(D, '1e-9', N);
  const old = await import(join(values.baseline, 'index.js'));
  const time = (lib, s) => {
    const fitter = new lib.Fitter(s.model, s.x, s.options);
    const out = new Float64Array(lib.OUT.size);
    const t0 = performance.now();
    for (const y of s.curves) fitter.fit(y, 0, out);
    return (1000 * (performance.now() - t0)) / s.curves.length;
  };
  for (const s of sets) (time(now, s), time(old, s)); // warm up both
  console.log(
    `\nTime per curve (us), this build (${D} points per decade, REFINE_TOL 1e-9) and ${values.baseline}:`,
  );
  let a = 0;
  let b = 0;
  for (const s of sets) {
    const tn = time(now, s);
    const to = time(old, s);
    a += tn * s.curves.length;
    b += to * s.curves.length;
    console.log(
      `${s.id.padEnd(24)} ${tn.toFixed(1).padStart(7)} ${to.toFixed(1).padStart(7)}  x${(tn / to).toFixed(2)}`,
    );
  }
  console.log(
    `${'all'.padEnd(24)} ${(a / total).toFixed(1).padStart(7)} ${(b / total).toFixed(1).padStart(7)}  x${(a / b).toFixed(2)}`,
  );
}
rmSync(work, { recursive: true, force: true });
