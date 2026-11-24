import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as library from '../dist/index.js';

const lib = library as unknown as Record<string, unknown>;
const readme = readFileSync('README.md', 'utf8').replaceAll('\r\n', '\n');

describe('README', () => {
  it('runs its example as published and prints what its comments say', () => {
    const block = /```js\n(import \{([^}]+)\} from 'mritoolbox';\n([\s\S]*?))```/u.exec(readme);
    expect(block, 'the README has a js example importing mritoolbox').not.toBeNull();
    const names = block![2]!
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    for (const name of names) expect(lib[name], name).toBeDefined();

    // Record every bare expression statement (a line such as `fit.r2;`) with its comment.
    const seen: { code: string; note: string; value: unknown }[] = [];
    const code = block![3]!.replace(
      /^(?!const |let |\/\/|[\s})\]])([^\n;]+);[ \t]*(?:\/\/[ \t]*(.*))?$/gmu,
      (_, expr: string, note = '') =>
        `seen.push({ code: ${JSON.stringify(expr)}, note: ${JSON.stringify(note)}, value: (${expr}) });`,
    );
    const run = new Function('seen', ...names, code) as (...args: unknown[]) => void;
    run(seen, ...names.map((name) => lib[name]));

    expect(seen.length).toBeGreaterThanOrEqual(6);
    for (const { code: expr, note, value } of seen) {
      if (typeof value === 'number') expect(Number.isFinite(value), expr).toBe(true);
      else expect(Array.isArray(value) && value.length > 0, expr).toBe(true);
      // A comment that starts with a number states the result at that precision.
      const printed = /^-?\d+(?:\.(\d+))?/u.exec(note);
      if (printed) expect((value as number).toFixed(printed[1]?.length ?? 0), expr).toBe(printed[0]);
    }
    const value = (expr: string): unknown => seen.find((s) => s.code === expr)?.value;
    expect(value('best.optimum')).toBeGreaterThan(0);
    expect(value('best.optimum')).toBeLessThan(90);
    expect(value('fit.value')).toBeGreaterThan(80);
    expect(value('fit.value')).toBeLessThan(90);
    expect(value('fit.r2')).toBeGreaterThan(0.99);
    const liver = seen.at(-1)!.value as [string, number, number, string][];
    expect(liver.every(([tissue, , , pmid]) => /liver/iu.test(tissue) && pmid !== '')).toBe(true);
  });

  it('lists only names the package exports', () => {
    // The "Exports" column of the table under "What is in it".
    const rows = readme
      .slice(readme.indexOf('## What is in it'))
      .split('\n')
      .filter((line) => line.startsWith('| ') && !/^\| (Area|-)/u.test(line));
    const named = rows.flatMap((row) =>
      [...row.split('|')[2]!.matchAll(/`([A-Za-z_]\w*)`/gu)].map((m) => m[1]!),
    );
    expect(named.length).toBeGreaterThanOrEqual(20);
    for (const name of named) expect(lib[name], name).toBeDefined();
  });
});
