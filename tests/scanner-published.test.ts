import { checkLatest, downloadPublished, eagerRoles, ensureFile, fileKey, indexOnlyUpdate, installDropped, installedFiles, MANIFEST_URL, measurePublished, missingFiles, parseManifest, readFile, sha256Hex, type Manifest } from '@/features/scanner/published';
import { MODEL_CACHE } from '@/features/scanner/model-cache';
import { scannerDb } from '@/features/scanner/store';

/** Cache Storage in memory (Node has none). */
class FakeCache {
  readonly entries = new Map<string, ArrayBuffer>();
  async match(key: string | Request) {
    const b = this.entries.get(typeof key === 'string' ? key : key.url);
    return b ? new Response(b.slice(0)) : undefined;
  }
  async put(key: string, res: Response) {
    this.entries.set(key, await res.arrayBuffer());
  }
  async delete(key: string | Request) {
    return this.entries.delete(typeof key === 'string' ? key : key.url);
  }
  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
}
const store = new Map<string, FakeCache>();
(globalThis as unknown as { caches: unknown }).caches = {
  open: async (name: string) => store.get(name) ?? store.set(name, new FakeCache()).get(name)!,
  delete: async (name: string) => store.delete(name),
};
const cache = () => store.get(MODEL_CACHE) ?? new FakeCache();

const file = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const COMMIT = 'a'.repeat(40);
const COMMIT2 = 'b'.repeat(40);

async function manifestFor(files: Record<string, ArrayBuffer>, version = 'v2'): Promise<Manifest> {
  const entry = async (name: string) => ({ path: `${version}/${name}`, sha256: await sha256Hex(files[name]), bytes: files[name].byteLength });
  return {
    format: 1,
    version,
    created: '2026-11-23T18:00:00Z',
    bulk: '2026-11-23',
    gallery: 'every-print',
    count: 3,
    index: { kind: 'i8', dims: 384, modelDims: 384, method: 'dino-pad-cls' },
    files: {
      detector: await entry('card-detector.onnx'),
      recognizer: await entry('card-recognizer.onnx'),
      index: await entry(Object.keys(files).find((n) => n.startsWith('index-'))!),
      prints: await entry(Object.keys(files).find((n) => n.startsWith('prints-'))!),
    },
  };
}

/** A Hugging Face stand-in: the manifest at main, files at their commit; records what was fetched. */
function hub(manifest: Manifest, files: Record<string, ArrayBuffer>, commit = COMMIT) {
  const fetched: string[] = [];
  const fn = (async (url: string) => {
    fetched.push(url);
    if (url === MANIFEST_URL) return new Response(JSON.stringify(manifest), { headers: { 'x-repo-commit': commit } });
    const m = url.match(/\/resolve\/([0-9a-f]{40})\/v\d+\/(.+)$/);
    const b = m && m[1] === commit ? files[decodeURIComponent(m[2])] : undefined;
    return b ? new Response(b.slice(0)) : new Response('missing', { status: 404 });
  }) as typeof fetch;
  return { fn, fetched };
}

const v1files = () => ({
  'card-detector.onnx': file('detector bytes'),
  'card-recognizer.onnx': file('recognizer bytes'),
  'index-1.bin': file('index one'),
  'prints-1.json.gz': file('prints one'),
});

describe('published Scanner files', () => {
  beforeEach(async () => {
    store.clear();
    await scannerDb.meta.clear();
  });

  it('reads only manifests it knows', async () => {
    const m = await manifestFor(v1files());
    expect(parseManifest(JSON.stringify(m)).version).toBe('v2');
    expect(() => parseManifest(JSON.stringify({ ...m, format: 2 }))).toThrow(/Not a Scanner manifest/);
    expect(() => parseManifest(JSON.stringify({ ...m, index: { ...m.index, method: 'other' } }))).toThrow();
  });

  it('checks Hugging Face at most once a day, unless asked', async () => {
    const files = v1files();
    const h = hub(await manifestFor(files), files);
    const day = 24 * 3600 * 1000;
    const first = await checkLatest({ now: 1000, fetchFn: h.fn });
    expect(first.commit).toBe(COMMIT);
    expect(first.manifest?.version).toBe('v2');
    await checkLatest({ now: 1000 + day - 1, fetchFn: h.fn });
    expect(h.fetched).toHaveLength(1);
    await checkLatest({ now: 1000 + day - 1, fetchFn: h.fn, force: true });
    expect(h.fetched).toHaveLength(2);
    // A failed check keeps what was seen, with the error.
    const failing = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    const failed = await checkLatest({ now: 1000 + 3 * day, fetchFn: failing });
    expect(failed.manifest?.version).toBe('v2');
    expect(failed.error).toMatch(/HTTP 503/);
  });

  it('downloads what is missing, then on an update only the new index; old files go', async () => {
    const files = v1files();
    const m1 = await manifestFor(files);
    const h1 = hub(m1, files);
    const progress: number[] = [];
    await downloadPublished(m1, COMMIT, { fetchFn: h1.fn, onProgress: (done) => progress.push(done) });
    expect(h1.fetched).toHaveLength(4);
    expect(progress.at(-1)).toBe(Object.values(files).reduce((s, b) => s + b.byteLength, 0));
    expect((await installedFiles())?.commit).toBe(COMMIT);
    expect(await missingFiles(m1)).toEqual([]);
    expect(new TextDecoder().decode((await readFile(m1.files.index))!)).toBe('index one');
    expect(await measurePublished()).toBe(progress.at(-1));

    const files2 = { ...files, 'index-2.bin': file('index two'), 'prints-2.json.gz': file('prints two') };
    delete (files2 as Record<string, ArrayBuffer>)['index-1.bin'];
    delete (files2 as Record<string, ArrayBuffer>)['prints-1.json.gz'];
    const m2 = await manifestFor(files2);
    const h2 = hub(m2, files2, COMMIT2);
    await downloadPublished(m2, COMMIT2, { fetchFn: h2.fn });
    expect(h2.fetched.map((u) => u.split('/').pop())).toEqual(['index-2.bin', 'prints-2.json.gz']);
    const keys = [...cache().entries.keys()];
    expect(keys).toHaveLength(4);
    expect(keys).not.toContain(fileKey(m1.files.index.sha256));
    expect(keys).toContain(fileKey(m1.files.recognizer.sha256));
    expect((await installedFiles())?.manifest.files.index.path).toBe('v2/index-2.bin');
  });

  it('refuses a file that is not the one the manifest lists', async () => {
    const files = v1files();
    const m = await manifestFor(files);
    const tampered = { ...files, 'index-1.bin': file('index 0ne') };
    await expect(downloadPublished(m, COMMIT, { fetchFn: hub(m, tampered).fn })).rejects.toThrow(/isn't the file the manifest lists/);
    expect(await installedFiles()).toBeUndefined();
  });

  it('installs files dropped with their manifest (developer path)', async () => {
    const files = v1files();
    const m = await manifestFor(files);
    const asFile = (name: string) => new File([files[name as keyof typeof files]], name);
    await expect(installDropped([new File([JSON.stringify(m)], 'manifest.json'), asFile('index-1.bin')])).rejects.toThrow(/prints-1\.json\.gz/);
    const got = await installDropped([new File([JSON.stringify(m)], 'manifest.json'), asFile('index-1.bin'), asFile('prints-1.json.gz')]);
    expect(got?.version).toBe('v2');
    const inst = await installedFiles();
    expect(inst?.commit).toBeNull();
    // Models not dropped (the page uses the dropped ones it has): only they are missing.
    expect(await missingFiles(m)).toEqual(['detector', 'recognizer']);
    expect(await installDropped([asFile('index-1.bin')])).toBeNull();
  });
});

describe('index-only updates', () => {
  it('are the ones with the same models and another index', async () => {
    const files = v1files();
    const m1 = await manifestFor(files);
    const installed = { manifest: m1, commit: COMMIT, installedAt: 1 };
    const m2 = await manifestFor({ ...files, 'index-1.bin': file('index two'), 'prints-1.json.gz': file('prints two') });
    expect(indexOnlyUpdate(installed, { at: 2, manifest: m2, commit: COMMIT2 })).toBe(true);
    // The same commit, or nothing new: no update.
    expect(indexOnlyUpdate(installed, { at: 2, manifest: m1, commit: COMMIT })).toBe(false);
    expect(indexOnlyUpdate(installed, { at: 2, manifest: m1, commit: COMMIT2 })).toBe(false);
    // Another recognizer: a new version, for the Update button.
    const m3 = await manifestFor({ ...files, 'card-recognizer.onnx': file('recognizer v3'), 'index-1.bin': file('index three') });
    expect(indexOnlyUpdate(installed, { at: 2, manifest: m3, commit: COMMIT2 })).toBe(false);
    expect(indexOnlyUpdate(undefined, { at: 2, manifest: m2, commit: COMMIT2 })).toBe(false);
    expect(indexOnlyUpdate(installed, { at: 2, error: 'offline' })).toBe(false);
  });
});

describe('OCR files (phase 3)', () => {
  beforeEach(async () => {
    store.clear();
    await scannerDb.meta.clear();
  });

  async function withOcr() {
    const files = { ...v1files(), 'det.onnx': file('det'), 'latin.onnx': file('latin'), 'dicts.json': file('{"latin":["a"]}'), 'main.onnx': file('main') };
    const m = await manifestFor(files);
    const entry = async (name: keyof typeof files) => ({ path: `ocr/${name}`, sha256: await sha256Hex(files[name]), bytes: files[name].byteLength });
    m.files.ocrDet = await entry('det.onnx');
    m.files.ocrLatin = await entry('latin.onnx');
    m.files.ocrDicts = await entry('dicts.json');
    m.files.ocrMain = await entry('main.onnx');
    // The hub stand-in serves ocr/ paths too.
    const fetched: string[] = [];
    const fn = (async (url: string) => {
      fetched.push(url);
      const m2 = url.match(/\/resolve\/([0-9a-f]{40})\/(?:v\d+|ocr)\/(.+)$/);
      const b = m2 && m2[1] === COMMIT ? files[decodeURIComponent(m2[2]) as keyof typeof files] : undefined;
      return b ? new Response(b.slice(0)) : new Response('missing', { status: 404 });
    }) as typeof fetch;
    return { m, fn, fetched };
  }

  it('downloads the detector, Latin recognizer and dictionaries with the rest; the other scripts on first need', async () => {
    const { m, fn, fetched } = await withOcr();
    expect(eagerRoles(m)).toEqual(['detector', 'recognizer', 'index', 'prints', 'ocrDet', 'ocrLatin', 'ocrDicts']);
    await downloadPublished(m, COMMIT, { fetchFn: fn });
    expect(fetched.map((u) => u.split('/').pop())).toEqual(['card-detector.onnx', 'card-recognizer.onnx', 'index-1.bin', 'prints-1.json.gz', 'det.onnx', 'latin.onnx', 'dicts.json']);
    const inst = (await installedFiles())!;
    expect(new TextDecoder().decode(await ensureFile(inst, 'ocrMain', fn))).toBe('main');
    expect(fetched.at(-1)).toMatch(/ocr\/main\.onnx$/);
    // Stored now: no second download.
    await ensureFile(inst, 'ocrMain', fn);
    expect(fetched.filter((u) => u.endsWith('main.onnx'))).toHaveLength(1);
    expect(cache().entries.size).toBe(8);
  });

  it('counts a new OCR file alone as an update to download by itself', async () => {
    const { m } = await withOcr();
    const installed = { manifest: { ...m, files: { ...m.files, ocrDet: undefined } }, commit: COMMIT, installedAt: 1 };
    expect(indexOnlyUpdate(installed, { at: 2, manifest: m, commit: COMMIT2 })).toBe(true);
  });
});
