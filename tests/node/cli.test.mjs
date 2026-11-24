// End-to-end tests of the built `mritoolbox` command: each spawns
// dist/cli/index.js in a new Node process and checks what it prints, writes
// and exits with against the library called directly. node:test, no
// dependencies, so they run on every supported Node version.
// Run after `npm run build`: npm run test:node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import * as lib from '../../dist/index.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const bin = join(root, 'dist', 'cli', 'index.js');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const tmp = mkdtempSync(join(tmpdir(), 'mritoolbox-cli-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function cli(args, { input, cwd = tmp } = {}) {
  const r = spawnSync(process.execPath, [bin, ...args], { input, cwd, encoding: 'utf8' });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function json(args, options) {
  const r = cli([...args, '--json'], options);
  assert.equal(r.code, 0, `exit ${r.code}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const COMMANDS = ['ernst', 'signal', 'contrast', 'mprage', 'fit', 'map', 'db', 'run'];

describe('global options', () => {
  test('--version prints the package version and the build commit', () => {
    const r = cli(['--version']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, new RegExp(`^mritoolbox ${pkg.version.replaceAll('.', '\\.')}`));
    const info = JSON.parse(cli(['--version', '--json']).stdout);
    assert.equal(info.version, pkg.version);
    assert.ok(info.git === null || /^[0-9a-f]{40}$/u.test(info.git), info.git);
  });

  test('--help lists every command, and every command has its own --help', () => {
    const r = cli(['--help']);
    assert.equal(r.code, 0);
    for (const name of COMMANDS) {
      assert.match(r.stdout, new RegExp(`^  ${name} `, 'mu'));
      const own = cli([name, '--help']);
      assert.equal(own.code, 0, name);
      assert.ok(own.stdout.startsWith(`Usage: mritoolbox ${name}`), name);
    }
  });

  test('exit codes: 2 for usage errors, 3 for invalid input', () => {
    assert.equal(cli(['frobnicate']).code, 2);
    assert.equal(cli(['ernst', '--t1', 'abc', '--tr', '10']).code, 2);
    assert.equal(cli(['ernst', '--t1', '830', '--tr', '10', '--bogus']).code, 2);
    assert.equal(cli(['ernst', '--t1', '-830', '--tr', '10']).code, 3);
    const r = cli(['fit', 't2', '--x', '-10,20,40', '--y', '9,8,7', '--json']);
    assert.equal(r.code, 3);
    assert.deepEqual(JSON.parse(r.stdout).error.errors, ['Echo times cannot be negative.']);
    assert.match(r.stderr, /Echo times cannot be negative/u);
  });
});

describe('ernst', () => {
  test('matches the library and the previous site', () => {
    const out = json(['ernst', '--t1', '750,1450', '--tr', '10']);
    assert.deepEqual(
      out.results.map((r) => r.angle),
      [lib.ernstAngleDeg(750, 10), lib.ernstAngleDeg(1450, 10)],
    );
    assert.equal(out.results[0].angle.toFixed(3), '9.336');
    assert.match(cli(['ernst', '--t1', '830', '--tr', '10']).stdout, /8\.876/u);
  });
});

describe('signal', () => {
  test('spgr, se and ir equal the library equations', () => {
    const spgr = json(['signal', 'spgr', '--t1', '830', '--tr', '10', '--te', '5', '--t2', '50', '--flip', '5,10,20']);
    assert.deepEqual(
      spgr.results.map((r) => r.signal),
      [5, 10, 20].map((f) => lib.spgrSignal(1, 830, 50, 10, 5, f * lib.DEG)),
    );
    const se = json(['signal', 'se', '--pd', '0.69', '--t1', '830', '--t2', '53', '--tr', '500', '--te', '15']);
    assert.equal(se.results[0].signal, lib.spinEchoSignal(0.69, 830, 53, 500, 15));
    const ir = json(['signal', 'ir', '--t1', '830', '--ti', '100,575', '--tr', '5000', '--efficiency', '0.95']);
    assert.deepEqual(
      ir.results.map((r) => r.signal),
      [100, 575].map((ti) => lib.inversionRecoverySignal(1, 830, ti, 5000, 0.95)),
    );
    assert.ok(ir.results[0].signal < 0);
  });

  test('applies the input checks and the list rules', () => {
    assert.equal(cli(['signal', 'spgr', '--t1', '830', '--tr', '10', '--te', '12', '--t2', '50', '--flip', '5']).code, 3);
    assert.equal(cli(['signal', 'ir', '--t1', '830', '--ti', '6000', '--tr', '5000']).code, 3);
    assert.equal(cli(['signal', 'se', '--t1', '830', '--t2', '53', '--tr', '500', '--te', '15', '--flip', '9']).code, 2);
    assert.equal(cli(['signal', 'spgr', '--t1', '830,900', '--tr', '10,20,30', '--flip', '5']).code, 2);
    assert.equal(cli(['signal', 'fisp']).code, 2);
  });
});

describe('contrast', () => {
  test('reproduces the library optimum and the previous site', () => {
    const tissues = [
      { pd: 0.92, t1: 750, t2: 75 },
      { pd: 1, t1: 1450, t2: 100 },
    ];
    const out = json(['contrast', 'gre', '--tissue1', '0.92,750,75', '--tissue2', '1,1450,100', '--te', '5', '--tr', '100']);
    const ref = lib.optimiseContrast({ mode: 'gre', tissues, te: 5, tr: 100 });
    assert.equal(out.optimum, ref.optimum);
    assert.deepEqual(out.signals, ref.signals);
    assert.equal(Math.round(out.optimum), 45);
    const se = json(['contrast', 'se-t2', '--tissue1', '0.92,750,75', '--tissue2', '1,1450,100', '--tr', '100']);
    assert.equal(se.warnings.length, 2);
    assert.equal(cli(['contrast', 'gre', '--tissue1', '0.92,750,75', '--tissue2', '1,1450,100', '--te', '120', '--tr', '100']).code, 3);
  });
});

describe('mprage', () => {
  const seq = ['--flip', '9', '--spoil', '50', '--tr', '7', '--td1', '330', '--td2', '830', '--np', '160'];
  test('two tissues: the EPG image signals of the library, corrected on the previous site case', () => {
    const out = json(['mprage', '--tissue-a', '1,1450,100', '--tissue-b', '0.92,750,75', ...seq]);
    const ref = lib.simulateMprageImage(
      { pd: 1, t1: 1450, t2: 100 },
      { pd: 0.92, t1: 750, t2: 75 },
      { flipAngle: 9, spoilIncrement: 50, tr: 7, td1: 330, td2: 830, np: 160 },
    );
    assert.equal(out.signalA, ref.signalA);
    assert.equal(out.signalB, ref.signalB);
    // Corrected EPG (#2); the 2012 algorithm gave 0.024424690025312324 and 0.047124053975078295.
    assert.ok(Math.abs(out.signalA - 0.02435879570540178) < 5e-13);
    assert.ok(Math.abs(out.signalB - 0.047107333947596135) < 5e-13);
    assert.equal(out.steadyState, true);
  });

  test('one tissue: per-pulse signal, warnings from the input checks', () => {
    const out = json(['mprage', '--tissue', '0.69,830,80', ...seq.slice(0, 1), '45', ...seq.slice(2)]);
    assert.equal(out.magnitude.length, 160);
    assert.match(out.warnings.join(' '), /far above/u);
    assert.equal(cli(['mprage', '--tissue', '0.69,830,80', ...seq.slice(0, 10), '--np', '0']).code, 3);
    assert.equal(cli(['mprage', ...seq]).code, 2);
  });
});

describe('fit', () => {
  const fitArgs = (id) => {
    const ex = lib.MODELS[id].example;
    return [
      'fit',
      id,
      '--x',
      ex.x.join(','),
      '--y',
      ex.y.join(','),
      ...(ex.tr ? ['--tr', String(ex.tr)] : []),
    ];
  };

  for (const id of lib.MODEL_ORDER) {
    test(`${id}: equals fitCurve on the model's example data`, () => {
      const ex = lib.MODELS[id].example;
      const out = json(fitArgs(id));
      const ref = lib.fitCurve({ model: id, x: ex.x, y: ex.y, ...(ex.tr ? { tr: ex.tr } : {}) });
      assert.equal(out.model, id);
      assert.equal(out.results[0].value, ref.value);
      assert.equal(out.results[0].m0, ref.m0);
      assert.equal(out.results[0].r2, ref.r2);
      assert.equal(out.parameter.name, ref.parameter.name);
    });
  }

  test('--constant, --magnitude and --tr reach the library', () => {
    const ex = lib.MODELS.t1ir.example;
    const c = json([...fitArgs('t1ir'), '--constant']);
    const ref = lib.fitCurve({ model: 't1ir', x: ex.x, y: ex.y, tr: 6000, fitConstant: true });
    assert.equal(c.results[0].c, ref.c);
    assert.equal(c.options.fitConstant, true);
    const signed = json([...fitArgs('t1ir'), '--magnitude']);
    const rectified = json(['fit', 't1ir', '--x', ex.x.join(','), '--y', ex.y.map(Math.abs).join(','), '--tr', '6000', '--magnitude']);
    assert.deepEqual(signed.results, rectified.results);
    assert.equal(cli(['fit', 't1vfa', '--x', '2,5,10', '--y', '1,2,3']).code, 3);
  });

  test('reads CSV and JSON from files and standard input', () => {
    const ex = lib.MODELS.t2.example;
    const ref = lib.fitCurve({ model: 't2', x: ex.x, y: ex.y });
    const csv = ['# echo time, two regions', 'te,roi1,roi2', ...ex.x.map((x, i) => `${x},${ex.y[i]},${ex.y[i] / 2}`)].join('\n');
    writeFileSync(join(tmp, 'decay.csv'), csv);
    const fromCsv = json(['fit', 't2', '--data', 'decay.csv']);
    assert.deepEqual(fromCsv.results.map((r) => r.label), ['roi1', 'roi2']);
    assert.equal(fromCsv.results[0].value, ref.value);
    writeFileSync(join(tmp, 'decay.json'), JSON.stringify({ x: ex.x, y: ex.y }));
    assert.equal(json(['fit', 't2', '--data', 'decay.json']).results[0].value, ref.value);
    const piped = json(['fit', 't2', '--data', '-'], { input: JSON.stringify({ x: ex.x, y: [ex.y] }) });
    assert.equal(piped.results[0].value, ref.value);
    const tsv = json(['fit', 't2', '--data', '-'], { input: ex.x.map((x, i) => `${x}\t${ex.y[i]}`).join('\n') });
    assert.equal(tsv.results[0].value, ref.value);
    assert.equal(cli(['fit', 't2', '--data', '-'], { input: '10,900\n20,abc\n' }).code, 3);
    assert.equal(cli(['fit', 't2', '--data', 'missing.csv']).code, 1);
  });
});

describe('db', () => {
  test('searches the database like searchDatabase', () => {
    const out = json(['db', 'liver', '--field', '3']);
    const ref = lib.searchDatabase('liver', 3);
    assert.equal(out.count, ref.length);
    assert.deepEqual(out.entries.map((e) => e.pmid), ref.map((e) => e.pmid));
    assert.equal(json(['db']).count, lib.DATABASE.length);
    assert.match(cli(['db', 'white', 'matter']).stdout, /White matter/u);
  });
});

// ---- NIfTI-1, written and read here independently of src/cli/nifti.ts ----

const DTYPE = { uint8: [2, 8], int16: [4, 16], float32: [16, 32] };

function niftiFile({ dims, type, stored, slope = 0, inter = 0, le = true, extension = false }) {
  const [datatype, bitpix] = DTYPE[type];
  const voxOffset = extension ? 368 : 352;
  const buf = Buffer.alloc(voxOffset + (stored.length * bitpix) / 8);
  const i16 = (o, v) => (le ? buf.writeInt16LE(v, o) : buf.writeInt16BE(v, o));
  const i32 = (o, v) => (le ? buf.writeInt32LE(v, o) : buf.writeInt32BE(v, o));
  const f32 = (o, v) => (le ? buf.writeFloatLE(v, o) : buf.writeFloatBE(v, o));
  i32(0, 348);
  [dims.length, ...dims, ...Array(7 - dims.length).fill(1)].forEach((d, i) => i16(40 + 2 * i, d));
  i16(70, datatype);
  i16(72, bitpix);
  [1, 1.5, 1.5, 3, 1, 1, 1, 1].forEach((p, i) => f32(76 + 4 * i, p));
  f32(108, voxOffset);
  f32(112, slope);
  f32(116, inter);
  buf[123] = 2; // xyzt_units: mm
  i16(254, 1); // sform_code
  [[1.5, 0, 0, -3], [0, 1.5, 0, -2], [0, 0, 3, 5]].forEach((row, r) =>
    row.forEach((v, c) => f32(280 + 16 * r + 4 * c, v)),
  );
  buf.write('n+1\0', 344, 'latin1');
  if (extension) {
    buf[348] = 1;
    i32(352, 16); // esize
    i32(356, 6); // ecode: comment
    buf.write('synth\0\0\0', 360, 'latin1');
  }
  stored.forEach((v, i) => {
    const o = voxOffset + (i * bitpix) / 8;
    if (type === 'uint8') buf.writeUInt8(v, o);
    else if (type === 'int16') i16(o, v);
    else f32(o, v);
  });
  return buf;
}

function readFloat32Nifti(file) {
  let buf = readFileSync(file);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
  assert.equal(buf.readInt32LE(0), 348);
  assert.equal(buf.toString('latin1', 344, 348), 'n+1\0');
  const dim = Array.from({ length: 8 }, (_, i) => buf.readInt16LE(40 + 2 * i));
  assert.equal(buf.readInt16LE(70), 16);
  const offset = buf.readFloatLE(108);
  const n = dim.slice(1, dim[0] + 1).reduce((p, q) => p * q, 1);
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = buf.readFloatLE(offset + 4 * i);
  return {
    dim,
    pixdim: Array.from({ length: 8 }, (_, i) => buf.readFloatLE(76 + 4 * i)),
    srowX: Array.from({ length: 4 }, (_, i) => buf.readFloatLE(280 + 4 * i)),
    sclSlope: buf.readFloatLE(112),
    data,
  };
}

describe('map', () => {
  const [nx, ny, nz] = [4, 3, 2];
  const te = [10, 20, 40, 60, 80, 120];
  const total = nx * ny * nz;
  const t2 = Array.from({ length: total }, (_, v) => 40 + 5 * v);
  const signal = (v, t) => 1000 * Math.exp(-te[t] / t2[v]);
  // int16 with scl_slope 0.5 and scl_inter 10: stored x means 0.5 x + 10.
  const stored = [];
  for (let t = 0; t < te.length; t++)
    for (let v = 0; v < total; v++) stored.push(Math.round((signal(v, t) - 10) / 0.5));
  const mask = Array.from({ length: total }, (_, v) => (v % 3 === 0 ? 0 : 1));

  // What the library gives for the same data: the stored values scaled, voxel-major, float32.
  const curves = new Float32Array(total * te.length);
  for (let v = 0; v < total; v++)
    for (let t = 0; t < te.length; t++) curves[v * te.length + t] = 0.5 * stored[t * total + v] + 10;
  const expected = lib.fitVoxels(lib.createFitter({ model: 't2', x: te, options: {} }), curves, total);

  test('round trip: big-endian int16 .nii.gz with scaling and an extension in, float32 maps out', () => {
    const input = niftiFile({ dims: [nx, ny, nz, te.length], type: 'int16', stored, slope: 0.5, inter: 10, le: false, extension: true });
    writeFileSync(join(tmp, 'mese.nii.gz'), gzipSync(input));
    writeFileSync(join(tmp, 'mask.nii'), niftiFile({ dims: [nx, ny, nz], type: 'uint8', stored: mask }));
    const r = cli(['map', 't2', '--input', 'mese.nii.gz', '--mask', 'mask.nii', '--x', te.join(','), '--out', 'maps/a', '--workers', '2', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /map: 100% \(16 of 16 voxels\)/u);
    const out = JSON.parse(r.stdout);
    assert.equal(out.fitted, mask.filter(Boolean).length);
    assert.equal(out.failed, 0);
    assert.deepEqual(out.outputs.map((o) => o.file), ['maps/a_t2.nii.gz', 'maps/a_m0.nii.gz', 'maps/a_r2.nii.gz']);

    const map = readFloat32Nifti(join(tmp, 'maps/a_t2.nii.gz'));
    assert.deepEqual(map.dim.slice(0, 4), [3, nx, ny, nz]);
    assert.deepEqual(map.pixdim.slice(1, 4), [1.5, 1.5, 3]);
    assert.deepEqual(map.srowX, [1.5, 0, 0, -3]);
    assert.equal(map.sclSlope, 1);
    const m0 = readFloat32Nifti(join(tmp, 'maps/a_m0.nii.gz'));
    for (let v = 0; v < total; v++) {
      if (!mask[v]) {
        assert.equal(map.data[v], 0);
        continue;
      }
      assert.equal(map.data[v], expected[v * lib.MAP_CHANNELS], `voxel ${v}`);
      assert.equal(m0.data[v], expected[v * lib.MAP_CHANNELS + 1]);
      assert.ok(Math.abs(map.data[v] / t2[v] - 1) < 0.01, `T2 ${map.data[v]} vs ${t2[v]}`);
    }
  });

  test('the same maps whatever the number of workers; .nii in, .nii out', () => {
    const input = niftiFile({ dims: [nx, ny, nz, te.length], type: 'float32', stored: stored.map((x) => 0.5 * x + 10) });
    writeFileSync(join(tmp, 'mese.nii'), input);
    for (const workers of ['1', '3'])
      assert.equal(cli(['map', 't2', '--input', 'mese.nii', '--x', te.join(','), '--out', `w${workers}`, '--workers', workers, '-q']).code, 0);
    for (const name of ['t2', 'm0', 'r2'])
      assert.deepEqual(readFileSync(join(tmp, `w1_${name}.nii`)), readFileSync(join(tmp, `w3_${name}.nii`)));
    const one = readFloat32Nifti(join(tmp, 'w1_t2.nii'));
    for (let v = 0; v < total; v++) assert.equal(one.data[v], expected[v * lib.MAP_CHANNELS]);
  });

  test('refuses mismatched inputs', () => {
    assert.equal(cli(['map', 't2', '--input', 'mese.nii', '--x', '10,20,40', '--out', 'bad']).code, 3);
    writeFileSync(join(tmp, 'small.nii'), niftiFile({ dims: [2, 2, 2], type: 'uint8', stored: Array(8).fill(1) }));
    assert.equal(cli(['map', 't2', '--input', 'mese.nii', '--mask', 'small.nii', '--x', te.join(','), '--out', 'bad']).code, 3);
    writeFileSync(join(tmp, 'junk.nii'), Buffer.alloc(400));
    assert.equal(cli(['map', 't2', '--input', 'junk.nii', '--x', te.join(','), '--out', 'bad']).code, 3);
    assert.equal(cli(['map', 't1vfa', '--input', 'mese.nii', '--x', te.join(','), '--out', 'bad']).code, 3);
  });
});

describe('run', () => {
  test('runs a job spec: value, call, map, fitVoxels and command tasks', () => {
    const dir = join(tmp, 'job');
    mkdirSync(dir);
    const t1 = [750, 1450, 830];
    const bytes = Buffer.alloc(8 * t1.length);
    t1.forEach((v, i) => bytes.writeDoubleLE(v, 8 * i));
    writeFileSync(join(dir, 't1.f64'), bytes);
    const ex = lib.MODELS.t2.example;
    const job = {
      format: 'mritoolbox-job',
      version: 1,
      name: 'e2e',
      arrays: { t1: { file: 't1.f64', dtype: 'float64', shape: [3] } },
      tasks: [
        { id: 'order', kind: 'value', name: 'MODEL_ORDER' },
        { id: 'ernst', kind: 'call', fn: 'ernstAngleDeg', args: [830, 10], repeat: 3 },
        { id: 'relaxed', kind: 'call', fn: 'inversionRecoverySignal', args: [1, 830, 100, { $number: 'Infinity' }] },
        { id: 'bad', kind: 'call', fn: 'fitCurve', args: [{ model: 't2', x: [1, 2, 3], y: [1, 2] }] },
        { id: 'angles', kind: 'map', fn: 'ernstAngleDeg', args: [{ $array: 't1' }, 10] },
        { id: 'voxels', kind: 'fitVoxels', config: { model: 't2', x: ex.x, options: {} }, data: [...ex.y, ...ex.y], count: 2 },
        { id: 'cli-fit', kind: 'command', argv: ['fit', 't2', '--x', ex.x.join(','), '--y', ex.y.join(',')] },
        { id: 'cli-bad', kind: 'command', argv: ['ernst', '--t1', '-1', '--tr', '10'] },
      ],
    };
    writeFileSync(join(dir, 'job.json'), JSON.stringify(job));

    const r = cli(['run', 'job/job.json', '--out', 'job/out']);
    assert.equal(r.code, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'out', 'result.json'), 'utf8')), result);
    assert.equal(result.format, 'mritoolbox-result');
    assert.equal(result.job, 'e2e');
    assert.equal(result.runtime.runner, 'mritoolbox-cli');
    const task = Object.fromEntries(result.tasks.map((t) => [t.id, t]));
    assert.deepEqual(task.order.value, lib.MODEL_ORDER);
    assert.equal(task.ernst.value, lib.ernstAngleDeg(830, 10));
    assert.equal(task.ernst.elapsed_ms.length, 3);
    assert.equal(task.relaxed.value, lib.inversionRecoverySignal(1, 830, 100, Infinity));
    assert.match(task.bad.error.message, /x has 3 values but y has 2/u);

    const angles = task.angles.outputs[''];
    assert.deepEqual([angles.dtype, angles.shape, angles.file], ['float64', [3], 'angles.value.f64']);
    const raw = readFileSync(join(dir, 'out', angles.file));
    assert.deepEqual(
      t1.map((_, i) => raw.readDoubleLE(8 * i)),
      t1.map((v) => lib.ernstAngleDeg(v, 10)),
    );
    const vox = task.voxels.outputs.map;
    assert.deepEqual(vox.shape, [2, lib.MAP_CHANNELS]);
    assert.equal(readFileSync(join(dir, 'out', vox.file)).readFloatLE(0), Math.fround(lib.fitCurve({ model: 't2', x: ex.x, y: ex.y }).value));
    assert.equal(task['cli-fit'].exit_code, 0);
    assert.equal(task['cli-fit'].value.results[0].value, lib.fitCurve({ model: 't2', x: ex.x, y: ex.y }).value);
    assert.equal(task['cli-bad'].exit_code, 3);
    assert.match(r.stderr, /8 tasks, 2 with errors/u);
  });

  test('inline arrays without --out, a job from stdin, --strict and malformed jobs', () => {
    const job = {
      format: 'mritoolbox-job',
      version: 1,
      tasks: [{ id: 'curve', kind: 'call', fn: 'linspace', args: [0, 1, 3] }],
    };
    const out = json(['run', '-'], { input: JSON.stringify(job) });
    assert.deepEqual(out.tasks[0].value, { $array: 'curve', dtype: 'float64', shape: [3], data: [0, 0.5, 1] });
    const failing = { ...job, tasks: [{ id: 'nope', kind: 'call', fn: 'fitCurve', args: [{}] }] };
    assert.equal(cli(['run', '-', '-q'], { input: JSON.stringify(failing) }).code, 0);
    assert.equal(cli(['run', '-', '-q', '--strict'], { input: JSON.stringify(failing) }).code, 1);
    assert.equal(cli(['run', '-'], { input: '{"format": "something-else"}' }).code, 3);
    assert.equal(cli(['run', '-'], { input: 'not json' }).code, 3);
  });
});

describe('package', () => {
  // npm sets npm_execpath when the tests run through `npm test` or `npm run test:node`.
  const npmCli = process.env.npm_execpath;
  test('installs from its tarball and runs as `mritoolbox`', { skip: !npmCli && 'needs npm (run through npm)' }, () => {
    const npm = (args, cwd) => {
      const r = spawnSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8' });
      assert.equal(r.status, 0, `npm ${args.join(' ')}: ${r.stderr}`);
      return r.stdout;
    };
    const packs = join(tmp, 'pack');
    mkdirSync(packs);
    // npm 10 (Node 20 and 22) runs `prepare` despite --ignore-scripts and prints the build
    // before the JSON; the rebuilt dist/ is the same bytes.
    const packOut = npm(['pack', '--ignore-scripts', '--json', '--pack-destination', packs], root);
    const [packed] = JSON.parse(packOut.slice(packOut.search(/^\[/mu)));
    const files = packed.files.map((f) => f.path);
    for (const file of ['dist/index.js', 'dist/cli/index.js', 'dist/cli/map-worker.js', 'LICENSE', 'data/parameter-database.json'])
      assert.ok(files.includes(file), file);
    assert.ok(!files.some((f) => f.startsWith('src/') || f.startsWith('tests/')));

    const project = join(tmp, 'project');
    mkdirSync(project);
    writeFileSync(join(project, 'package.json'), '{"name": "probe", "version": "1.0.0", "private": true}');
    npm(['install', '--no-audit', '--no-fund', '--ignore-scripts', join(packs, packed.filename)], project);
    const version = npm(['exec', '--no', '--', 'mritoolbox', '--version'], project);
    assert.match(version, new RegExp(`^mritoolbox ${pkg.version.replaceAll('.', '\\.')}`));
    const ernst = JSON.parse(npm(['exec', '--no', '--', 'mritoolbox', 'ernst', '--t1', '830', '--tr', '10', '--json'], project));
    assert.equal(ernst.results[0].angle, lib.ernstAngleDeg(830, 10));
  });
});
