/** The package version, and the git commit it was built from when the build recorded one. */
import { readFileSync } from 'node:fs';

export interface VersionInfo {
  name: string;
  version: string;
  /** Commit the build came from (scripts/build-info.mjs), or null. */
  git: string | null;
  /** Whether tracked files differed from that commit at build time, or null. */
  dirty: boolean | null;
  node: string;
}

export function versionInfo(): VersionInfo {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    name: string;
    version: string;
  };
  let build: { git?: unknown; dirty?: unknown } = {};
  try {
    build = JSON.parse(readFileSync(new URL('./build-info.json', import.meta.url), 'utf8')) as {
      git?: unknown;
      dirty?: unknown;
    };
  } catch {
    // Not recorded: built without scripts/build-info.mjs.
  }
  return {
    name: pkg.name,
    version: pkg.version,
    git: typeof build.git === 'string' ? build.git : null,
    dirty: typeof build.dirty === 'boolean' ? build.dirty : null,
    node: process.version,
  };
}

export function versionLine(info: VersionInfo): string {
  const git = info.git ? ` (git ${info.git.slice(0, 12)}${info.dirty ? ', modified' : ''})` : '';
  return `${info.name} ${info.version}${git}`;
}
