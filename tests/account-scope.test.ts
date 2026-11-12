/**
 * Guard: per-account tables are only touched by the account access layer (src/lib/accounts/data.ts)
 * and the Selling runner (runs and items it owns). Anything else must go through accountData(key),
 * so one account's data can't leak into another's view by a forgotten filter.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..');
const SCOPED = ['accountDecks', 'accountDeckCards', 'collectionEntries', 'accountMeta', 'runs', 'items'] as const;
/** Which scoped tables each file may use directly. */
const ALLOWED: Record<string, readonly string[]> = {
  'src/lib/db.ts': SCOPED,
  'src/lib/accounts/data.ts': SCOPED,
  'src/features/f2f-buylist/runner.ts': ['runs', 'items'],
};

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* sourceFiles(p);
    else if (/\.(ts|tsx)$/.test(name)) yield p;
  }
}

/** The scoped tables a file uses directly, and other ways around the access layer. */
export function violations(file: string, text: string): string[] {
  const allowed = new Set(ALLOWED[file] ?? []);
  const out: string[] = [];
  for (const t of SCOPED) {
    if (allowed.has(t)) continue;
    if (new RegExp(`\\bdb\\s*\\.\\s*${t}\\b`).test(text)) out.push(`db.${t}`);
    if (new RegExp(`\\.table\\(\\s*['"\`]${t}['"\`]`).test(text)) out.push(`.table('${t}')`);
  }
  // Destructuring tables off the database, or opening it again, would get around the checks above.
  if (!ALLOWED[file] && /\{[^}]*\b(accountDecks|accountDeckCards|collectionEntries|accountMeta|runs|items)\b[^}]*\}\s*=\s*db\b/.test(text)) out.push('destructured from db');
  if (file !== 'src/lib/db.ts' && /new\s+(TithiesDB|Dexie)\s*\(/.test(text)) out.push('opens a database');
  if (!ALLOWED[file] && /\bdb\.tables\b/.test(text)) out.push('db.tables');
  return out;
}

describe('Per-account tables', () => {
  it('are only used through the account access layer', () => {
    const found: string[] = [];
    for (const path of sourceFiles(join(ROOT, 'src'))) {
      const file = relative(ROOT, path).replace(/\\/g, '/');
      for (const v of violations(file, readFileSync(path, 'utf8'))) found.push(`${file}: ${v}`);
    }
    expect(found).toEqual([]);
  });

  it('the guard catches direct uses (self-test)', () => {
    expect(violations('src/features/x.ts', "const r = await db.accountDecks.toArray();")).toEqual(['db.accountDecks']);
    expect(violations('src/features/x.ts', "await db.runs.where('status').anyOf('running')")).toEqual(['db.runs']);
    expect(violations('src/features/x.ts', "tx.table('collectionEntries').clear()")).toEqual([".table('collectionEntries')"]);
    expect(violations('src/features/x.ts', 'const { accountMeta } = db;')).toEqual(['destructured from db']);
    expect(violations('src/features/x.ts', 'const other = new TithiesDB("x");')).toEqual(['opens a database']);
    expect(violations('src/features/f2f-buylist/runner.ts', 'db.runs.get(1); db.accountDecks.clear()')).toEqual(['db.accountDecks']);
    expect(violations('src/features/x.ts', 'db.f2fCache.clear(); db.meta.get("bulkRates")')).toEqual([]);
  });
});
