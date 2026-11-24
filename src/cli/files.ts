/** Reading inputs from files or standard input. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Context } from './command.js';

/** Bytes of `file`, or of standard input when `file` is "-". */
export async function readInput(ctx: Context, file: string): Promise<Uint8Array> {
  if (file === '-') return ctx.stdin();
  // A Buffer is a Uint8Array; returned as it is, so large images are not copied.
  return readFile(resolve(ctx.cwd, file));
}

/** Text of `file` (or standard input), UTF-8, without a byte-order mark. */
export async function readText(ctx: Context, file: string): Promise<string> {
  return new TextDecoder('utf-8', { ignoreBOM: false }).decode(await readInput(ctx, file));
}

/** Gzip streams start with the bytes 1f 8b. */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}
