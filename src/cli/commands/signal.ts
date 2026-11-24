import {
  DEG,
  checkContrast,
  checkFit,
  inversionRecoverySignal,
  spgrSignal,
  spinEchoSignal,
  type Check,
  type ContrastInput,
} from 'mritoolbox';
import { choice, noMorePositionals, optList, type Values } from '../args.js';
import type { Command } from '../command.js';
import { InputError, UsageError } from '../errors.js';
import { fmt, table } from '../format.js';

const SEQUENCES = ['spgr', 'se', 'ir'] as const;
type Sequence = (typeof SEQUENCES)[number];

interface Param {
  key: string;
  label: string;
  default?: number;
}

const PARAMS: Record<Sequence, Param[]> = {
  spgr: [
    { key: 'pd', label: 'PD', default: 1 },
    { key: 't1', label: 'T1 (ms)' },
    { key: 't2', label: 'T2* (ms)', default: Infinity },
    { key: 'tr', label: 'TR (ms)' },
    { key: 'te', label: 'TE (ms)', default: 0 },
    { key: 'flip', label: 'Flip (°)' },
  ],
  se: [
    { key: 'pd', label: 'PD', default: 1 },
    { key: 't1', label: 'T1 (ms)' },
    { key: 't2', label: 'T2 (ms)' },
    { key: 'tr', label: 'TR (ms)' },
    { key: 'te', label: 'TE (ms)' },
  ],
  ir: [
    { key: 'pd', label: 'PD', default: 1 },
    { key: 't1', label: 'T1 (ms)' },
    { key: 'ti', label: 'TI (ms)' },
    { key: 'tr', label: 'TR (ms)', default: Infinity },
    { key: 'efficiency', label: 'Efficiency', default: 1 },
  ],
};

type Row = Record<string, number>;

/** Spin-echo and SPGR checks come from checkContrast, which names its tissues; there is one here. */
const oneTissue = (check: Check): Check => ({
  errors: check.errors.map((e) => e.replace(' of tissue 1', '')),
  warnings: check.warnings.map((w) => w.replace(' of tissue 1', '')),
});

function checkRow(sequence: Sequence, r: Row): Check {
  // An infinite T2* (no decay) is valid here; the library's check wants a finite one.
  const tissue = { pd: r.pd!, t1: r.t1!, t2: r.t2 === Infinity ? Number.MAX_VALUE : r.t2! };
  const tissues = [tissue] as unknown as ContrastInput['tissues'];
  switch (sequence) {
    case 'spgr': {
      const check = oneTissue(checkContrast({ mode: 'gre', tissues, te: r.te!, tr: r.tr! }));
      if (!(Number.isFinite(r.flip) && r.flip! >= 0 && r.flip! <= 180))
        check.errors.push('The flip angle must be between 0° and 180°.');
      return check;
    }
    case 'se': {
      const t1w = oneTissue(checkContrast({ mode: 'se-t1', tissues, te: r.te! }));
      const t2w = oneTissue(checkContrast({ mode: 'se-t2', tissues, tr: r.tr! }));
      const check = {
        errors: [...new Set([...t1w.errors, ...t2w.errors])],
        warnings: [...new Set([...t1w.warnings, ...t2w.warnings])],
      };
      if (check.errors.length === 0 && r.te! > r.tr!)
        check.errors.push(`TE (${r.te} ms) cannot be longer than TR (${r.tr} ms).`);
      return check;
    }
    case 'ir': {
      const check = checkFit('t1ir', [r.ti!], { tr: r.tr! });
      const errors = [...check.errors];
      if (!(Number.isFinite(r.pd) && r.pd! >= 0 && r.pd! <= 1))
        errors.push('PD must be between 0 and 1.');
      if (!(Number.isFinite(r.t1) && r.t1! > 0)) errors.push('T1 must be greater than zero.');
      if (!(Number.isFinite(r.efficiency) && r.efficiency! > 0 && r.efficiency! <= 1))
        errors.push('The inversion efficiency must be greater than 0 and at most 1.');
      return { errors, warnings: check.warnings };
    }
  }
}

function signalOf(sequence: Sequence, r: Row): number {
  switch (sequence) {
    case 'spgr':
      return spgrSignal(r.pd!, r.t1!, r.t2!, r.tr!, r.te!, r.flip! * DEG);
    case 'se':
      return spinEchoSignal(r.pd!, r.t1!, r.t2!, r.tr!, r.te!);
    case 'ir':
      return inversionRecoverySignal(r.pd!, r.t1!, r.ti!, r.tr!, r.efficiency!);
  }
}

/** Each option is one value or a list; lists must share one length and are walked together. */
function rows(sequence: Sequence, values: Values): Row[] {
  const params = PARAMS[sequence];
  const keys = new Set(params.map((p) => p.key));
  for (const key of ['pd', 't1', 't2', 'tr', 'te', 'flip', 'ti', 'efficiency'])
    if (values[key] !== undefined && !keys.has(key))
      throw new UsageError(`--${key} does not apply to ${sequence}.`);
  const lists = params.map((p) => {
    const list = optList(values, p.key);
    if (list) return list;
    if (p.default === undefined) throw new UsageError(`--${p.key} is required for ${sequence}.`);
    return [p.default];
  });
  const n = Math.max(...lists.map((l) => l.length));
  lists.forEach((list, i) => {
    if (list.length !== 1 && list.length !== n)
      throw new UsageError(
        `--${params[i]!.key} has ${list.length} values; every list must have 1 or ${n}.`,
      );
  });
  return Array.from({ length: n }, (_, row) =>
    Object.fromEntries(params.map((p, i) => [p.key, lists[i]![lists[i]!.length === 1 ? 0 : row]!])),
  );
}

export const signal: Command = {
  name: 'signal',
  summary: 'Signal equations: spoiled gradient echo, spin echo, inversion recovery',
  usage: [
    'mritoolbox signal spgr --t1 MS --tr MS --flip DEG [--te MS --t2 MS] [--pd PD]',
    '       mritoolbox signal se   --t1 MS --t2 MS --tr MS --te MS [--pd PD]',
    '       mritoolbox signal ir   --t1 MS --ti MS [--tr MS] [--efficiency A] [--pd PD]',
  ].join('\n'),
  description: [
    'Signal as a fraction of M0 from the textbook equations: steady-state spoiled gradient echo',
    '(spgr; --t2 is T2*), spin echo with ideal pulses (se) and signed inversion recovery (ir;',
    'omit --tr for full relaxation). Any option takes a comma-separated list; lists must share',
    'one length and give one row each, single values apply to every row.',
  ].join('\n'),
  options: {
    pd: { type: 'string', arg: 'PD', help: 'Proton density, 0 to 1 (default 1).' },
    t1: { type: 'string', arg: 'MS', help: 'T1 in ms.' },
    t2: { type: 'string', arg: 'MS', help: 'T2 in ms (T2* for spgr; default: no decay).' },
    tr: { type: 'string', arg: 'MS', help: 'Repetition time in ms (ir: default inf).' },
    te: { type: 'string', arg: 'MS', help: 'Echo time in ms (spgr: default 0).' },
    flip: { type: 'string', arg: 'DEG', help: 'Flip angle in degrees (spgr).' },
    ti: { type: 'string', arg: 'MS', help: 'Inversion time in ms (ir).' },
    efficiency: { type: 'string', arg: 'A', help: 'Inversion efficiency, 0 to 1 (ir; default 1).' },
  },
  examples: [
    'mritoolbox signal spgr --t1 830 --tr 10 --flip 2,5,8.9,15,30',
    'mritoolbox signal se --pd 0.69 --t1 830 --t2 53 --tr 500 --te 15',
    'mritoolbox signal ir --t1 830 --ti 100,300,575,1000 --tr 5000 --json',
  ],
  async run(_ctx, values, positionals) {
    const sequence = choice(positionals[0], SEQUENCES, 'sequence');
    noMorePositionals(positionals, 1);
    const all = rows(sequence, values);
    const errors: string[] = [];
    const warnings: string[] = [];
    all.forEach((row, n) => {
      const prefix = all.length > 1 ? `Row ${n + 1}: ` : '';
      const check = checkRow(sequence, row);
      errors.push(...check.errors.map((e) => prefix + e));
      warnings.push(...check.warnings.map((w) => prefix + w));
    });
    if (errors.length) throw new InputError(errors);
    const results: Row[] = all.map((row) => ({ ...row, signal: signalOf(sequence, row) }));
    const params = PARAMS[sequence];
    return {
      json: { command: 'signal', sequence, results, warnings },
      text: table(
        [...params.map((p) => p.label), 'Signal (M0)'],
        results.map((r) => [...params.map((p) => fmt(r[p.key], 6)), fmt(r.signal, 6)]),
      ),
      warnings,
    };
  },
};
