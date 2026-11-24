/** Text output: numbers and aligned tables. JSON output: plain data. */

/** A number to `digits` significant figures, without trailing zeros. */
export function fmt(value: number | undefined, digits = 4): string {
  if (value === undefined) return '–';
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  if (value === 0) return '0';
  const size = Math.abs(value);
  if (size >= 1e-3 && size < 1e7) {
    const whole = Math.floor(Math.log10(size)) + 1;
    return String(Number(value.toPrecision(Math.max(digits, Math.min(whole, 21)))));
  }
  return value.toExponential(digits - 1).replace(/\.?0+e/u, 'e');
}

/** Columns padded to a common width, the header underlined. */
export function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = header.map((h, c) => Math.max(h.length, ...rows.map((row) => row[c]!.length)));
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, c) => (c === cells.length - 1 ? cell : cell.padEnd(widths[c]!)))
      .join('  ')
      .trimEnd();
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

/** Typed arrays to arrays, functions dropped, so that JSON.stringify gives everything. */
export function plain(value: unknown): unknown {
  if (ArrayBuffer.isView(value) && !(value instanceof DataView))
    return Array.from(value as unknown as ArrayLike<number>);
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) if (typeof v !== 'function') out[key] = plain(v);
    return out;
  }
  return value;
}
