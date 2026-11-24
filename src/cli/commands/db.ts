import { searchDatabase } from 'mritoolbox';
import { optNumber } from '../args.js';
import type { Command } from '../command.js';
import { InputError } from '../errors.js';
import { fmt, table } from '../format.js';

export const db: Command = {
  name: 'db',
  summary: 'Search the database of published in vivo T1 and T2 values',
  usage: 'mritoolbox db [WORDS...] [--field T]',
  description: [
    'Lists the records whose tissue path, field strength ("3t") or PubMed ID contain every word,',
    'alphabetically. With no words it lists every record. T1 and T2 are in ms as published',
    '(mean ± SD or a range); the JSON also holds the parsed means.',
  ].join('\n'),
  options: {
    field: { type: 'string', arg: 'T', help: 'Only records at this field strength, in tesla.' },
  },
  examples: ['mritoolbox db liver --field 3', 'mritoolbox db white matter --json'],
  async run(_ctx, values, positionals) {
    const query = positionals.join(' ');
    const field = optNumber(values, 'field');
    if (field !== undefined && !(Number.isFinite(field) && field > 0))
      throw new InputError('The field strength must be greater than zero.');
    const entries = searchDatabase(query, field).map(({ haystack: _h, ...entry }) => entry);
    return {
      json: { command: 'db', query, field: field ?? null, count: entries.length, entries },
      text:
        entries.length === 0
          ? 'No records match.'
          : `${table(
              ['Tissue', 'B0 (T)', 'T1 (ms)', 'T2 (ms)', 'PMID'],
              entries.map((e) => [e.tissue, fmt(e.field), e.t1Text, e.t2Text, e.pmid]),
            )}\n\n${entries.length} record${entries.length === 1 ? '' : 's'}`,
      warnings: [],
    };
  },
};
