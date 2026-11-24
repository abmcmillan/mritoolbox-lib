import { optimiseContrast, type ContrastMode, type Tissue } from 'mritoolbox';
import { choice, noMorePositionals, optNumber, tuple, type Values } from '../args.js';
import type { Command } from '../command.js';
import { fmt, plain, table } from '../format.js';

const MODES = ['gre', 'se-t1', 'se-t2'] as const satisfies readonly ContrastMode[];

const tissue = (values: Values, name: string): Tissue => {
  const [pd, t1, t2] = tuple(values, name, 3, 'PD,T1,T2');
  return { pd: pd!, t1: t1!, t2: t2! };
};

export const contrast: Command = {
  name: 'contrast',
  summary: 'Contrastinator: flip angle, TR or TE with the largest two-tissue contrast',
  usage:
    'mritoolbox contrast gre|se-t1|se-t2 --tissue1 PD,T1,T2 --tissue2 PD,T1,T2 [--te MS] [--tr MS]',
  description: [
    'Finds the value that maximises the signal difference between two tissues:',
    '  gre    the flip angle of a spoiled gradient echo at fixed TE and TR (T2 is T2*)',
    '  se-t1  the TR of a T1-weighted spin echo at fixed TE',
    '  se-t2  the TE of a T2-weighted spin echo at fixed TR',
    'Times in ms, PD as a fraction (0 to 1).',
  ].join('\n'),
  options: {
    tissue1: { type: 'string', arg: 'PD,T1,T2', help: 'First tissue.' },
    tissue2: { type: 'string', arg: 'PD,T1,T2', help: 'Second tissue.' },
    te: { type: 'string', arg: 'MS', help: 'Echo time (gre and se-t1).' },
    tr: { type: 'string', arg: 'MS', help: 'Repetition time (gre and se-t2).' },
    curve: { type: 'boolean', help: 'Include the sampled signal curves in the JSON.' },
  },
  examples: [
    'mritoolbox contrast gre --tissue1 0.69,830,53 --tissue2 0.82,1330,66 --te 5 --tr 100',
    'mritoolbox contrast se-t1 --tissue1 0.92,750,75 --tissue2 1,1450,100 --te 5 --json',
  ],
  async run(_ctx, values, positionals) {
    const mode = choice(positionals[0], MODES, 'mode');
    noMorePositionals(positionals, 1);
    const tissues: [Tissue, Tissue] = [tissue(values, 'tissue1'), tissue(values, 'tissue2')];
    const te = optNumber(values, 'te');
    const tr = optNumber(values, 'tr');
    const r = optimiseContrast({
      mode,
      tissues,
      ...(te !== undefined ? { te } : {}),
      ...(tr !== undefined ? { tr } : {}),
    });
    const json = {
      command: 'contrast',
      mode,
      tissues,
      ...(te !== undefined ? { te } : {}),
      ...(tr !== undefined ? { tr } : {}),
      variable: r.variable,
      optimum: r.optimum,
      signals: r.signals,
      difference: r.difference,
      ratio: r.ratio,
      warnings: r.warnings,
      ...(values.curve ? { curve: plain(r.curve) } : {}),
    };
    const unit = r.variable.unit === '°' ? '°' : ` ${r.variable.unit}`;
    const text = [
      `Optimum ${r.variable.name}: ${fmt(r.optimum)}${unit}`,
      '',
      table(
        ['', 'Signal (M0)'],
        [
          ['Tissue 1', fmt(r.signals[0])],
          ['Tissue 2', fmt(r.signals[1])],
          ['Difference', fmt(r.difference)],
          ['Ratio', fmt(r.ratio)],
        ],
      ),
    ].join('\n');
    return { json, text, warnings: r.warnings };
  },
};
