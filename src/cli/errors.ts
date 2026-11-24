/** Errors the CLI reports, and the exit code each one gives. */
import { InvalidInputError } from 'mritoolbox';

/** Exit codes: 0 success, 1 failure, 2 usage error, 3 invalid input. */
export const EXIT = {
  /** The command ran. */
  ok: 0,
  /** It could not finish: a file could not be read or written, a fit did not converge. */
  failure: 1,
  /** The command line is wrong: an unknown command or option, a missing or malformed value. */
  usage: 2,
  /** The values are well formed but cannot be computed: the library's input checks, bad data files. */
  invalid: 3,
} as const;

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly errors: string[] = [message],
  ) {
    super(message);
  }
}

/** A problem with the command line itself (exit 2). */
export class UsageError extends CliError {
  override name = 'UsageError';
  constructor(message: string) {
    super(message, EXIT.usage);
  }
}

/** Input that is well formed but cannot be used (exit 3). */
export class InputError extends CliError {
  override name = 'InputError';
  constructor(errors: string | readonly string[]) {
    const list = typeof errors === 'string' ? [errors] : [...errors];
    super(list.join(' '), EXIT.invalid, list);
  }
}

/** A calculation or file operation that failed (exit 1). */
export class FailureError extends CliError {
  override name = 'FailureError';
  constructor(message: string) {
    super(message, EXIT.failure);
  }
}

export interface ErrorReport {
  name: string;
  message: string;
  errors: string[];
  exitCode: number;
}

const IO_CODES = new Set(['ENOENT', 'EACCES', 'EISDIR', 'ENOTDIR', 'EPERM', 'EEXIST', 'ENOSPC']);

/** Turn anything thrown into a report with an exit code. */
export function report(error: unknown): ErrorReport {
  if (error instanceof CliError)
    return {
      name: error.name,
      message: error.message,
      errors: error.errors,
      exitCode: error.exitCode,
    };
  if (error instanceof InvalidInputError)
    return {
      name: error.name,
      message: error.message,
      errors: [...error.errors],
      exitCode: EXIT.invalid,
    };
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS_')) {
    const message = (error as Error).message;
    return { name: 'UsageError', message, errors: [message], exitCode: EXIT.usage };
  }
  if (error instanceof Error) {
    const message =
      typeof code === 'string' && IO_CODES.has(code)
        ? error.message.replace(/^\w+: /u, '')
        : error.message;
    return { name: error.name, message, errors: [message], exitCode: EXIT.failure };
  }
  return { name: 'Error', message: String(error), errors: [String(error)], exitCode: EXIT.failure };
}

/**
 * Run a library call whose plain Errors mean unusable input (fitCurve, new
 * Fitter): InvalidInputError and those Errors exit 3; a fit that did not
 * converge exits 1.
 */
export function libraryCall<T>(call: () => T): T {
  try {
    return call();
  } catch (error) {
    if (error instanceof InvalidInputError) throw error;
    if (error instanceof Error) {
      if (/did not converge/u.test(error.message)) throw new FailureError(error.message);
      throw new InputError(error.message);
    }
    throw error;
  }
}
