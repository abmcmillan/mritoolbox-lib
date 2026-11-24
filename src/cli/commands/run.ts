/**
 * `mritoolbox run JOB.json`: a batch of library calls and CLI commands in,
 * one JSON result out, for validation harnesses.
 *
 * JOB (format "mritoolbox-job", version 1)
 *
 *   {"format": "mritoolbox-job", "version": 1, "name": "smoke",
 *    "arrays": {"t1": {"file": "t1.f64", "dtype": "float64", "shape": [1000]}},
 *    "tasks": [ ... run in order ... ]}
 *
 * Array files are raw little-endian values in row-major order, relative to the
 * job file. dtype: float64 float32 int32 uint32 int16 uint16 int8 uint8.
 * Inside task arguments {"$array": "t1"} is an input array and
 * {"$number": "NaN" | "Infinity" | "-Infinity" | "-0"} a number JSON cannot hold.
 *
 * Every task has an "id" (letters, digits, "_", "-", "."; unique), a "kind"
 * and optionally "repeat" (default 1; every run is timed, outputs are from
 * the last). Kinds:
 *
 *   value      {"name": "MODEL_ORDER"}                an exported constant
 *   call       {"fn": "fitCurve", "args": [...]}      one call of an exported function
 *   map        {"fn": "spgrSignal", "args": [...],    one call per row i: each {"$array"} gives
 *               "pick": ["", "signals.0"],            element i (1-D) or row i (n-D); every
 *               "max_errors": 100}                    referenced array has N rows. Each pick
 *                                                     (a dotted path into the return value,
 *                                                     "" for the value itself) becomes a float64
 *                                                     output [N] or [N, w]; a call that throws
 *                                                     leaves NaN and is listed in "errors"
 *   fitVoxels  {"config": MapConfig,                  createFitter(config), then fitVoxels(fitter,
 *               "data": {"$array": "y"}, "count": N}  data, count): float32 output [N, 5]
 *   command    {"argv": ["fit", "t2", "--x", ...]}    a mritoolbox command, as with --json;
 *                                                     relative paths are against the job file
 *
 * RESULT (format "mritoolbox-result", version 1; on stdout, and as result.json with --out)
 *
 *   {"format": "mritoolbox-result", "version": 1, "job": name, "runtime": {...},
 *    "tasks": [{"id", "kind", "elapsed_ms": [...], "value" | "outputs" | "error", ...}]}
 *
 * Non-finite numbers are written as {"$number": ...}. Typed arrays are written
 * as {"$array": name, "dtype", "shape"} plus "file" (with --out, a file in
 * that directory) or "data" (without, the values inline). Functions become
 * {"$function": name}; errors {"name", "message", "errors"}.
 *
 * The format follows the job spec of the paper's validation harness
 * (analysis/js/core.mjs in the MRIToolbox paper repository), so either runner
 * can execute the same job; "command" tasks are specific to the CLI.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import * as library from 'mritoolbox';
import { noMorePositionals, optString } from '../args.js';
import type { Command, Context } from '../command.js';
import { EXIT, InputError, UsageError, report } from '../errors.js';
import { readInput } from '../files.js';
import { versionInfo } from '../version.js';

export const JOB_FORMAT = 'mritoolbox-job';
export const RESULT_FORMAT = 'mritoolbox-result';
export const JOB_VERSION = 1;

type TypedArray =
  | Float64Array
  | Float32Array
  | Int32Array
  | Uint32Array
  | Int16Array
  | Uint16Array
  | Int8Array
  | Uint8Array;

interface DType {
  Ctor: { new (n: number): TypedArray };
  bytes: number;
  suffix: string;
  get: (v: DataView, o: number) => number;
  set: (v: DataView, o: number, x: number) => void;
}

const DTYPES: Record<string, DType> = {
  float64: {
    Ctor: Float64Array,
    bytes: 8,
    suffix: 'f64',
    get: (v, o) => v.getFloat64(o, true),
    set: (v, o, x) => v.setFloat64(o, x, true),
  },
  float32: {
    Ctor: Float32Array,
    bytes: 4,
    suffix: 'f32',
    get: (v, o) => v.getFloat32(o, true),
    set: (v, o, x) => v.setFloat32(o, x, true),
  },
  int32: {
    Ctor: Int32Array,
    bytes: 4,
    suffix: 'i32',
    get: (v, o) => v.getInt32(o, true),
    set: (v, o, x) => v.setInt32(o, x, true),
  },
  uint32: {
    Ctor: Uint32Array,
    bytes: 4,
    suffix: 'u32',
    get: (v, o) => v.getUint32(o, true),
    set: (v, o, x) => v.setUint32(o, x, true),
  },
  int16: {
    Ctor: Int16Array,
    bytes: 2,
    suffix: 'i16',
    get: (v, o) => v.getInt16(o, true),
    set: (v, o, x) => v.setInt16(o, x, true),
  },
  uint16: {
    Ctor: Uint16Array,
    bytes: 2,
    suffix: 'u16',
    get: (v, o) => v.getUint16(o, true),
    set: (v, o, x) => v.setUint16(o, x, true),
  },
  int8: {
    Ctor: Int8Array,
    bytes: 1,
    suffix: 'i8',
    get: (v, o) => v.getInt8(o),
    set: (v, o, x) => v.setInt8(o, x),
  },
  uint8: {
    Ctor: Uint8Array,
    bytes: 1,
    suffix: 'u8',
    get: (v, o) => v.getUint8(o),
    set: (v, o, x) => v.setUint8(o, x),
  },
};

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const lib = library as unknown as Record<string, unknown>;

export function dtypeOf(view: unknown): string | null {
  for (const [name, info] of Object.entries(DTYPES)) if (view instanceof info.Ctor) return name;
  return null;
}

/** Output file name for an array: characters other than letters, digits, "_", "." and "-" become "_". */
export const arrayFile = (name: string, dtype: string): string =>
  `${name.replace(/[^A-Za-z0-9_.-]/gu, '_')}.${DTYPES[dtype]!.suffix}`;

/** Little-endian bytes to a typed array, whatever the platform's byte order. */
export function decodeArray(bytes: Uint8Array, dtype: string, what: string): TypedArray {
  const info = DTYPES[dtype];
  if (!info) throw new InputError(`${what}: unknown dtype ${JSON.stringify(dtype)}.`);
  if (bytes.length % info.bytes !== 0)
    throw new InputError(`${what}: ${bytes.length} bytes is not a whole number of ${dtype} values.`);
  const n = bytes.length / info.bytes;
  const out = new info.Ctor(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < n; i++) out[i] = info.get(view, i * info.bytes);
  return out;
}

export function encodeArray(array: TypedArray): Uint8Array {
  const info = DTYPES[dtypeOf(array)!]!;
  const bytes = new Uint8Array(array.length * info.bytes);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < array.length; i++) info.set(view, i * info.bytes, array[i]!);
  return bytes;
}

const NUMBERS: Record<string, number> = { NaN, Infinity, '-Infinity': -Infinity, '-0': -0 };

export function encodeNumber(x: number): number | { $number: string } {
  if (Number.isNaN(x)) return { $number: 'NaN' };
  if (x === Infinity) return { $number: 'Infinity' };
  if (x === -Infinity) return { $number: '-Infinity' };
  if (Object.is(x, -0)) return { $number: '-0' };
  return x;
}

interface InputArray {
  data: TypedArray;
  shape: number[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v);

function arrayRefs(value: unknown, names = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) arrayRefs(v, names);
  else if (isObject(value)) {
    if (typeof value.$array === 'string') names.add(value.$array);
    else for (const v of Object.values(value)) arrayRefs(v, names);
  }
  return names;
}

function rowOf(array: InputArray, i: number): number | TypedArray {
  const [n, ...rest] = array.shape;
  if (i >= n!) throw new Error(`Row ${i} is outside an array of ${n} rows.`);
  if (rest.length === 0) return array.data[i]!;
  const width = rest.reduce((p, q) => p * q, 1);
  return array.data.subarray(i * width, (i + 1) * width);
}

/** Replace {"$number"} and {"$array"}; `row` < 0 gives whole arrays. */
function resolveArgs(value: unknown, arrays: Record<string, InputArray>, row: number): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveArgs(v, arrays, row));
  if (isObject(value)) {
    if (typeof value.$number === 'string') {
      if (!(value.$number in NUMBERS))
        throw new InputError(`Unknown {"$number": ${JSON.stringify(value.$number)}}.`);
      return NUMBERS[value.$number];
    }
    if (typeof value.$array === 'string') {
      const a = arrays[value.$array];
      if (!a) throw new InputError(`There is no input array named ${JSON.stringify(value.$array)}.`);
      return row < 0 ? a.data : rowOf(a, row);
    }
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveArgs(v, arrays, row)]),
    );
  }
  return value;
}

interface ErrorRecord {
  name: string;
  message: string;
  errors?: string[];
}

function errorRecord(error: unknown): ErrorRecord {
  if (error instanceof Error) {
    const list = (error as { errors?: unknown }).errors;
    return {
      name: error.name,
      message: error.message,
      ...(Array.isArray(list) ? { errors: list.map(String) } : {}),
    };
  }
  return { name: typeof error, message: String(error) };
}

/** Where output arrays go: files in a directory, or inline in the JSON. */
type Sink = (name: string, view: TypedArray, shape?: number[]) => Promise<unknown>;

function fileSink(dir: string): Sink {
  return async (name, view, shape) => {
    const dtype = dtypeOf(view)!;
    const file = arrayFile(name, dtype);
    await writeFile(join(dir, file), encodeArray(view));
    return { $array: name, file, dtype, shape: shape ?? [view.length] };
  };
}

const inlineSink: Sink = async (name, view, shape) => ({
  $array: name,
  dtype: dtypeOf(view),
  shape: shape ?? [view.length],
  data: Array.from(view, encodeNumber),
});

/** A return value made JSON-safe. */
async function encode(value: unknown, path: string, sink: Sink): Promise<unknown> {
  if (typeof value === 'number') return encodeNumber(value);
  if (typeof value === 'function') return { $function: value.name || '' };
  if (typeof value === 'bigint') return value.toString();
  if (value === undefined) return null;
  if (ArrayBuffer.isView(value)) {
    if (dtypeOf(value) === null) throw new Error(`${path}: unsupported typed array.`);
    return sink(path, value as TypedArray);
  }
  if (value instanceof Error) return errorRecord(value);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i++) out.push(await encode(value[i], `${path}.${i}`, sink));
    return out;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = await encode(v, `${path}.${k}`, sink);
    return out;
  }
  return value;
}

function pickPath(value: unknown, path: string): unknown {
  if (path === '') return value;
  let v = value;
  for (const part of path.split('.')) {
    if (v === null || v === undefined) return undefined;
    v = (v as Record<string, unknown>)[part];
  }
  return v;
}

function libFunction(name: unknown): (...args: unknown[]) => unknown {
  const f = typeof name === 'string' ? lib[name] : undefined;
  if (typeof f !== 'function')
    throw new InputError(`The library exports no function ${JSON.stringify(name)}.`);
  return f as (...args: unknown[]) => unknown;
}

function timed<T>(repeat: number, body: () => T): { elapsed: number[]; last: T } {
  const elapsed: number[] = [];
  let last!: T;
  for (let r = 0; r < repeat; r++) {
    const t0 = performance.now();
    last = body();
    elapsed.push(performance.now() - t0);
  }
  return { elapsed, last };
}

type Task = Record<string, unknown> & { id: string; kind: string };

function runMap(task: Task, arrays: Record<string, InputArray>, repeat: number) {
  const f = libFunction(task.fn);
  const args = (task.args ?? []) as unknown[];
  const names = [...arrayRefs(args)];
  if (names.length === 0)
    throw new InputError(`Task ${task.id}: a map task needs at least one {"$array"} argument.`);
  for (const name of names)
    if (!arrays[name]) throw new InputError(`There is no input array named ${JSON.stringify(name)}.`);
  const n = arrays[names[0]!]!.shape[0]!;
  if (names.some((name) => arrays[name]!.shape[0] !== n))
    throw new InputError(`Task ${task.id}: arrays ${names.join(', ')} differ in their first dimension.`);
  const picks = (task.pick ?? ['']) as string[];
  const maxErrors = typeof task.max_errors === 'number' ? task.max_errors : 100;
  return timed(repeat, () => {
    const out: (Float64Array | null)[] = picks.map(() => null);
    const widths = picks.map(() => 0);
    const errors: (ErrorRecord & { index: number })[] = [];
    let errorCount = 0;
    const fail = (index: number, error: unknown): void => {
      errorCount++;
      if (errors.length < maxErrors) errors.push({ index, ...errorRecord(error) });
    };
    for (let i = 0; i < n; i++) {
      let value: unknown;
      try {
        value = f(...(resolveArgs(args, arrays, i) as unknown[]));
      } catch (error) {
        fail(i, error);
        continue;
      }
      picks.forEach((path, p) => {
        let v = pickPath(value, path);
        if (typeof v === 'boolean') v = Number(v);
        const list =
          Array.isArray(v) || (ArrayBuffer.isView(v) && !(v instanceof DataView))
            ? (v as ArrayLike<unknown>)
            : undefined;
        if (out[p] === null) {
          widths[p] = list ? list.length : 0;
          out[p] = new Float64Array(n * Math.max(widths[p]!, 1)).fill(NaN);
        }
        const target = out[p]!;
        const w = widths[p]!;
        if (w === 0 && typeof v === 'number') target[i] = v;
        else if (w > 0 && list && list.length === w) {
          for (let j = 0; j < w; j++) target[i * w + j] = Number(list[j]);
        } else fail(i, new TypeError(`pick ${JSON.stringify(path)}: unexpected ${typeof v}`));
      });
    }
    return { out, widths, errors, errorCount, n };
  });
}

async function runTask(
  ctx: Context,
  task: Task,
  arrays: Record<string, InputArray>,
  sink: Sink,
  jobDir: string,
): Promise<Record<string, unknown>> {
  const repeat = task.repeat ?? 1;
  if (typeof repeat !== 'number' || !Number.isInteger(repeat) || repeat < 1)
    throw new InputError(`Task ${task.id}: repeat must be a positive whole number.`);
  const rec: Record<string, unknown> = { id: task.id, kind: task.kind };
  switch (task.kind) {
    case 'value': {
      if (typeof task.name !== 'string' || !(task.name in lib))
        throw new InputError(`The library exports no ${JSON.stringify(task.name)}.`);
      rec.name = task.name;
      rec.elapsed_ms = [0];
      rec.value = await encode(lib[task.name], task.id, sink);
      break;
    }
    case 'call': {
      const f = libFunction(task.fn);
      const args = resolveArgs(task.args ?? [], arrays, -1) as unknown[];
      rec.fn = task.fn;
      const { elapsed, last } = timed(repeat, () => {
        try {
          return { value: f(...args) };
        } catch (error) {
          return { error };
        }
      });
      rec.elapsed_ms = elapsed;
      if ('error' in last) rec.error = errorRecord(last.error);
      else rec.value = await encode(last.value, task.id, sink);
      break;
    }
    case 'map': {
      rec.fn = task.fn;
      const { elapsed, last } = runMap(task, arrays, repeat);
      rec.elapsed_ms = elapsed;
      rec.n = last.n;
      const picks = (task.pick ?? ['']) as string[];
      const outputs: Record<string, unknown> = {};
      for (let p = 0; p < picks.length; p++) {
        const data = last.out[p] ?? new Float64Array(last.n).fill(NaN);
        const shape = last.widths[p]! > 0 ? [last.n, last.widths[p]!] : [last.n];
        outputs[picks[p]!] = await sink(`${task.id}.${picks[p] || 'value'}`, data, shape);
      }
      rec.outputs = outputs;
      rec.error_count = last.errorCount;
      rec.errors = last.errors;
      break;
    }
    case 'fitVoxels': {
      const config = resolveArgs(task.config, arrays, -1) as library.MapConfig;
      let data = resolveArgs(task.data, arrays, -1);
      if (!(data instanceof Float32Array)) data = Float32Array.from(data as ArrayLike<number>);
      const voxels = data as Float32Array;
      const width = config?.x?.length;
      if (!width) throw new InputError(`Task ${task.id}: config.x must list the x values.`);
      const count = (task.count ?? voxels.length / width) as number;
      if (!Number.isInteger(count) || count * width > voxels.length)
        throw new InputError(
          `Task ${task.id}: ${voxels.length} values do not hold ${count} voxels of ${width}.`,
        );
      const fitter = library.createFitter(config);
      const { elapsed, last } = timed(repeat, () => library.fitVoxels(fitter, voxels, count));
      rec.elapsed_ms = elapsed;
      rec.count = count;
      rec.channels = [...library.MAP_KEYS];
      rec.warnings = [...fitter.warnings];
      rec.outputs = { map: await sink(`${task.id}.map`, last, [count, library.MAP_CHANNELS]) };
      break;
    }
    case 'command': {
      const argv = task.argv;
      if (!Array.isArray(argv) || !argv.every((a) => typeof a === 'string') || argv.length === 0)
        throw new InputError(`Task ${task.id}: "argv" must be a non-empty array of strings.`);
      if (argv[0] === 'run') throw new InputError(`Task ${task.id}: a job cannot run another job.`);
      rec.argv = argv;
      const elapsed: number[] = [];
      let last: { json: unknown; exitCode: number } | { error: ReturnType<typeof report> } = {
        json: null,
        exitCode: 0,
      };
      for (let r = 0; r < repeat; r++) {
        const t0 = performance.now();
        try {
          const outcome = await ctx.invoke(argv as string[], jobDir);
          last = { json: outcome.json, exitCode: outcome.exitCode ?? EXIT.ok };
        } catch (error) {
          last = { error: report(error) };
        }
        elapsed.push(performance.now() - t0);
      }
      rec.elapsed_ms = elapsed;
      if ('error' in last) {
        rec.exit_code = last.error.exitCode;
        rec.error = { name: last.error.name, message: last.error.message, errors: last.error.errors };
      } else {
        rec.exit_code = last.exitCode;
        rec.value = await encode(last.json, task.id, sink);
      }
      break;
    }
    default:
      throw new InputError(`Task ${task.id}: unknown kind ${JSON.stringify(task.kind)}.`);
  }
  return rec;
}

/** Run a parsed job. Array files are read relative to `jobDir`. */
export async function runJob(
  ctx: Context,
  job: unknown,
  jobDir: string,
  sink: Sink,
): Promise<{ result: Record<string, unknown>; failed: number }> {
  if (!isObject(job) || job.format !== JOB_FORMAT || job.version !== JOB_VERSION)
    throw new InputError(`Not a ${JOB_FORMAT} version ${JOB_VERSION} file.`);
  const arrays: Record<string, InputArray> = {};
  const specs = job.arrays ?? {};
  if (!isObject(specs)) throw new InputError('"arrays" must be an object.');
  for (const [name, spec] of Object.entries(specs)) {
    if (!isObject(spec) || typeof spec.file !== 'string' || typeof spec.dtype !== 'string')
      throw new InputError(`Array ${name}: give "file" and "dtype".`);
    const bytes = new Uint8Array(await readFile(resolve(jobDir, spec.file)));
    const data = decodeArray(bytes, spec.dtype, `Array ${name}`);
    const shape = (spec.shape ?? [data.length]) as number[];
    if (!Array.isArray(shape) || shape.reduce((p, q) => p * q, 1) !== data.length)
      throw new InputError(
        `Array ${name}: shape ${JSON.stringify(shape)} does not match its ${data.length} values.`,
      );
    arrays[name] = { data, shape };
  }
  const tasks = job.tasks ?? [];
  if (!Array.isArray(tasks)) throw new InputError('"tasks" must be an array.');
  const seen = new Set<string>();
  const records: Record<string, unknown>[] = [];
  for (const task of tasks) {
    if (!isObject(task) || typeof task.id !== 'string' || !ID.test(task.id))
      throw new InputError(`Bad task id ${JSON.stringify(isObject(task) ? task.id : task)}.`);
    if (seen.has(task.id)) throw new InputError(`Duplicate task id ${JSON.stringify(task.id)}.`);
    seen.add(task.id);
    records.push(await runTask(ctx, task as Task, arrays, sink, jobDir));
  }
  const info = versionInfo();
  const result = {
    format: RESULT_FORMAT,
    version: JOB_VERSION,
    job: typeof job.name === 'string' ? job.name : null,
    runtime: {
      runner: 'mritoolbox-cli',
      cli: { version: info.version, git: info.git, dirty: info.dirty },
      node: process.version,
      v8: process.versions.v8,
      platform: process.platform,
      arch: process.arch,
      library: {
        dist: fileURLToPath(new URL('..', import.meta.url)),
        name: info.name,
        version: info.version,
      },
    },
    tasks: records,
  };
  const failed = records.filter((r) => r.error || r.error_count).length;
  return { result, failed };
}

export const run: Command = {
  name: 'run',
  summary: 'Run a batch job spec (JSON) of library calls and commands; JSON out',
  usage: 'mritoolbox run JOB.json|- [--out DIR] [--strict]',
  description: [
    'Runs the tasks of a "mritoolbox-job" version 1 file in order and writes one',
    '"mritoolbox-result" JSON document to stdout. Task kinds: value (an exported constant),',
    'call (one call of an exported function), map (one call per row of input arrays), fitVoxels',
    '(createFitter + fitVoxels) and command (a mritoolbox command, as with --json). Input arrays',
    'are raw little-endian files next to the job. With --out, output arrays are written there as',
    'files and the result also as DIR/result.json; without it they are inline. A task that fails',
    'is recorded in the result; the exit code is 0 unless --strict is given.',
    'The format is described in full in src/cli/commands/run.ts and the README.',
  ].join('\n'),
  options: {
    out: { type: 'string', arg: 'DIR', help: 'Write result.json and output arrays to DIR.' },
    strict: { type: 'boolean', help: 'Exit 1 when any task recorded an error.' },
    quiet: { type: 'boolean', short: 'q', help: 'No summary on stderr.' },
  },
  examples: ['mritoolbox run job.json', 'mritoolbox run job.json --out results/node26'],
  async run(ctx, values, positionals) {
    const file = positionals[0];
    if (file === undefined) throw new UsageError('Give the job file (or - for standard input).');
    noMorePositionals(positionals, 1);
    const text = new TextDecoder().decode(await readInput(ctx, file));
    let job: unknown;
    try {
      job = JSON.parse(text);
    } catch (error) {
      throw new InputError(`${file} is not valid JSON: ${(error as Error).message}`);
    }
    const jobDir = file === '-' ? ctx.cwd : dirname(resolve(ctx.cwd, file));
    const outDir = optString(values, 'out');
    let sink = inlineSink;
    if (outDir !== undefined) {
      await mkdir(resolve(ctx.cwd, outDir), { recursive: true });
      sink = fileSink(resolve(ctx.cwd, outDir));
    }
    const { result, failed } = await runJob(ctx, job, jobDir, sink);
    const json = `${JSON.stringify(result, null, 1)}\n`;
    if (outDir !== undefined) await writeFile(resolve(ctx.cwd, outDir, 'result.json'), json);
    if (!ctx.quiet)
      ctx.stderr(
        `run: ${(result.tasks as unknown[]).length} tasks, ${failed} with errors${outDir !== undefined ? ` -> ${outDir}` : ''}\n`,
      );
    return {
      json: result,
      text: json.trimEnd(),
      warnings: [],
      ...(values.strict && failed ? { exitCode: EXIT.failure } : {}),
    };
  },
};
