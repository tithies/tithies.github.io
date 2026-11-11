// Builds the GitHub Pages site into site-dist/: the download page (site/), the extension zip
// (from `npm run zip`) and version.json, which the dashboard reads to announce updates.
// Usage: npm run zip && node scripts/build-site.mjs
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const out = join(root, 'site-dist');
const outputDir = join(root, '.output');

// The built manifest has the real version (computed by scripts/version.mjs, not package.json).
const manifestPath = join(outputDir, 'chrome-mv3', 'manifest.json');
if (!existsSync(manifestPath)) throw new Error('No .output/chrome-mv3: run "npm run zip" first.');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const { version } = manifest;
const zipPath = join(outputDir, 'tithies-chrome.zip');
if (!existsSync(zipPath)) throw new Error('No .output/tithies-chrome.zip: run "npm run zip" first.');
const zip = readFileSync(zipPath);

// Extension ID = first 128 bits of SHA-256(public key), written with the letters a–p.
const extensionId = manifest.key
  ? [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)]
      .map((c) => String.fromCharCode(97 + Number.parseInt(c, 16)))
      .join('')
  : '';

function repoUrl() {
  if (process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY) return `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`;
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' }).trim();
    const m = remote.match(/github\.com[:/](.+?)(\.git)?$/);
    if (m) return `https://github.com/${m[1]}`;
  } catch {
    /* no git */
  }
  return 'https://github.com';
}

// The page's own address, for the absolute URLs link previews need (og:url, og:image).
const siteUrl = readFileSync(join(root, 'src', 'lib', 'release-url.ts'), 'utf8').match(/RELEASE_PAGE_URL = '([^']+)'/)?.[1];
if (!siteUrl) throw new Error('RELEASE_PAGE_URL not found in src/lib/release-url.ts');

const versionedFile = `tithies-${version}.zip`;
const sha256 = createHash('sha256').update(zip).digest('hex');
const publishedAt = new Date().toISOString();
const size = zip.length;

rmSync(out, { recursive: true, force: true });
cpSync(join(root, 'site'), out, { recursive: true });
writeFileSync(join(out, 'tithies.zip'), zip);
writeFileSync(join(out, versionedFile), zip);
writeFileSync(join(out, 'version.json'), `${JSON.stringify({ version, file: 'tithies.zip', versionedFile, size, sha256, publishedAt, extensionId }, null, 2)}\n`);

const values = {
  VERSION: version,
  SIZE: size >= 1_000_000 ? `${(size / 1_000_000).toFixed(1)} MB` : `${Math.round(size / 1000)} KB`,
  DATE: publishedAt.slice(0, 10),
  SHA256: sha256,
  EXTENSION_ID: extensionId || '(set at install)',
  VERSIONED_FILE: versionedFile,
  REPO_URL: repoUrl(),
  SITE_URL: siteUrl,
};
const indexPath = join(out, 'index.html');
const html = readFileSync(indexPath, 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => {
  if (!(k in values)) throw new Error(`Unknown placeholder ${m} in site/index.html`);
  return values[k];
});
writeFileSync(indexPath, html);
console.log(`Site built in ${out}: Tithies ${version}, ${values.SIZE}, id ${extensionId || 'not pinned'}`);
