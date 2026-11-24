// Records the git commit of this checkout in dist/cli/build-info.json, so that
// `mritoolbox --version` can report it. Outside a git checkout of this
// repository the commit is null (GITHUB_SHA is used when set).
import { execFileSync } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

let commit = null;
let dirty = null;
try {
  // Only this repository's own checkout counts, not a project it is installed into.
  if (realpathSync(git('rev-parse', '--show-toplevel')) === realpathSync(root)) {
    commit = git('rev-parse', 'HEAD');
    dirty = git('status', '--porcelain', '--untracked-files=no') !== '';
  }
} catch {
  // No git, or not a checkout.
}
if (!commit && process.env.GITHUB_SHA) commit = process.env.GITHUB_SHA;

writeFileSync(
  new URL('../dist/cli/build-info.json', import.meta.url),
  `${JSON.stringify({ git: commit, dirty })}\n`,
);
console.log(`Recorded build commit ${commit ?? '(unknown)'}${dirty ? ' (modified)' : ''}.`);
