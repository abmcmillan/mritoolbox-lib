// Turns data/parameter-database.json into a TypeScript module, so the package
// needs no JSON import support from the runtime that loads it.
import { readFileSync, writeFileSync } from 'node:fs';

const here = new URL('..', import.meta.url);
const records = JSON.parse(readFileSync(new URL('data/parameter-database.json', here), 'utf8'));
const fields = ['PMID', 'Tissue', 'FieldStrength', 'T1', 'T2'];
for (const [index, record] of records.entries()) {
  for (const field of fields) {
    if (typeof record[field] !== 'string')
      throw new Error(`Record ${index}: "${field}" is missing.`);
  }
}
const body = records.map((record) => `  ${JSON.stringify(record)},`).join('\n');
writeFileSync(
  new URL('src/database-data.generated.ts', here),
  `// Generated from data/parameter-database.json by scripts/embed-data.mjs. Do not edit.\nimport type { RawEntry } from './database.js';\n\nconst RAW: RawEntry[] = [\n${body}\n];\nexport default RAW;\n`,
);
console.log(`Embedded ${records.length} database records.`);
