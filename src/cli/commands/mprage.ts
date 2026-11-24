import {
  checkMprage,
  simulateMprage,
  simulateMprageImage,
  type MprageSequence,
  type MprageTissue,
} from 'mritoolbox';
import { noMorePositionals, requireNumber, tuple, type Values } from '../args.js';
import type { Command } from '../command.js';
import { UsageError } from '../errors.js';
import { fmt, plain, table } from '../format.js';

const tissue = (values: Values, name: string): MprageTissue => {
  const [pd, t1, t2] = tuple(values, name, 3, 'PD,T1,T2');
  return { pd: pd!, t1: t1!, t2: t2! };
};

function sequence(values: Values): MprageSequence {
  return {
    flipAngle: requireNumber(values, 'flip'),
    spoilIncrement: requireNumber(values, 'spoil'),
    tr: requireNumber(values, 'tr'),
    td1: requireNumber(values, 'td1'),
    td2: requireNumber(values, 'td2'),
    np: requireNumber(values, 'np'),
    ...(values['ideal-spoiling'] ? { idealSpoiling: true } : {}),
  };
}

export const mprage: Command = {
  name: 'mprage',
  summary: 'MP-RAGE signal by extended phase graphs (one tissue, or a two-tissue image)',
  usage: [
    'mritoolbox mprage --tissue PD,T1,T2 SEQUENCE',
    '       mritoolbox mprage --tissue-a PD,T1,T2 --tissue-b PD,T1,T2 SEQUENCE',
    '  SEQUENCE: --flip DEG --spoil DEG --tr MS --td1 MS --td2 MS --np N [--ideal-spoiling]',
  ].join('\n'),
  description: [
    'Simulates an MP-RAGE readout with the extended phase graph algorithm, repeating inversions',
    'until the longitudinal magnetisation reaches its steady state. With --tissue it reports the',
    'transverse signal after each pulse; with --tissue-a and --tissue-b it simulates the 1-D image',
    'of two adjacent tissue blocks (linear phase encoding) and reports the mean signal of each.',
  ].join('\n'),
  options: {
    tissue: { type: 'string', arg: 'PD,T1,T2', help: 'One tissue: per-pulse signal.' },
    'tissue-a': { type: 'string', arg: 'PD,T1,T2', help: 'Tissue A of the two-tissue image.' },
    'tissue-b': { type: 'string', arg: 'PD,T1,T2', help: 'Tissue B of the two-tissue image.' },
    flip: { type: 'string', arg: 'DEG', help: 'Readout flip angle in degrees.' },
    spoil: { type: 'string', arg: 'DEG', help: 'Quadratic RF-spoiling phase increment in degrees.' },
    tr: { type: 'string', arg: 'MS', help: 'Repetition time within the readout train.' },
    td1: { type: 'string', arg: 'MS', help: 'Delay from the inversion to the readout train.' },
    td2: { type: 'string', arg: 'MS', help: 'Recovery delay after the readout train.' },
    np: { type: 'string', arg: 'N', help: 'RF pulses (phase-encoding lines) per inversion.' },
    'ideal-spoiling': { type: 'boolean', help: 'Destroy transverse magnetisation every TR.' },
    profile: { type: 'boolean', help: 'Two tissues: include the profile and evolutions in JSON.' },
  },
  examples: [
    'mritoolbox mprage --tissue-a 1,1450,100 --tissue-b 0.92,750,75 --flip 9 --spoil 50 --tr 7 --td1 330 --td2 830 --np 160',
    'mritoolbox mprage --tissue 0.69,830,80 --flip 9 --spoil 50 --tr 8 --td1 900 --td2 1000 --np 160 --json',
  ],
  async run(_ctx, values, positionals) {
    noMorePositionals(positionals, 0);
    const single = values.tissue !== undefined;
    const pair = values['tissue-a'] !== undefined || values['tissue-b'] !== undefined;
    if (single === pair)
      throw new UsageError('Give either --tissue, or both --tissue-a and --tissue-b.');
    const seq = sequence(values);

    if (single) {
      const t = tissue(values, 'tissue');
      const r = simulateMprage(t, seq);
      // simulateMprage throws on errors; its warnings come from the same check.
      const { warnings } = checkMprage([t], seq);
      const magnitude = Array.from(r.re, (re, i) => Math.hypot(re, r.im[i]!));
      const centre = Math.floor(magnitude.length / 2);
      return {
        json: {
          command: 'mprage',
          tissue: t,
          sequence: seq,
          loops: r.loops,
          steadyState: r.steadyState,
          magnitude,
          re: plain(r.re),
          im: plain(r.im),
          phase: plain(r.phase),
          warnings,
        },
        text: [
          `Steady state: ${r.steadyState ? 'yes' : 'no'} after ${r.loops} inversions`,
          '',
          table(
            ['Pulse', 'Signal (M0)'],
            [0, centre, magnitude.length - 1].map((i) => [
              `${i + 1}${i === centre ? ' (centre)' : ''}`,
              fmt(magnitude[i]),
            ]),
          ),
        ].join('\n'),
        warnings,
      };
    }

    const a = tissue(values, 'tissue-a');
    const b = tissue(values, 'tissue-b');
    const r = simulateMprageImage(a, b, seq);
    return {
      json: {
        command: 'mprage',
        tissueA: a,
        tissueB: b,
        sequence: seq,
        signalA: r.signalA,
        signalB: r.signalB,
        loops: r.loops,
        steadyState: r.steadyState,
        warnings: r.warnings,
        ...(values.profile
          ? {
              profile: plain(r.profile),
              evolutionA: plain(r.evolutionA),
              evolutionB: plain(r.evolutionB),
              maskA: plain(r.maskA),
              maskB: plain(r.maskB),
            }
          : {}),
      },
      text: [
        `Steady state: ${r.steadyState ? 'yes' : 'no'} after ${r.loops[0]} and ${r.loops[1]} inversions`,
        '',
        table(
          ['', 'Signal (M0)'],
          [
            ['Tissue A', fmt(r.signalA, 6)],
            ['Tissue B', fmt(r.signalB, 6)],
          ],
        ),
      ].join('\n'),
      warnings: r.warnings,
    };
  },
};
