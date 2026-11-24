import { describe, expect, it } from 'vitest';
import {
  choice,
  optInteger,
  parseCommand,
  parseList,
  parseNumber,
  tuple,
} from '../../dist/cli/args.js';
import { parseCurveData } from '../../dist/cli/data.js';
import { EXIT, UsageError, libraryCall, report } from '../../dist/cli/errors.js';
import { fmt, plain, table } from '../../dist/cli/format.js';
import { InvalidInputError, fitCurve } from '../../dist/index.js';

const specs = {
  x: { type: 'string', short: 'x', help: '' },
  y: { type: 'string', multiple: true, help: '' },
  magnitude: { type: 'boolean', help: '' },
} as const;

describe('numbers and lists', () => {
  it('reads decimal numbers and infinities, and nothing else', () => {
    expect(['1', '-2.5', '+.5', '1e3', '2E-2', ' 7 '].map((t) => parseNumber(t, 'v'))).toEqual([
      1, -2.5, 0.5, 1000, 0.02, 7,
    ]);
    expect(['inf', '-Infinity', '+INF'].map((t) => parseNumber(t, 'v'))).toEqual([
      Infinity,
      -Infinity,
      Infinity,
    ]);
    for (const bad of ['', 'abc', '0x10', '1,5', 'NaN', '1_000'])
      expect(() => parseNumber(bad, '--t1')).toThrow(UsageError);
    expect(() => parseNumber('abc', '--t1')).toThrow('--t1 must be a number, not "abc".');
  });

  it('splits lists on commas, semicolons and white space', () => {
    expect(parseList('750, 1450;10\n2e3  5', 'v')).toEqual([750, 1450, 10, 2000, 5]);
    expect(() => parseList(' , ', '--x')).toThrow(/at least one/);
  });
});

describe('parseCommand', () => {
  it('takes negative numbers as option values', () => {
    const { values, positionals } = parseCommand(
      ['t1ir', '--y', '-928,-819', '-x', '-5', '--y=-1', '--magnitude'],
      specs,
    );
    expect(positionals).toEqual(['t1ir']);
    expect(values.y).toEqual(['-928,-819', '-1']);
    expect(values.x).toBe('-5');
    expect(values.magnitude).toBe(true);
    expect(parseCommand(['--x', '-inf'], specs).values.x).toBe('-inf');
  });

  it('turns parseArgs errors into usage errors', () => {
    expect(() => parseCommand(['--nope'], specs)).toThrow(UsageError);
    expect(() => parseCommand(['--x', '--magnitude'], specs)).toThrow(UsageError);
    expect(parseCommand(['--json', '-h'], specs).values).toMatchObject({ json: true, help: true });
  });

  it('checks counts, whole numbers and choices', () => {
    expect(tuple({ t: '0.9,800,60' }, 't', 3, 'PD,T1,T2')).toEqual([0.9, 800, 60]);
    expect(() => tuple({ t: '0.9,800' }, 't', 3, 'PD,T1,T2')).toThrow(/takes 3 numbers/);
    expect(optInteger({ w: '4' }, 'w', 1)).toBe(4);
    expect(() => optInteger({ w: '0' }, 'w', 1)).toThrow(/at least 1/);
    expect(() => optInteger({ w: '1.5' }, 'w', 1)).toThrow(/whole number/);
    expect(choice('se', ['spgr', 'se'], 'sequence')).toBe('se');
    expect(() => choice('fisp', ['spgr', 'se'], 'sequence')).toThrow(/Unknown sequence "fisp"/);
  });
});

describe('curve data', () => {
  it('reads CSV with a header, comments and several curves', () => {
    const data = parseCurveData('# T2 decay\nte;"roi 1";roi2\n10;900;450\n\n20;792;396\n', 'f.csv');
    expect(data).toEqual({
      x: [10, 20],
      curves: [
        { label: 'roi 1', y: [900, 792] },
        { label: 'roi2', y: [450, 396] },
      ],
    });
  });

  it('reads tab- and space-separated text without a header', () => {
    expect(parseCurveData('10\t900\n20\t792', 'f').curves).toEqual([{ label: 'y', y: [900, 792] }]);
    expect(parseCurveData('  10  900  1\n 20 792 2 \n', 'f').curves.map((c) => c.label)).toEqual([
      'y1',
      'y2',
    ]);
  });

  it('reads the JSON forms', () => {
    expect(parseCurveData('{"x": [1, 2], "y": [3, 4]}', 'j').curves).toEqual([{ label: 'y', y: [3, 4] }]);
    const multi = parseCurveData('{"x": [1, 2], "y": [[3, 4], [5, 6]], "labels": ["a", "b"]}', 'j');
    expect(multi.curves.map((c) => c.label)).toEqual(['a', 'b']);
    expect(parseCurveData('[[1, 3], [2, 4]]', 'j')).toEqual({ x: [1, 2], curves: [{ label: 'y', y: [3, 4] }] });
  });

  it('names the line and the problem', () => {
    expect(() => parseCurveData('10,900\n20,abc\n', 'f.csv')).toThrow('f.csv, line 2: "abc" is not a number.');
    expect(() => parseCurveData('10,900\n20,792,1\n', 'f.csv')).toThrow(/line 2: 3 columns/);
    expect(() => parseCurveData('10\n20\n', 'f.csv')).toThrow(/two columns/);
    expect(() => parseCurveData('{"x": [1], "y": "a"}', 'j')).toThrow(/"y" must be/);
    expect(() => parseCurveData('{"x": [1], ', 'j')).toThrow(/not valid JSON/);
    expect(() => parseCurveData('# nothing\n', 'f')).toThrow(/no data rows/);
  });
});

describe('errors', () => {
  it('maps what is thrown to exit codes', () => {
    expect(report(new UsageError('x')).exitCode).toBe(EXIT.usage);
    expect(report(new InvalidInputError(['a', 'b']))).toMatchObject({ exitCode: 3, errors: ['a', 'b'] });
    expect(report(Object.assign(new Error('nope'), { code: 'ENOENT' })).exitCode).toBe(EXIT.failure);
    expect(report(Object.assign(new TypeError('p'), { code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' })).exitCode).toBe(2);
  });

  it("classifies the library's plain errors", () => {
    const mismatch = () => libraryCall(() => fitCurve({ model: 't2', x: [1, 2, 3], y: [1, 2] }));
    expect(() => mismatch()).toThrow(/x has 3 values but y has 2/);
    try {
      mismatch();
    } catch (error) {
      expect(report(error).exitCode).toBe(EXIT.invalid);
    }
    try {
      libraryCall(() => {
        throw new Error('The fit did not converge. Check the data or give initial values.');
      });
    } catch (error) {
      expect(report(error).exitCode).toBe(EXIT.failure);
    }
  });
});

describe('text output', () => {
  it('formats numbers compactly', () => {
    expect([fmt(1234.5678), fmt(84.8912), fmt(0.00081234), fmt(1e-9), fmt(0), fmt(Infinity)]).toEqual([
      '1235',
      '84.89',
      '8.123e-4',
      '1e-9',
      '0',
      'inf',
    ]);
    expect(fmt(undefined)).toBe('–');
  });

  it('aligns tables and turns typed arrays into arrays', () => {
    expect(table(['a', 'bb'], [['100', '2']])).toBe('a    bb\n---  --\n100  2');
    expect(plain({ v: Float64Array.of(1, 2), f: () => 1, n: [Uint8Array.of(3)] })).toEqual({ v: [1, 2], n: [[3]] });
  });
});
