/**
 * The Scanner's published files (`python -m trainer publish` in the tithies-scanner-trainer repo): the two models,
 * the every-print index and its prints, listed with their SHA-256 in a manifest at the root of a public Hugging Face
 * repository. The page reads the manifest (at most once a day, or when asked), downloads what it lacks, pinned to the
 * commit the manifest came from, and keeps each file in Cache Storage under its SHA-256: a new index alone doesn't
 * download the models again. Files the installed manifest no longer lists are removed.
 *
 * Developer path: the manifest, index and prints files (and the models) dropped on the page are installed the same
 * way, checked against the manifest.
 */
import { MODEL_CACHE } from './model-cache';
import { scannerDb } from './store';

export const SCANNER_REPO = 'tithies/card-scanner';
const HUB = `https://huggingface.co/${SCANNER_REPO}`;
export const MANIFEST_URL = `${HUB}/resolve/main/manifest.json`;
const DAY = 24 * 3600 * 1000;

export interface ManifestFile {
  path: string;
  sha256: string;
  bytes: number;
}

export const ROLES = ['detector', 'recognizer', 'index', 'prints'] as const;
export type FileRole = (typeof ROLES)[number];

/** The OCR files (phase 3), optional: the detector, Latin recognizer and dictionaries come with the other files;
 * the other scripts' recognizers are downloaded on first need. */
export const OCR_EAGER = ['ocrDet', 'ocrLatin', 'ocrDicts'] as const;
export const OCR_LAZY = ['ocrMain', 'ocrKorean', 'ocrCyrillic'] as const;
export type OcrRole = (typeof OCR_EAGER)[number] | (typeof OCR_LAZY)[number];
export type AnyRole = FileRole | OcrRole;

export interface Manifest {
  format: number;
  version: string;
  created: string;
  /** Date of the Scryfall bulk file the index was made from. */
  bulk: string | null;
  /** 'every-print' (published), or 'owned' (a small developer index of a collection). */
  gallery: string;
  count: number;
  index: { kind: string; dims: number; modelDims: number; method: string };
  files: Record<FileRole, ManifestFile> & Partial<Record<OcrRole, ManifestFile>>;
}

/** The files installed on this browser. */
export interface Installed {
  manifest: Manifest;
  /** The Hugging Face commit the files came from; null when they were dropped on the page. */
  commit: string | null;
  installedAt: number;
}

/** What the last manifest check found on Hugging Face. */
export interface LatestCheck {
  at: number;
  manifest?: Manifest;
  commit?: string;
  error?: string;
}

export function parseManifest(text: string): Manifest {
  const m = JSON.parse(text) as Manifest;
  const ok =
    m &&
    m.format === 1 &&
    typeof m.version === 'string' &&
    typeof m.count === 'number' &&
    m.index?.method === 'dino-pad-cls' &&
    ROLES.every((r) => typeof m.files?.[r]?.path === 'string' && /^[0-9a-f]{64}$/.test(m.files[r].sha256) && typeof m.files[r].bytes === 'number') &&
    [...OCR_EAGER, ...OCR_LAZY].every((r) => !m.files[r] || (typeof m.files[r]!.path === 'string' && /^[0-9a-f]{64}$/.test(m.files[r]!.sha256)));
  if (!ok) throw new Error('Not a Scanner manifest (or one this Tithies can\'t read)');
  return m;
}

/** A file's Cache Storage key: its SHA-256 (Cache Storage keys are requests: a made-up URL). */
export const fileKey = (sha256: string) => `https://tithies.local/scanner/sha256/${sha256}`;
const KEY_PREFIX = fileKey('');

export const fileUrl = (commit: string, path: string) => `${HUB}/resolve/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`;

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const metaGet = async <T>(key: string): Promise<T | undefined> => (await scannerDb.meta.get(key))?.value as T | undefined;
const metaPut = (key: string, value: unknown) => scannerDb.meta.put({ key, value });

export const installedFiles = (): Promise<Installed | undefined> => metaGet<Installed>('published');
export const lastCheck = (): Promise<LatestCheck | undefined> => metaGet<LatestCheck>('publishedCheck');

/** The manifest on Hugging Face now, and the commit it's at (its files are downloaded at that commit). */
export async function fetchLatest(fetchFn: typeof fetch = fetch): Promise<{ manifest: Manifest; commit: string }> {
  const res = await fetchFn(MANIFEST_URL, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`The Scanner's files on Hugging Face: HTTP ${res.status}`);
  const commit = res.headers.get('x-repo-commit');
  if (!commit || !/^[0-9a-f]{40}$/.test(commit)) throw new Error('Hugging Face sent no commit for the manifest');
  return { manifest: parseManifest(await res.text()), commit };
}

/** The latest manifest, from Hugging Face when the last check is a day old (or `force`), else as last seen. */
export async function checkLatest(opts: { force?: boolean; now?: number; fetchFn?: typeof fetch } = {}): Promise<LatestCheck> {
  const now = opts.now ?? Date.now();
  const last = await lastCheck();
  if (!opts.force && last && now - last.at < DAY) return last;
  let check: LatestCheck;
  try {
    check = { at: now, ...(await fetchLatest(opts.fetchFn)) };
  } catch (e) {
    // A failed check keeps what was seen before, and is tried again next time.
    return { ...(last ?? { at: 0 }), error: (e as Error).message };
  }
  await metaPut('publishedCheck', check);
  return check;
}

async function cached(sha: string): Promise<boolean> {
  return !!(await (await caches.open(MODEL_CACHE)).match(fileKey(sha)));
}

/**
 * The latest manifest only brings a new index (the daily refresh, trainer/refresh.py): same detector and recognizer,
 * another index or prints file. The page downloads those by itself; new models wait for the user.
 */
export function indexOnlyUpdate(installed: Installed | null | undefined, latest: LatestCheck | null | undefined): boolean {
  const m = latest?.manifest;
  // Files dropped on the page (developer path, no commit) stay until the user updates.
  if (!installed?.commit || !m || !latest?.commit || latest.commit === installed.commit) return false;
  const a = installed.manifest.files;
  const b = m.files;
  // Same models; another index, prints or OCR file (small: downloaded by itself).
  const others = (f: Manifest['files']) => JSON.stringify(Object.entries(f).filter(([k]) => k !== 'detector' && k !== 'recognizer').map(([k, v]) => [k, v?.sha256]).sort());
  return a.detector.sha256 === b.detector.sha256 && a.recognizer.sha256 === b.recognizer.sha256 && others(a) !== others(b);
}

/** The roles a manifest's first download fetches: the four files, and the eager OCR files it lists. */
export const eagerRoles = (m: Manifest): AnyRole[] => [...ROLES, ...OCR_EAGER.filter((r) => m.files[r])];

/** The manifest's files this browser doesn't have yet (among `roles`; those it lists). */
export async function missingFiles(manifest: Manifest, roles: readonly AnyRole[] = eagerRoles(manifest)): Promise<AnyRole[]> {
  const out: AnyRole[] = [];
  for (const r of roles) {
    const f = manifest.files[r];
    if (f && !(await cached(f.sha256))) out.push(r);
  }
  return out;
}

/** A file installed earlier, by its manifest entry. */
export async function readFile(f: ManifestFile): Promise<ArrayBuffer | null> {
  const hit = await (await caches.open(MODEL_CACHE)).match(fileKey(f.sha256));
  return hit ? hit.arrayBuffer() : null;
}

async function store(f: ManifestFile, bytes: ArrayBuffer, what: string) {
  if (bytes.byteLength !== f.bytes || (await sha256Hex(bytes)) !== f.sha256) throw new Error(`${what} isn't the file the manifest lists (size or SHA-256 differ)`);
  await (await caches.open(MODEL_CACHE)).put(fileKey(f.sha256), new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }));
}

/** Removes the stored files the installed manifest doesn't list. */
async function prune(manifest: Manifest) {
  const keep = new Set(Object.values(manifest.files).flatMap((f) => (f ? [fileKey(f.sha256)] : [])));
  const cache = await caches.open(MODEL_CACHE);
  for (const req of await cache.keys()) if (req.url.startsWith(KEY_PREFIX) && !keep.has(req.url)) await cache.delete(req);
}

async function install(manifest: Manifest, commit: string | null) {
  await metaPut('published', { manifest, commit, installedAt: Date.now() } satisfies Installed);
  await prune(manifest);
}

/** Downloads the files of a manifest this browser lacks (from its commit), checks them, then installs the manifest. */
export async function downloadPublished(
  manifest: Manifest,
  commit: string,
  opts: { onProgress?: (done: number, total: number, role: FileRole) => void; signal?: AbortSignal; fetchFn?: typeof fetch } = {},
): Promise<void> {
  const fetchFn = opts.fetchFn ?? fetch;
  const todo = await missingFiles(manifest);
  const total = todo.reduce((s, r) => s + manifest.files[r]!.bytes, 0);
  let done = 0;
  for (const role of todo) {
    const f = manifest.files[role]!;
    const res = await fetchFn(fileUrl(commit, f.path), { signal: opts.signal });
    if (!res.ok || !res.body) throw new Error(`Downloading ${f.path} failed: HTTP ${res.status}`);
    const bytes = new Uint8Array(f.bytes);
    let o = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      if (o + value.length > bytes.length) throw new Error(`${f.path} is larger than the manifest says`);
      bytes.set(value, o);
      o += value.length;
      done += value.length;
      opts.onProgress?.(done, total, role as FileRole);
    }
    await store(f, bytes.buffer.slice(0, o), f.path);
  }
  await install(manifest, commit);
}

/** A file of the installed manifest: from storage, else downloaded now at the install's commit (the lazy OCR files). */
export async function ensureFile(installed: Installed, role: AnyRole, fetchFn: typeof fetch = fetch): Promise<ArrayBuffer> {
  const f = installed.manifest.files[role];
  if (!f) throw new Error(`The installed Scanner files have no ${role}`);
  const have = await readFile(f);
  if (have) return have;
  if (!installed.commit) throw new Error(`${f.path} is not stored (files dropped on the page: drop it too)`);
  const res = await fetchFn(fileUrl(installed.commit, f.path));
  if (!res.ok) throw new Error(`Downloading ${f.path} failed: HTTP ${res.status}`);
  const bytes = await res.arrayBuffer();
  await store(f, bytes, f.path);
  return bytes;
}

/**
 * Developer path: a manifest.json dropped with its index and prints files (and the models, or models already stored),
 * checked against it and installed. Returns null when no manifest is among the files.
 */
export async function installDropped(files: readonly File[]): Promise<Manifest | null> {
  const mf = files.find((f) => f.name.toLowerCase() === 'manifest.json');
  if (!mf) return null;
  const manifest = parseManifest(await mf.text());
  const bySize = (f: ManifestFile) => files.filter((x) => x.size === f.bytes);
  for (const role of [...ROLES, ...OCR_EAGER, ...OCR_LAZY] as AnyRole[]) {
    const f = manifest.files[role];
    if (!f) continue;
    const name = f.path.split('/').pop()!;
    const candidates = [...files.filter((x) => x.name === name), ...bySize(f)];
    let stored = await cached(f.sha256);
    for (const c of stored ? [] : candidates) {
      const bytes = await c.arrayBuffer();
      if ((await sha256Hex(bytes)) === f.sha256) {
        await store(f, bytes, c.name);
        stored = true;
        break;
      }
    }
    if (!stored && (role === 'index' || role === 'prints')) throw new Error(`manifest.json lists ${name}: drop it with the manifest`);
  }
  await install(manifest, null);
  return manifest;
}

/** Bytes of the stored published files (the installed manifest's, those present). */
export async function measurePublished(): Promise<number> {
  if (typeof caches === 'undefined') return 0;
  const inst = await installedFiles();
  if (!inst) return 0;
  let bytes = 0;
  for (const f of Object.values(inst.manifest.files)) if (f && (await cached(f.sha256))) bytes += f.bytes;
  return bytes;
}
