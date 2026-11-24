import { mkdir, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { MAP_CHANNELS, MAP_KEYS, MODELS, createFitter, type MapConfig, type MapKey } from 'mritoolbox';
import {
  choice,
  noMorePositionals,
  optInteger,
  optString,
  requireList,
  requireString,
} from '../args.js';
import type { Command, Context } from '../command.js';
import { InputError, UsageError, libraryCall } from '../errors.js';
import { isGzip, readInput } from '../files.js';
import { fmt } from '../format.js';
import type { ChunkMessage, ResultMessage } from '../map-worker.js';
import { DT, niftiBytes, readNifti, type NiftiHeader } from '../nifti.js';
import { FIT_OPTIONS, MODEL_IDS, fitOptions, modelHelp } from './fit.js';

/** Report progress on stderr: one redrawn line on a terminal, every 10% otherwise. */
function progress(ctx: Context, total: number): (done: number) => void {
  if (ctx.quiet || total === 0) return () => {};
  let shown = ctx.stderrIsTTY ? -1 : 0;
  return (done) => {
    const percent = Math.floor((100 * done) / total);
    if (ctx.stderrIsTTY) {
      if (percent === shown) return;
      shown = percent;
      ctx.stderr(`\rmap: ${percent}% (${done} of ${total} voxels)${done === total ? '\n' : ''}`);
    } else {
      const step = Math.floor(percent / 10) * 10;
      if (step === shown) return;
      shown = step;
      ctx.stderr(`map: ${step}% (${done} of ${total} voxels)\n`);
    }
  };
}

/** Fit `count` voxel-major curves of `n` values in worker threads; MAP_CHANNELS values per voxel. */
export async function fitInWorkers(
  config: MapConfig,
  data: Float32Array,
  count: number,
  workers: number,
  onProgress: (done: number) => void,
): Promise<Float32Array> {
  const n = config.x.length;
  const result = new Float32Array(count * MAP_CHANNELS);
  if (count === 0) return result;
  const chunk = Math.min(4096, Math.max(64, Math.ceil(count / (workers * 8))));
  const starts: number[] = [];
  for (let s = 0; s < count; s += chunk) starts.push(s);
  const url = new URL('../map-worker.js', import.meta.url);
  const pool = Array.from(
    { length: Math.min(workers, starts.length) },
    () => new Worker(url, { workerData: { config } }),
  );
  let next = 0;
  let finished = 0;
  let voxels = 0;
  try {
    await new Promise<void>((done, fail) => {
      const send = (worker: Worker): void => {
        if (next >= starts.length) return;
        const id = next++;
        const start = starts[id]!;
        const size = Math.min(chunk, count - start);
        const part = data.slice(start * n, (start + size) * n);
        worker.postMessage({ id, data: part, count: size } satisfies ChunkMessage, [part.buffer]);
      };
      for (const worker of pool) {
        worker.on('message', ({ id, result: part }: ResultMessage) => {
          result.set(part, starts[id]! * MAP_CHANNELS);
          finished++;
          voxels += part.length / MAP_CHANNELS;
          onProgress(voxels);
          if (finished === starts.length) done();
          else send(worker);
        });
        worker.on('error', fail);
        worker.on('exit', (code) => {
          if (finished < starts.length) fail(new Error(`A fit worker stopped (exit code ${code}).`));
        });
        send(worker);
      }
    });
  } finally {
    await Promise.all(pool.map((worker) => worker.terminate()));
  }
  return result;
}

/** dim[1..3] of an image whose further dimensions are all 1 beyond `keep`. */
function spatial(header: NiftiHeader, keep: number, source: string): [number, number, number] {
  const d = header.dim;
  for (let i = keep + 1; i <= d[0]!; i++)
    if (d[i] !== 1)
      throw new InputError(`${source} has ${d[0]} dimensions; dimension ${i} must have size 1.`);
  return [d[1] ?? 1, d[2] ?? 1, d[0]! >= 3 ? d[3]! : 1];
}

/** The output header: the input's geometry, one float32 volume, identity scaling. */
function outputHeader(input: NiftiHeader, dims: [number, number, number], name: string, descrip: string): NiftiHeader {
  return {
    ...input,
    littleEndian: true,
    dim: [3, ...dims, 1, 1, 1, 1],
    datatype: DT.FLOAT32,
    bitpix: 32,
    voxOffset: 352,
    sclSlope: 1,
    sclInter: 0,
    calMax: 0,
    calMin: 0,
    intentCode: 0,
    intentP: [0, 0, 0],
    intentName: name.slice(0, 15),
    descrip: descrip.slice(0, 79),
    sliceStart: 0,
    sliceEnd: 0,
    sliceCode: 0,
    sliceDuration: 0,
    toffset: 0,
    // Keep the spatial units, drop the time units.
    xyztUnits: input.xyztUnits & 0x07,
  };
}

export const map: Command = {
  name: 'map',
  summary: 'Pixel-wise parameter maps from a 4-D NIfTI-1 image, in worker threads',
  usage:
    'mritoolbox map MODEL --input IMAGE.nii[.gz] --x LIST --out PREFIX [--mask MASK.nii[.gz]] [options]',
  description: [
    'Fits MODEL to every voxel of a 4-D NIfTI-1 image (one volume per x value) and writes one',
    '3-D float32 NIfTI-1 file per output channel: PREFIX_<parameter> (t2, t1 or d, the ADC),',
    'PREFIX_m0, PREFIX_a (t1ir-a only), PREFIX_c (with --constant) and PREFIX_r2. Voxels outside',
    'the mask, and voxels whose fit failed, are 0. The fits run in --workers threads; progress',
    'goes to stderr. Models:',
    modelHelp(),
  ].join('\n'),
  options: {
    input: { type: 'string', arg: 'FILE', help: '4-D NIfTI-1 image (.nii or .nii.gz).' },
    x: { type: 'string', arg: 'LIST', help: 'One x value per volume (TE, b, TI or flip angle).' },
    mask: { type: 'string', arg: 'FILE', help: '3-D NIfTI-1 mask: fit voxels where it is nonzero.' },
    out: { type: 'string', arg: 'PREFIX', help: 'Output prefix, e.g. maps/subject1.' },
    format: { type: 'string', arg: 'nii|nii.gz', help: 'Output format (default: as the input).' },
    workers: {
      type: 'string',
      arg: 'N',
      help: 'Worker threads (default: the available parallelism).',
    },
    quiet: { type: 'boolean', short: 'q', help: 'No progress on stderr.' },
    ...FIT_OPTIONS,
  },
  examples: [
    'mritoolbox map t2 --input mese.nii.gz --x 10,20,30,40,50,60 --mask brain.nii.gz --out maps/t2',
    'mritoolbox map dwi --input dwi.nii --x 0,500,1000 --out adc --workers 4 --json',
  ],
  async run(ctx, values, positionals) {
    const t0 = performance.now();
    const model = choice(positionals[0], MODEL_IDS, 'model');
    noMorePositionals(positionals, 1);
    const inputFile = requireString(values, 'input');
    const maskFile = optString(values, 'mask');
    const out = requireString(values, 'out');
    const x = requireList(values, 'x');
    const options = fitOptions(values);
    const format = optString(values, 'format');
    if (format !== undefined && format !== 'nii' && format !== 'nii.gz')
      throw new UsageError(`--format must be nii or nii.gz, not "${format}".`);
    const workers = optInteger(values, 'workers', 1) ?? Math.max(1, availableParallelism());

    // The library's checks of x and the options, before any image is read.
    const config: MapConfig = { model, x, options };
    const { warnings } = libraryCall(() => createFitter(config));

    const bytes = await readInput(ctx, inputFile);
    const image = await readNifti(bytes, inputFile, 'float32');
    const h = image.header;
    if (h.dim[0]! < 4)
      throw new InputError(
        `${inputFile} has ${h.dim[0]} dimensions; mapping needs 4 (x, y, z and one volume per x value).`,
      );
    const dims = spatial(h, 4, inputFile);
    const volumes = h.dim[4]!;
    if (volumes !== x.length)
      throw new InputError(`${inputFile} has ${volumes} volumes but --x has ${x.length} values.`);
    const total = dims[0] * dims[1] * dims[2];

    let selected: Uint32Array;
    if (maskFile !== undefined) {
      const mask = await readNifti(await readInput(ctx, maskFile), maskFile, 'float32');
      const maskDims = spatial(mask.header, 3, maskFile);
      if (maskDims.some((d, i) => d !== dims[i]))
        throw new InputError(
          `${maskFile} is ${maskDims.join('×')} voxels but ${inputFile} is ${dims.join('×')}.`,
        );
      const keep: number[] = [];
      for (let v = 0; v < total; v++) if (mask.data[v]! !== 0 && !Number.isNaN(mask.data[v])) keep.push(v);
      selected = Uint32Array.from(keep);
    } else selected = Uint32Array.from({ length: total }, (_, v) => v);
    const count = selected.length;
    if (count === 0) warnings.push('The mask selects no voxels; every map is 0.');

    // NIfTI order is x fastest and volume slowest; the fitter wants each voxel's curve contiguous.
    const n = volumes;
    const curves = new Float32Array(count * n);
    for (let k = 0; k < count; k++) {
      const v = selected[k]!;
      for (let t = 0; t < n; t++) curves[k * n + t] = image.data[v + t * total]!;
    }

    const used = Math.min(workers, Math.max(1, Math.ceil(count / 64)));
    const fitted = await fitInWorkers(config, curves, count, used, progress(ctx, count));

    const def = MODELS[model];
    const channels = MAP_KEYS.filter(
      (key) => (key !== 'a' || def.fitA) && (key !== 'c' || options.fitConstant === true),
    );
    const volumesOut = new Map<MapKey, Float32Array>(
      channels.map((key) => [key, new Float32Array(total)]),
    );
    const targets = MAP_KEYS.map((key) => volumesOut.get(key));
    let failed = 0;
    for (let k = 0; k < count; k++) {
      const v = selected[k]!;
      let zero = true;
      for (let c = 0; c < MAP_CHANNELS; c++) {
        const value = fitted[k * MAP_CHANNELS + c]!;
        if (value !== 0) zero = false;
        const target = targets[c];
        if (target) target[v] = value;
      }
      // fitVoxels leaves a voxel whose fit failed at zero in every channel.
      if (zero) failed++;
    }

    const gzip = format === undefined ? isGzip(bytes) : format === 'nii.gz';
    const extension = gzip ? '.nii.gz' : '.nii';
    const outputs: { channel: MapKey; name: string; unit: string; file: string }[] = [];
    await mkdir(dirname(resolve(ctx.cwd, out)), { recursive: true });
    for (const key of channels) {
      const name = key === 'param' ? def.param.name.toLowerCase() : key;
      const unit = key === 'param' ? def.param.unit : '';
      const file = `${out}_${name}${extension}`;
      const header = outputHeader(
        h,
        dims,
        name,
        `mritoolbox map ${model} ${name}${unit ? ` (${unit})` : ''}`,
      );
      await writeFile(resolve(ctx.cwd, file), await niftiBytes(header, volumesOut.get(key)!, gzip));
      outputs.push({ channel: key, name, unit, file });
    }
    const elapsedMs = performance.now() - t0;

    return {
      json: {
        command: 'map',
        model,
        parameter: { name: def.param.name, unit: def.param.unit },
        input: inputFile,
        mask: maskFile ?? null,
        dims,
        volumes,
        x,
        options,
        voxels: total,
        fitted: count,
        failed,
        workers: used,
        outputs,
        warnings,
        elapsedMs,
      },
      text: [
        `Fitted ${count} of ${total} voxels (${failed} failed) with ${used} worker${used === 1 ? '' : 's'} in ${fmt(elapsedMs / 1000, 3)} s.`,
        ...outputs.map((o) => `  ${o.file}`),
      ].join('\n'),
      warnings,
    };
  },
};
