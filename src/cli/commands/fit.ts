import {
  MODELS,
  MODEL_ORDER,
  checkFit,
  fitCurve,
  type CurveFit,
  type FitOptions,
  type ModelId,
} from 'mritoolbox';
import {
  choice,
  noMorePositionals,
  optList,
  optNumber,
  optString,
  type Values,
} from '../args.js';
import type { Command, Context } from '../command.js';
import { parseCurveData, type Curves } from '../data.js';
import { EXIT, InputError, UsageError, libraryCall, report } from '../errors.js';
import { readText } from '../files.js';
import { fmt, table } from '../format.js';

export const MODEL_IDS = [...MODEL_ORDER].sort() as ModelId[];

/** --tr, --magnitude, --constant and --range, shared with `map`. */
export function fitOptions(values: Values): FitOptions {
  const tr = optNumber(values, 'tr');
  const range = optList(values, 'range');
  if (range && range.length !== 2)
    throw new UsageError(`--range takes two numbers (LO,HI), not ${range.length}.`);
  return {
    ...(tr !== undefined ? { tr } : {}),
    ...(values.magnitude ? { magnitude: true } : {}),
    ...(values.constant ? { fitConstant: true } : {}),
    ...(range ? { range: [range[0]!, range[1]!] as [number, number] } : {}),
  };
}

export const FIT_OPTIONS = {
  tr: {
    type: 'string',
    arg: 'MS',
    help: 'Repetition time: required for t1vfa; optional for t1ir and t1ir-a (default: fully relaxed).',
  },
  magnitude: {
    type: 'boolean',
    help: 'Inversion recovery: fit the magnitude of every measurement, whatever its sign.',
  },
  constant: { type: 'boolean', help: 'Add a constant offset C to the model.' },
  range: {
    type: 'string',
    arg: 'LO,HI',
    help: "Search range of the fitted parameter, in its unit (default: the model's).",
  },
} as const;

export function modelHelp(): string {
  return MODEL_IDS.map((id) => {
    const m = MODELS[id];
    return `  ${id.padEnd(7)} ${m.label}: ${m.param.name} (${m.param.unit}) from ${m.x.label.toLowerCase()} (${m.x.unit})`;
  }).join('\n');
}

async function curves(ctx: Context, values: Values): Promise<Curves> {
  const file = optString(values, 'data');
  const x = optList(values, 'x');
  const ys = values.y === undefined ? [] : (values.y as string[]);
  if (file !== undefined) {
    if (x || ys.length) throw new UsageError('Give --data, or --x and --y, not both.');
    return parseCurveData(await readText(ctx, file), file === '-' ? 'stdin' : file);
  }
  if (!x || ys.length === 0) throw new UsageError('Give --x and --y, or --data FILE.');
  return {
    x,
    curves: ys.map((text, n) => ({
      label: ys.length > 1 ? `y${n + 1}` : 'y',
      y: optList({ y: text }, 'y')!,
    })),
  };
}

type Result = { label: string } & (
  | Omit<CurveFit, 'model' | 'parameter' | 'warnings'>
  | { error: ReturnType<typeof report> }
);

export const fit: Command = {
  name: 'fit',
  summary: 'Fit a relaxation or diffusion model to one or more curves',
  usage: [
    'mritoolbox fit MODEL --x LIST --y LIST [--y LIST ...] [options]',
    '       mritoolbox fit MODEL --data FILE|- [options]',
  ].join('\n'),
  description: [
    'Least-squares (Levenberg-Marquardt) fit of one model to each curve, with standard errors.',
    'Models:',
    modelHelp(),
    '',
    'LIST is comma-separated: --x 10,20,40 --y 900,792,636. Negative values work as they are',
    '(--y -928,-819). --data reads CSV or JSON from a file or from standard input (-): CSV rows',
    'are x then one column per curve, with an optional header of names; JSON is {"x": [...],',
    '"y": [...] or [[...], ...]} or an array of rows.',
  ].join('\n'),
  options: {
    x: { type: 'string', arg: 'LIST', help: 'Echo times, b-values, inversion times or flip angles.' },
    y: { type: 'string', arg: 'LIST', multiple: true, help: 'Measurements; repeat for more curves.' },
    data: { type: 'string', arg: 'FILE', help: 'CSV or JSON curve data; - reads standard input.' },
    ...FIT_OPTIONS,
    initial: {
      type: 'string',
      arg: 'P,M0[,A,C]',
      help: 'Starting values (default: a search over the range).',
    },
  },
  examples: [
    'mritoolbox fit t2 --x 10,20,40,80 --y 890,790,625,390',
    'mritoolbox fit t1ir --x 50,100,200,400,800,1600,3200 --y -928,-819,-668,-389,37,536,901 --tr 6000',
    'mritoolbox fit t1vfa --x 2,4,6,10,15,20,30 --y 33.1,58.2,73.6,79.4,69.5,58.9,42.1 --tr 15',
    'mritoolbox fit dwi --data roi.csv --json',
    'cat decay.json | mritoolbox fit t2 --data - --constant',
  ],
  async run(ctx, values, positionals) {
    const model = choice(positionals[0], MODEL_IDS, 'model');
    noMorePositionals(positionals, 1);
    const options = fitOptions(values);
    const data = await curves(ctx, values);
    const initialList = optList(values, 'initial');
    if (initialList && (initialList.length < 2 || initialList.length > 4))
      throw new UsageError('--initial takes 2 to 4 numbers: P,M0[,A,C].');
    const initial = initialList && {
      param: initialList[0]!,
      m0: initialList[1]!,
      ...(initialList[2] !== undefined ? { a: initialList[2] } : {}),
      ...(initialList[3] !== undefined ? { c: initialList[3] } : {}),
    };

    // Problems with x or the options apply to every curve: report them once.
    const check = checkFit(model, data.x, options);
    if (check.errors.length) throw new InputError(check.errors);

    const one = data.curves.length === 1;
    const results: Result[] = data.curves.map(({ label, y }) => {
      try {
        const r = libraryCall(() =>
          fitCurve({ model, x: data.x, y, ...options, ...(initial ? { initial } : {}) }),
        );
        const { model: _m, parameter: _p, warnings: _w, ...rest } = r;
        return { label, ...rest };
      } catch (error) {
        if (one) throw error;
        return { label, error: report(error) };
      }
    });
    const failed = results.filter((r) => 'error' in r).length;
    const def = MODELS[model];
    const json = {
      command: 'fit',
      model,
      parameter: { name: def.param.name, unit: def.param.unit },
      options,
      x: data.x,
      results,
      warnings: check.warnings,
    };
    const header = [
      'Curve',
      `${def.param.name} (${def.param.unit})`,
      'SE',
      'M0',
      ...(def.fitA ? ['A'] : []),
      ...(options.fitConstant ? ['C'] : []),
      'R²',
      'RMSE',
    ];
    const rows = results.map((r) =>
      'error' in r
        ? [r.label, `error: ${r.error.message}`]
        : [
            r.label,
            fmt(r.value),
            fmt(r.standardError.value, 2),
            fmt(r.m0),
            ...(def.fitA ? [fmt(r.a)] : []),
            ...(options.fitConstant ? [fmt(r.c)] : []),
            fmt(r.r2, 6),
            fmt(r.rmse),
          ],
    );
    const padded = rows.map((row) =>
      row.length < header.length ? [...row, ...Array(header.length - row.length).fill('')] : row,
    );
    return {
      json,
      text: table(header, padded),
      warnings: check.warnings,
      ...(failed ? { exitCode: EXIT.failure } : {}),
    };
  },
};
