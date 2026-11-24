/** What every command implements, and what it is given to run. */
import type { OptionSpecs, Values } from './args.js';

export interface Context {
  /** Directory that relative file names are resolved against. */
  cwd: string;
  /** Read the whole of standard input. */
  stdin: () => Promise<Uint8Array>;
  /** Diagnostics: progress and warnings. Never the result. */
  stderr: (text: string) => void;
  /** Whether stderr is a terminal (progress can then redraw one line). */
  stderrIsTTY: boolean;
  /** Suppress progress output. */
  quiet: boolean;
  /** Run another command in-process (for `run`); throws as the command would. */
  invoke: (argv: readonly string[], cwd: string) => Promise<Outcome>;
}

export interface Outcome {
  /** The result as plain JSON-able data (written with --json). */
  json: unknown;
  /** The result for people (written without --json). */
  text: string;
  /** Warnings from the library's input checks; written to stderr in text mode. */
  warnings: string[];
  /** Exit code when the result is printed but part of the work failed (default 0). */
  exitCode?: number;
}

export interface Command {
  name: string;
  /** One line for the command list. */
  summary: string;
  /** Usage lines, e.g. "mritoolbox ernst --t1 MS[,MS...] --tr MS". */
  usage: string;
  /** Paragraphs shown after the usage. */
  description: string;
  options: OptionSpecs;
  examples: string[];
  run: (ctx: Context, values: Values, positionals: string[]) => Promise<Outcome>;
}
