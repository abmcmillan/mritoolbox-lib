/** Command dispatch, help, --version, output and exit codes. */
import { parseArgs } from 'node:util';
import { optionHelp, parseCommand } from './args.js';
import type { Command, Context, Outcome } from './command.js';
import { contrast } from './commands/contrast.js';
import { db } from './commands/db.js';
import { ernst } from './commands/ernst.js';
import { fit } from './commands/fit.js';
import { map } from './commands/map.js';
import { mprage } from './commands/mprage.js';
import { run } from './commands/run.js';
import { signal } from './commands/signal.js';
import { EXIT, UsageError, report } from './errors.js';
import { versionInfo, versionLine } from './version.js';

export const COMMANDS: readonly Command[] = [ernst, signal, contrast, mprage, fit, map, db, run];

export interface Streams {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stdin: () => Promise<Uint8Array>;
  stderrIsTTY: boolean;
  cwd: string;
}

function globalHelp(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  return [
    `${versionLine(versionInfo())}: MRI calculations from mritoolbox.com`,
    '',
    'Usage: mritoolbox COMMAND [options]',
    '',
    'Commands:',
    ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    '',
    'Options:',
    '      --json     Write the result as JSON on stdout (every command).',
    '  -h, --help     Show help; `mritoolbox COMMAND --help` for a command.',
    '  -v, --version  Show the version and the git commit it was built from.',
    '',
    'Exit codes: 0 success, 1 failure (a file or a calculation failed),',
    '2 usage error, 3 invalid input (refused by the input checks).',
    'Times are in ms, angles in degrees, field strengths in tesla, signals in units of M0.',
  ].join('\n');
}

export function commandHelp(command: Command): string {
  return [
    `Usage: ${command.usage}`,
    '',
    command.description,
    '',
    'Options:',
    optionHelp(command.options),
    '',
    'Examples:',
    ...command.examples.map((e) => `  ${e}`),
  ].join('\n');
}

function findCommand(name: string): Command {
  const command = COMMANDS.find((c) => c.name === name);
  if (!command)
    throw new UsageError(`Unknown command "${name}". Run \`mritoolbox --help\` for the list.`);
  return command;
}

/** Parse and run one command; throws what the command throws. */
export async function execute(
  argv: readonly string[],
  ctx: Context,
): Promise<{ command: Command; outcome: Outcome | undefined; json: boolean }> {
  const command = findCommand(argv[0]!);
  const { values, positionals } = parseCommand(argv.slice(1), command.options);
  const json = values.json === true;
  if (values.help) return { command, outcome: undefined, json };
  const outcome = await command.run({ ...ctx, quiet: ctx.quiet || values.quiet === true }, values, positionals);
  return { command, outcome, json };
}

/** Run the CLI; returns the exit code. */
export async function main(argv: readonly string[], streams: Streams): Promise<number> {
  const wantsJson = argv.includes('--json');
  const ctx: Context = {
    cwd: streams.cwd,
    stdin: streams.stdin,
    stderr: streams.stderr,
    stderrIsTTY: streams.stderrIsTTY,
    quiet: false,
    invoke: async (args, cwd) => {
      const { outcome } = await execute(args, { ...ctx, cwd, quiet: true });
      if (!outcome) throw new UsageError('--help is not a result.');
      return outcome;
    },
  };
  let name = 'mritoolbox';
  try {
    const first = argv[0];
    if (first === undefined || first === 'help' || first.startsWith('-')) {
      if (first === 'help' && argv[1] !== undefined) {
        streams.stdout(`${commandHelp(findCommand(argv[1]))}\n`);
        return EXIT.ok;
      }
      const { values, positionals } = parseArgs({
        args: first === 'help' ? [] : [...argv],
        options: {
          help: { type: 'boolean', short: 'h' },
          version: { type: 'boolean', short: 'v' },
          json: { type: 'boolean' },
        },
        allowPositionals: true,
        strict: true,
      });
      if (positionals.length)
        throw new UsageError('Options go after the command: mritoolbox COMMAND [options].');
      if (values.version) {
        const info = versionInfo();
        streams.stdout(values.json ? `${JSON.stringify(info, null, 2)}\n` : `${versionLine(info)}\n`);
        return EXIT.ok;
      }
      if (values.help || first === undefined || first === 'help') {
        streams.stdout(`${globalHelp()}\n`);
        return EXIT.ok;
      }
      throw new UsageError('Give a command. Run `mritoolbox --help` for the list.');
    }

    name = `mritoolbox ${first}`;
    const { command, outcome, json } = await execute(argv, ctx);
    if (!outcome) {
      streams.stdout(`${commandHelp(command)}\n`);
      return EXIT.ok;
    }
    if (json) streams.stdout(`${JSON.stringify(outcome.json, null, 2)}\n`);
    else {
      streams.stdout(`${outcome.text}\n`);
      for (const warning of outcome.warnings) streams.stderr(`${name}: warning: ${warning}\n`);
    }
    return outcome.exitCode ?? EXIT.ok;
  } catch (error) {
    const rep = report(error);
    const lines = rep.errors.length > 1 ? rep.errors : [rep.message];
    streams.stderr(`${name}: ${lines.join(`\n${' '.repeat(name.length + 2)}`)}\n`);
    if (rep.exitCode === EXIT.usage && COMMANDS.some((c) => name === `mritoolbox ${c.name}`))
      streams.stderr(`Run \`${name} --help\` for usage.\n`);
    if (process.env.MRITOOLBOX_DEBUG && error instanceof Error)
      streams.stderr(`${error.stack ?? ''}\n`);
    if (wantsJson) streams.stdout(`${JSON.stringify({ error: rep }, null, 2)}\n`);
    return rep.exitCode;
  }
}
