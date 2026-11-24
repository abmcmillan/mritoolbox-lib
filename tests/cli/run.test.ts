import { describe, expect, it } from 'vitest';
import { arrayFile, decodeArray, encodeArray, encodeNumber } from '../../dist/cli/commands/run.js';
import { main } from '../../dist/cli/main.js';

/** Run the CLI in-process with captured output. */
async function capture(argv: string[], input = '') {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, {
    stdout: (text: string) => (stdout += text),
    stderr: (text: string) => (stderr += text),
    stdin: async () => new TextEncoder().encode(input),
    stderrIsTTY: false,
    cwd: process.cwd(),
  });
  return { code, stdout, stderr };
}

describe('job arrays', () => {
  it('reads and writes little-endian arrays of every dtype', () => {
    for (const array of [
      Float64Array.of(1.5, -Infinity, NaN),
      Float32Array.of(0.25, -2),
      Int32Array.of(-7, 2 ** 30),
      Uint32Array.of(2 ** 32 - 1),
      Int16Array.of(-300),
      Uint16Array.of(65535),
      Int8Array.of(-5),
      Uint8Array.of(200),
    ]) {
      const dtype = array.constructor.name.replace('Array', '').toLowerCase();
      const bytes = encodeArray(array);
      expect(bytes.length).toBe(array.byteLength);
      expect(Array.from(decodeArray(bytes, dtype, 'a'))).toEqual(Array.from(array));
    }
    // Byte order is little-endian on any platform.
    expect(Array.from(encodeArray(Uint16Array.of(0x0102)))).toEqual([2, 1]);
    expect(() => decodeArray(new Uint8Array(3), 'float32', 'a')).toThrow(/whole number/);
    expect(() => decodeArray(new Uint8Array(4), 'complex', 'a')).toThrow(/unknown dtype/);
  });

  it('encodes numbers JSON cannot hold, and names files safely', () => {
    expect([NaN, Infinity, -Infinity, -0, 2].map(encodeNumber)).toEqual([
      { $number: 'NaN' },
      { $number: 'Infinity' },
      { $number: '-Infinity' },
      { $number: '-0' },
      2,
    ]);
    expect(arrayFile('fit.signals 0/x', 'float32')).toBe('fit.signals_0_x.f32');
  });
});

describe('main', () => {
  it('prints results as text or JSON and reports errors with exit codes', async () => {
    const text = await capture(['ernst', '--t1', '830', '--tr', '10']);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/8\.876/);
    const json = await capture(['ernst', '--t1', '830', '--tr', '10', '--json']);
    expect(JSON.parse(json.stdout).results[0].t1).toBe(830);

    const bad = await capture(['ernst', '--t1', '0', '--tr', '10', '--json']);
    expect(bad.code).toBe(3);
    expect(JSON.parse(bad.stdout).error).toMatchObject({ exitCode: 3, errors: ['T1 must be greater than zero.'] });
    expect(bad.stderr).toBe('mritoolbox ernst: T1 must be greater than zero.\n');

    const usage = await capture(['ernst', '--tr', '10']);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toMatch(/--t1 is required[\s\S]*mritoolbox ernst --help/);
    expect((await capture(['--frob'])).code).toBe(2);
    expect((await capture(['ernst', 'extra', '--t1', '1', '--tr', '1'])).code).toBe(2);
  });

  it('shows help and the version', async () => {
    expect((await capture([])).stdout).toMatch(/^mritoolbox \d/);
    expect((await capture(['help', 'fit'])).stdout).toMatch(/^Usage: mritoolbox fit/);
    expect((await capture(['fit', '-h'])).stdout).toMatch(/Models:/);
    const version = JSON.parse((await capture(['--version', '--json'])).stdout);
    expect(version).toMatchObject({ name: 'mritoolbox', node: process.version });
  });

  it('passes warnings from the input checks to stderr', async () => {
    const r = await capture(['fit', 't1vfa', '--x', '5,10,120', '--y', '30,50,40', '--tr', '15']);
    expect(r.stderr).toMatch(/warning: A flip angle of 120° is above 90°/);
  });

  it('reads curve data from standard input', async () => {
    const r = await capture(['fit', 't2', '--data', '-', '--json'], '10,900\n20,792\n40,636\n60,501\n');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).results[0].value).toBeGreaterThan(80);
  });
});
