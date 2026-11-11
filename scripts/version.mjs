// Extension version = <major>.<minor> from package.json + an automatic patch number: how many
// commits changed the extension (code, dependencies, build config). Pushes that only touch the
// README, tests or the download page keep the version, so users aren't told about an "update".
// Local builds with uncommitted extension changes count as the next commit, so they match what
// GitHub will publish once committed. Used by wxt.config.ts and scripts/build-site.mjs.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Paths whose changes produce a new extension build (public/ holds the icons and other static files). */
export const EXTENSION_PATHS = ['src', 'public', 'wxt.config.ts', 'package.json', 'package-lock.json', 'postcss.config.cjs'];

/** "0.1.0" + 7 commits → "0.1.7" (Chrome versions: 1–4 dot-separated integers, each ≤ 65535). */
export function toExtensionVersion(baseVersion, commits, dirty = false) {
  const [major = 0, minor = 0] = String(baseVersion)
    .split('-')[0]
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
  const patch = Math.min(65535, Math.max(0, commits) + (dirty ? 1 : 0));
  return `${major}.${minor}.${patch}`;
}

export function extensionVersion(root = join(import.meta.dirname, '..')) {
  const base = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const commits = Number.parseInt(git('rev-list', '--count', 'HEAD', '--', ...EXTENSION_PATHS), 10) || 0;
    const dirty = git('status', '--porcelain', '--', ...EXTENSION_PATHS) !== '';
    return toExtensionVersion(base, commits, dirty);
  } catch {
    return base; // no git (e.g. a source zip): fall back to package.json
  }
}
