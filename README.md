# mritoolbox

The calculations behind [mritoolbox.com](https://www.mritoolbox.com), as a
dependency-free ES module: Ernst angle, contrast optimisation, relaxation
curve fitting, MP-RAGE simulation and a database of published T1 and T2
values. It runs in Node 20+, Deno, Bun, browsers and workers, and the website
itself is built on this package.

Times are in milliseconds, field strengths in tesla, signals are fractions of
M0. Angles are in degrees, except in the low-level signal equations that say
radians (multiply degrees by `DEG`).

```js
import {
  ernstAngleDeg,
  optimiseContrast,
  fitCurve,
  simulateMprage,
  searchDatabase,
} from 'mritoolbox';

ernstAngleDeg(830, 10); // 8.9° for T1 830 ms at TR 10 ms

// Flip angle with the largest signal difference between two tissues (GRE: t2 is T2*).
const best = optimiseContrast({
  mode: 'gre',
  tissues: [
    { pd: 0.69, t1: 830, t2: 53 },
    { pd: 0.82, t1: 1330, t2: 66 },
  ],
  te: 5,
  tr: 100,
});
best.optimum; // degrees
best.difference; // fraction of M0

// Fit T2 from echo times and signals.
const fit = fitCurve({ model: 't2', x: [10, 20, 40, 80], y: [890, 790, 625, 390] });
fit.value; // T2 in ms
fit.standardError.value;
fit.r2;

// Published values for liver at 3 T.
searchDatabase('liver', 3).map((e) => [e.tissue, e.t1, e.t2, e.pmid]);
```

Without installing anything, the same module is served by the site:

```js
import { fitCurve } from 'https://www.mritoolbox.com/lib/index.js';
```

## What is in it

| Area          | Exports                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------- |
| Signal        | `ernstAngleDeg`, `spgrSignal`, `spinEchoSignal`, `inversionRecoverySignal`, `linspace`, `DEG` |
| Contrast      | `optimiseContrast`, `maximise`                                                                |
| Curve fitting | `fitCurve` (one call), `Fitter` (reusable, allocation-free), `evaluateModel`, `MODELS`        |
| Mapping       | `createFitter`, `fitVoxels` for many voxels at once                                           |
| MP-RAGE       | `simulateMprage`, `simulateMprageImage` (extended phase graphs)                               |
| Input checks  | `checkContrast`, `checkFit`, `checkMprage`, `InvalidInputError`                               |
| Database      | `DATABASE`, `RAW_DATABASE`, `searchDatabase`, `searchEntries`, `normalise`                    |

Curve-fitting models: `t2` (mono-exponential, also T2\*), `dwi` (ADC), `t1ir`
(inversion recovery), `t1ir-a` (inversion recovery with fitted inversion
efficiency) and `t1vfa` (variable flip angle; needs `tr`). With
`magnitude: true` an inversion-recovery fit uses the magnitude of every
measurement, whatever its sign.

Every calculation checks its inputs. Values that cannot be computed or cannot
occur (TE not shorter than TR, an inversion time not shorter than TR, a
negative time, a proton density outside 0 to 1) throw an `InvalidInputError`
whose message says what to change. Values that compute but look unintended are
returned in the result's `warnings`.

The database file is also exported as `mritoolbox/data/parameter-database.json`.

## Development

`npm run build` embeds the data file and compiles `src/` to `dist/`. The tests
live in the repository root (`tests/lib.test.ts`, `tests/fit.test.ts`) and run
against the built package.

## Publishing

The package is marked `"private": true` and `"license": "UNLICENSED"` so that
it cannot be published by accident. Before `npm publish`, choose a licence, set
it in `package.json`, and remove `"private"`.

These tools are for research and teaching and are not intended for clinical
decision-making.
