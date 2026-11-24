import { ernstAngleDeg } from 'mritoolbox';
import { noMorePositionals, requireList, requireNumber } from '../args.js';
import type { Command } from '../command.js';
import { InputError } from '../errors.js';
import { fmt, table } from '../format.js';

export const ernst: Command = {
  name: 'ernst',
  summary: 'Ernst angle of a spoiled gradient echo for T1 and TR',
  usage: 'mritoolbox ernst --t1 MS[,MS...] --tr MS',
  description:
    'The flip angle that maximises the steady-state spoiled gradient-echo signal, acos(exp(-TR/T1)), in degrees.',
  options: {
    t1: { type: 'string', arg: 'MS[,MS...]', help: 'T1 in ms; several values give one row each.' },
    tr: { type: 'string', arg: 'MS', help: 'Repetition time in ms.' },
  },
  examples: ['mritoolbox ernst --t1 830 --tr 10', 'mritoolbox ernst --t1 750,1450 --tr 10 --json'],
  async run(_ctx, values, positionals) {
    noMorePositionals(positionals, 0);
    const t1s = requireList(values, 't1');
    const tr = requireNumber(values, 'tr');
    const errors: string[] = [];
    if (!(Number.isFinite(tr) && tr > 0)) errors.push('TR must be greater than zero.');
    t1s.forEach((t1, n) => {
      if (!(Number.isFinite(t1) && t1 > 0))
        errors.push(`T1${t1s.length > 1 ? ` (value ${n + 1})` : ''} must be greater than zero.`);
    });
    if (errors.length) throw new InputError(errors);
    const results = t1s.map((t1) => ({ t1, angle: ernstAngleDeg(t1, tr) }));
    return {
      json: { command: 'ernst', tr, unit: 'degrees', results },
      text: table(
        ['T1 (ms)', 'TR (ms)', 'Ernst angle (°)'],
        results.map((r) => [fmt(r.t1, 6), fmt(tr, 6), fmt(r.angle)]),
      ),
      warnings: [],
    };
  },
};
