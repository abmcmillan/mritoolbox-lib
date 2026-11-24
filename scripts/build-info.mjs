// Records the git commit of this checkout in dist/cli/build-info.json, so that
// `mritoolbox --version` can report it: from the git checkout, else from a
// GitHub archive (scripts/git-commit.txt), else GITHUB_SHA, else null.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
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
if (!commit) {
  // A `git archive` of the repository (a GitHub tarball, as npm installs from
  // GitHub) has the commit written into this file (export-subst in .gitattributes).
  const archived = readFileSync(new URL('git-commit.txt', import.meta.url), 'utf8').trim();
  if (/^[0-9a-f]{40}$/u.test(archived)) commit = archived;
}
if (!commit && process.env.GITHUB_SHA) commit = process.env.GITHUB_SHA;

writeFileSync(
  new URL('../dist/cli/build-info.json', import.meta.url),
  `${JSON.stringify({ git: commit, dirty })}\n`,
);
console.log(`Recorded build commit ${commit ?? '(unknown)'}${dirty ? ' (modified)' : ''}.`);
