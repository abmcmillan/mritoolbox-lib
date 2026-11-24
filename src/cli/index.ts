#!/usr/bin/env node
/**
 * The `mritoolbox` command. Not part of the library's exports: the library
 * stays free of Node APIs and dependencies, and this file is its Node front end.
 */
import { main } from './main.js';

// A reader that closed the pipe early (`mritoolbox db | head`) is not an error.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

async function readStdin(): Promise<Uint8Array> {
  if (process.stdin.isTTY) {
    const end = process.platform === 'win32' ? 'Ctrl-Z, Enter' : 'Ctrl-D';
    process.stderr.write(`Reading standard input (end with ${end})…\n`);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

process.exitCode = await main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  stdin: readStdin,
  stderrIsTTY: process.stderr.isTTY === true,
  cwd: process.cwd(),
});
