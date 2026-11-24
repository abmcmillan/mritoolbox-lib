/** Command-line parsing on node:util parseArgs, with number and list helpers. */
import { parseArgs } from 'node:util';
import { UsageError } from './errors.js';

export interface OptionSpec {
  type: 'string' | 'boolean';
  short?: string;
  multiple?: boolean;
  /** Placeholder shown in the help, e.g. "MS". */
  arg?: string;
  help: string;
}
export type OptionSpecs = Record<string, OptionSpec>;
export type Values = Record<string, string | boolean | string[] | undefined>;

/** Options every command accepts. */
export const COMMON_OPTIONS: OptionSpecs = {
  json: { type: 'boolean', help: 'Write the result as JSON on stdout.' },
  help: { type: 'boolean', short: 'h', help: 'Show this help.' },
};

/** An argument that starts with "-" but is a number or a list of numbers, e.g. "-5" or "-928,-819". */
const NEGATIVE = /^-(?:\d|\.\d|inf(?:inity)?(?:$|[\s,;]))/iu;

export interface Parsed {
  values: Values;
  positionals: string[];
}

/**
 * Parse `args` strictly. A string option may be followed by a negative
 * number (`--y -5,3`), which parseArgs on its own rejects as ambiguous.
 */
export function parseCommand(args: readonly string[], specs: OptionSpecs): Parsed {
  const all = { ...specs, ...COMMON_OPTIONS };
  const strings = new Set(Object.keys(all).filter((name) => all[name]!.type === 'string'));
  const shorts = new Map<string, string>();
  for (const [name, spec] of Object.entries(all)) if (spec.short) shorts.set(spec.short, name);

  const fixed: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      fixed.push(...args.slice(i));
      break;
    }
    const next = args[i + 1];
    const name =
      arg.startsWith('--') && !arg.includes('=')
        ? arg.slice(2)
        : /^-[^-]$/u.test(arg)
          ? shorts.get(arg[1]!)
          : undefined;
    if (name !== undefined && strings.has(name) && next !== undefined && NEGATIVE.test(next)) {
      fixed.push(`--${name}=${next}`);
      i++;
    } else fixed.push(arg);
  }

  const options = Object.fromEntries(
    Object.entries(all).map(([name, spec]) => [
      name,
      {
        type: spec.type,
        ...(spec.short ? { short: spec.short } : {}),
        ...(spec.multiple ? { multiple: true } : {}),
      },
    ]),
  );
  try {
    const { values, positionals } = parseArgs({
      args: fixed,
      options,
      allowPositionals: true,
      strict: true,
    });
    return { values: values as Values, positionals };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS_'))
      throw new UsageError((error as Error).message.split('\n')[0]!);
    throw error;
  }
}

const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu;
const INFINITE = /^([+-]?)inf(?:inity)?$/iu;

/** A decimal number, or "inf" / "Infinity" (either sign). */
export function parseNumber(text: string, what: string): number {
  const t = text.trim();
  const inf = INFINITE.exec(t);
  if (inf) return inf[1] === '-' ? -Infinity : Infinity;
  if (!DECIMAL.test(t)) throw new UsageError(`${what} must be a number, not "${text}".`);
  return Number(t);
}

/** Numbers separated by commas, semicolons or white space. */
export function parseList(text: string, what: string): number[] {
  const parts = text.split(/[\s,;]+/u).filter(Boolean);
  if (parts.length === 0) throw new UsageError(`${what} needs at least one number.`);
  return parts.map((part) => parseNumber(part, what));
}

function stringValue(values: Values, name: string): string | undefined {
  const value = values[name];
  if (Array.isArray(value)) return value.at(-1);
  return typeof value === 'string' ? value : undefined;
}

export function optString(values: Values, name: string): string | undefined {
  return stringValue(values, name);
}

export function requireString(values: Values, name: string): string {
  const value = stringValue(values, name);
  if (value === undefined) throw new UsageError(`--${name} is required.`);
  return value;
}

export function optNumber(values: Values, name: string): number | undefined {
  const value = stringValue(values, name);
  return value === undefined ? undefined : parseNumber(value, `--${name}`);
}

export function requireNumber(values: Values, name: string): number {
  return parseNumber(requireString(values, name), `--${name}`);
}

export function optList(values: Values, name: string): number[] | undefined {
  const value = stringValue(values, name);
  return value === undefined ? undefined : parseList(value, `--${name}`);
}

export function requireList(values: Values, name: string): number[] {
  return parseList(requireString(values, name), `--${name}`);
}

/** A whole number at least `min`. */
export function optInteger(values: Values, name: string, min: number): number | undefined {
  const value = optNumber(values, name);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < min)
    throw new UsageError(`--${name} must be a whole number of at least ${min}, not ${value}.`);
  return value;
}

/** Exactly `count` numbers, e.g. a tissue given as PD,T1,T2. */
export function tuple(values: Values, name: string, count: number, shape: string): number[] {
  const list = requireList(values, name);
  if (list.length !== count)
    throw new UsageError(`--${name} takes ${count} numbers (${shape}), not ${list.length}.`);
  return list;
}

/** One of `choices`, from a positional argument. */
export function choice<T extends string>(
  value: string | undefined,
  choices: readonly T[],
  what: string,
): T {
  if (value === undefined) throw new UsageError(`Give the ${what}: ${choices.join(', ')}.`);
  if (!(choices as readonly string[]).includes(value))
    throw new UsageError(`Unknown ${what} "${value}". Choose one of: ${choices.join(', ')}.`);
  return value as T;
}

export function noMorePositionals(positionals: readonly string[], allowed: number): void {
  if (positionals.length > allowed)
    throw new UsageError(`Unexpected argument "${positionals[allowed]}".`);
}

/** The "Options" block of a command's help. */
export function optionHelp(specs: OptionSpecs): string {
  const all = { ...specs, ...COMMON_OPTIONS };
  const rows = Object.entries(all).map(([name, spec]) => {
    const flag = `${spec.short ? `-${spec.short}, ` : '    '}--${name}${spec.arg ? ` ${spec.arg}` : ''}`;
    return [flag, spec.help] as const;
  });
  const width = Math.max(...rows.map(([flag]) => flag.length));
  return rows.map(([flag, help]) => `  ${flag.padEnd(width)}  ${help}`).join('\n');
}
