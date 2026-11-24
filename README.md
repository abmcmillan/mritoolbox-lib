# mritoolbox

The calculations behind [mritoolbox.com](https://www.mritoolbox.com), as a
dependency-free ES module: Ernst angle, contrast optimisation, relaxation
curve fitting, MP-RAGE simulation and a database of published T1 and T2
values. It runs in Node 20+, Deno, Bun, browsers and workers.

[mritoolbox.com](https://www.mritoolbox.com) is built on this library: the
site's calculators, curve fitting, parametric mapping, MP-RAGE simulator and
parameter database all run the code in this repository, and the site serves
the same modules at `https://www.mritoolbox.com/lib/`.

## Install

The package is not on npm yet. Install it from GitHub (Node 20 or later):

```sh
npm install github:abmcmillan/mritoolbox-lib
```

npm builds it on install with its `prepare` script (`npm run build`). Recent
npm releases list that script under `allow-scripts`; `npm approve-scripts
mritoolbox` records the approval in your `package.json`.

Or build it from a clone:

```sh
git clone https://github.com/abmcmillan/mritoolbox-lib.git
cd mritoolbox-lib
npm ci          # installs the compiler and builds dist/
npm pack        # optional: mritoolbox-3.0.0.tgz, for `npm install ./mritoolbox-3.0.0.tgz`
```

Either way it is imported as `mritoolbox`. It has no runtime dependencies.

## Use

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

## Command line

The package also provides a `mritoolbox` command for Node 20 or later on
macOS, Linux and Windows, with no dependencies. Once the package is installed
(see [Install](#install)) run it with `npx mritoolbox`, or as `mritoolbox` in
an npm script; after an npm release `npx mritoolbox …` will work without
installing first. The command is a separate Node front end in `src/cli/`: it
is not exported from `mritoolbox`, so the library stays free of Node APIs and
runs unchanged in browsers.

```sh
mritoolbox ernst --t1 830 --tr 10
mritoolbox signal spgr --t1 830 --tr 10 --flip 2,5,8.9,15,30
mritoolbox contrast gre --tissue1 0.69,830,53 --tissue2 0.82,1330,66 --te 5 --tr 100
mritoolbox mprage --tissue-a 1,1450,100 --tissue-b 0.92,750,75 \
  --flip 9 --spoil 50 --tr 7 --td1 330 --td2 830 --np 160
mritoolbox fit t1ir --x 50,100,200,400,800,1600,3200 --y -928,-819,-668,-389,37,536,901 --tr 6000
mritoolbox map t2 --input mese.nii.gz --x 10,20,30,40,50,60 --mask brain.nii.gz --out maps/t2
mritoolbox db liver --field 3
mritoolbox run job.json --out results
```

| Command    | What it does                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------- |
| `ernst`    | Ernst angle for one or more T1 at a TR (`ernstAngleDeg`)                                           |
| `signal`   | `spgr`, `se` or `ir` signal; any option may be a list, one row per value                           |
| `contrast` | The Contrastinator (`optimiseContrast`): `gre` flip angle, `se-t1` TR or `se-t2` TE                |
| `mprage`   | EPG MP-RAGE: one tissue's per-pulse signal, or a two-tissue image (`simulateMprage[Image]`)        |
| `fit`      | `dwi`, `t1ir`, `t1ir-a`, `t1vfa` or `t2` fits of one or more curves (`fitCurve`)                   |
| `map`      | Pixel-wise maps from a 4-D NIfTI-1 image in worker threads (`createFitter`, `fitVoxels`)           |
| `db`       | Search the T1/T2 database (`searchDatabase`)                                                       |
| `run`      | A batch job spec in, one JSON result out, for validation harnesses                                 |

`mritoolbox --help` lists the commands and `mritoolbox COMMAND --help` gives a
command's options and examples. `mritoolbox --version` prints the package
version and the git commit it was built from.

- **Units** are the library's: ms, degrees, tesla, fractions of M0.
- **Lists** are comma-separated (`--x 10,20,40`); negative values can be
  written as they are (`--y -928,-819`).
- **`--json`** writes the result as JSON on stdout; a number JSON cannot hold
  (such as a standard error that was not estimated) is `null`. Text results go
  to stdout, warnings and progress to stderr.
- **Input checks** are the library's own (`checkFit`, `checkContrast`,
  `checkMprage`, `InvalidInputError`); their messages and warnings are passed
  on as they are.
- **Exit codes**: 0 success; 1 failure (a file could not be read or written, a
  fit did not converge, or some of several curves failed); 2 usage error
  (unknown command or option, a missing or malformed value); 3 invalid input
  (refused by the input checks, or a data file that cannot be read). With
  `--json` an error is also written to stdout as
  `{"error": {"name", "message", "errors", "exitCode"}}`.

**`fit`** takes `--x` and `--y` (repeat `--y` for more curves), or
`--data FILE` (`-` for standard input): CSV or other delimited text with x in
the first column and one column per curve, optionally under a header row of
names; or JSON, `{"x": [...], "y": [...]}`, `{"x": [...], "y": [[...], ...],
"labels": [...]}` or rows `[[x, y1, y2], ...]`. `--magnitude`, `--constant`,
`--tr`, `--range` and `--initial` are the options of `fitCurve`.

**`map`** reads a 4-D NIfTI-1 image (`.nii`, or `.nii.gz` through Node's
`zlib`) with one volume per `--x` value, and an optional 3-D mask (voxels where
it is nonzero are fitted). It writes 3-D float32 NIfTI-1 files with the
input's geometry: `PREFIX_t2` (or `_t1`, or `_d` for the ADC), `PREFIX_m0`,
`PREFIX_a` (`t1ir-a`), `PREFIX_c` (`--constant`) and `PREFIX_r2`; voxels outside
the mask or whose fit failed are 0. `--workers N` sets the number of worker
threads (default: the available parallelism); the maps do not depend on it.
The reader follows the [NIfTI-1 header](https://nifti.nimh.nih.gov/nifti-1):
either byte order, the integer datatypes up to 64 bits, float32 and float64,
`scl_slope`/`scl_inter` scaling, and `vox_offset` (extensions are skipped).
Complex and RGB data, `.hdr`/`.img` pairs and NIfTI-2 are refused with a
message saying so.

### Job specs for `mritoolbox run`

`mritoolbox run JOB.json` (or `-` for standard input) runs the tasks of a job
in order and writes one result document to stdout; with `--out DIR` the result
also goes to `DIR/result.json` and the output arrays to files beside it.

```json
{
  "format": "mritoolbox-job",
  "version": 1,
  "name": "example",
  "arrays": { "t1": { "file": "t1.f64", "dtype": "float64", "shape": [3] } },
  "tasks": [
    { "id": "order", "kind": "value", "name": "MODEL_ORDER" },
    { "id": "ernst", "kind": "call", "fn": "ernstAngleDeg", "args": [830, 10], "repeat": 5 },
    { "id": "angles", "kind": "map", "fn": "ernstAngleDeg", "args": [{ "$array": "t1" }, 10] },
    {
      "id": "voxels",
      "kind": "fitVoxels",
      "config": { "model": "t2", "x": [10, 20, 40, 80], "options": {} },
      "data": [890, 790, 625, 390],
      "count": 1
    },
    { "id": "cli", "kind": "command", "argv": ["fit", "t2", "--x", "10,20,40,80", "--y", "890,790,625,390"] }
  ]
}
```

- **Arrays** are raw little-endian files in row-major order, next to the job:
  `float64`, `float32`, `int32`, `uint32`, `int16`, `uint16`, `int8` or
  `uint8`. In task arguments `{"$array": "t1"}` stands for an array and
  `{"$number": "NaN"}` (or `"Infinity"`, `"-Infinity"`, `"-0"`) for a number
  JSON cannot hold.
- **Task kinds**: `value` (an exported constant), `call` (one call of an
  exported function), `map` (one call per row of the referenced arrays;
  `"pick"` lists dotted paths into the return value, each saved as a float64
  output), `fitVoxels` (`createFitter(config)`, then `fitVoxels`) and `command`
  (a `mritoolbox` command, as with `--json`; paths are relative to the job
  file). With `"repeat": n` a task runs n times and `elapsed_ms` times each run.
- **The result** is `{"format": "mritoolbox-result", "version": 1, "job",
"runtime", "tasks"}`. Each task record has `id`, `kind`, `elapsed_ms` and a
  `value`, `outputs` or `error`. Typed arrays appear as
  `{"$array", "dtype", "shape"}` with `"file"` (with `--out`) or `"data"`
  (inline); numbers JSON cannot hold appear as `{"$number": ...}`.
- A task that fails is recorded in the result and the job carries on; the exit
  code is 0 unless `--strict` is given and a task failed.

The format is the job spec of the MRIToolbox paper's validation harness, so a
job can run through the library directly or through this command; `command`
tasks are specific to the CLI. The full description is at the top of
[`src/cli/commands/run.ts`](src/cli/commands/run.ts).

## Development

`npm run build` embeds the data file, compiles the library (`src/`, with
`tsconfig.json`) and then the command line (`src/cli/`, with
`tsconfig.cli.json`, which adds the Node types) to `dist/`, and records the
git commit for `--version`. `npm test` builds and then runs the tests in
`tests/` against the built package: the Vitest suite (`tests/*.test.ts` for
the library, `tests/cli/` for the parts of the command line; Node 22.12 or
later) and the dependency-free `node:test` suite (`tests/node/`, `npm run
test:node`), which checks the library and runs every command end to end in a
new process, so it covers Node 20 too. Continuous integration runs them on
Linux, macOS and Windows with every supported Node release.

The compiler is pinned (`typescript` 6.0.3), so the same sources compile to
the same `dist/` files as the copy the website serves. The command line is
compiled separately into `dist/cli/` and leaves the library's files as they
are.

## Publishing

The package is marked `"private": true` so that it cannot be published by
accident. Remove `"private"` before `npm publish`.

## Licence

Licensed under the [Apache License, Version 2.0](LICENSE). Under its terms you
may use, modify and redistribute the code, including commercially, as long as
you include the licence, keep its notices and mark the files you changed. It
also grants a patent licence from the contributors, and comes with no
warranty.

These tools are for research and teaching and are not intended for clinical
decision-making.
