/**
 * Curve data for `fit`: CSV (or any delimited text) and JSON.
 *
 * CSV: one row per x value; the first column is x, every further column one
 * curve. Delimiters: comma, semicolon, tab or spaces. An optional first row of
 * column names labels the curves; lines starting with "#" are comments.
 *
 * JSON: {"x": [...], "y": [...]} or {"x": [...], "y": [[...], [...]]}, with
 * optional "labels"; or an array of rows [[x, y1, y2, ...], ...].
 */
import { InputError } from './errors.js';

export interface Curves {
  x: number[];
  curves: { label: string; y: number[] }[];
}

const CELL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$|^[+-]?(?:inf(?:inity)?|nan)$/iu;

function cellValue(text: string): number {
  const t = text.trim().toLowerCase();
  if (t === 'nan') return NaN;
  if (/^[+-]?inf/u.test(t)) return t.startsWith('-') ? -Infinity : Infinity;
  return Number(t);
}

function splitRow(line: string): string[] {
  const trimmed = line.trim();
  if (/[,;\t]/u.test(trimmed))
    return trimmed.split(/\s*[,;\t]\s*/u).map((c) => c.replace(/^"(.*)"$/u, '$1'));
  return trimmed.split(/\s+/u);
}

function fromRows(rows: number[][], labels: string[] | undefined, source: string): Curves {
  if (rows.length === 0) throw new InputError(`${source} has no data rows.`);
  const width = rows[0]!.length;
  if (width < 2) throw new InputError(`${source} needs at least two columns: x and y.`);
  const x = rows.map((r) => r[0]!);
  const curves = Array.from({ length: width - 1 }, (_, c) => ({
    label: labels?.[c + 1] ?? (width > 2 ? `y${c + 1}` : 'y'),
    y: rows.map((r) => r[c + 1]!),
  }));
  return { x, curves };
}

export function parseCsv(text: string, source: string): Curves {
  const lines = text.split(/\r?\n/u);
  const rows: number[][] = [];
  let labels: string[] | undefined;
  let width = 0;
  lines.forEach((line, n) => {
    if (line.trim() === '' || line.trimStart().startsWith('#')) return;
    const cells = splitRow(line);
    if (rows.length === 0 && labels === undefined && !cells.every((c) => CELL.test(c.trim()))) {
      labels = cells;
      width = cells.length;
      return;
    }
    if (width === 0) width = cells.length;
    if (cells.length !== width)
      throw new InputError(
        `${source}, line ${n + 1}: ${cells.length} columns where the data have ${width}.`,
      );
    const bad = cells.find((c) => !CELL.test(c.trim()));
    if (bad !== undefined)
      throw new InputError(`${source}, line ${n + 1}: "${bad}" is not a number.`);
    rows.push(cells.map(cellValue));
  });
  return fromRows(rows, labels, source);
}

const isNumberArray = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every((e) => typeof e === 'number');

export function parseJsonData(text: string, source: string): Curves {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new InputError(`${source} is not valid JSON: ${(error as Error).message}`);
  }
  if (Array.isArray(data)) {
    if (!data.every(isNumberArray))
      throw new InputError(`${source}: a JSON array must hold rows of numbers [x, y, ...].`);
    const width = data[0]?.length ?? 0;
    if (data.some((row) => row.length !== width))
      throw new InputError(`${source}: every row must have the same number of values.`);
    return fromRows(data, undefined, source);
  }
  if (data === null || typeof data !== 'object')
    throw new InputError(`${source}: expected {"x": [...], "y": [...]} or an array of rows.`);
  const { x, y, labels } = data as { x?: unknown; y?: unknown; labels?: unknown };
  if (!isNumberArray(x)) throw new InputError(`${source}: "x" must be an array of numbers.`);
  const ys = isNumberArray(y) ? [y] : Array.isArray(y) && y.every(isNumberArray) ? y : undefined;
  if (!ys || ys.length === 0)
    throw new InputError(`${source}: "y" must be an array of numbers or an array of such arrays.`);
  if (labels !== undefined && !(Array.isArray(labels) && labels.every((l) => typeof l === 'string')))
    throw new InputError(`${source}: "labels" must be an array of strings.`);
  return {
    x,
    curves: ys.map((values, c) => ({
      label: (labels as string[] | undefined)?.[c] ?? (ys.length > 1 ? `y${c + 1}` : 'y'),
      y: values,
    })),
  };
}

/** JSON when the text starts with "{" or "[", otherwise delimited text. */
export function parseCurveData(text: string, source: string): Curves {
  const first = text.trimStart()[0];
  return first === '{' || first === '[' ? parseJsonData(text, source) : parseCsv(text, source);
}
