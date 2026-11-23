import { readFileSync } from 'node:fs';
import { gunzipText, parsePrints, printMask, readIndexBin, rowVector, searchVectorIndex, topKFromScores, type VectorIndex } from '@/features/scanner/index-file';
import { pairResults } from '@/features/scanner/pipeline';
import { SearchCore } from '@/features/scanner/search-core';

// Written by the trainer: python -m trainer index --fixture tests/fixtures/scanner-index (random vectors, made-up prints).
const dir = `${__dirname}/fixtures/scanner-index`;
const bytes = (name: string) => {
  const b = readFileSync(`${dir}/${name}`);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const expected = JSON.parse(readFileSync(`${dir}/expected.json`, 'utf8')) as { queries: number[][]; formats: Record<string, [number, number][][]> };
const queries = expected.queries.map((q) => Float32Array.from(q));

describe('every-print index files', () => {
  for (const [format, want] of Object.entries(expected.formats)) {
    it(`finds the trainer's top 5 in ${format}`, () => {
      const idx = readIndexBin(bytes(`index-${format}.bin`));
      expect(`${idx.kind}-${idx.dims}`).toBe(format);
      expect(idx.count).toBe(40);
      const hits = searchVectorIndex(idx, queries, 5);
      hits.forEach((h, q) => {
        expect(h.map((x) => x.index)).toEqual(want[q].map(([i]) => i));
        h.forEach((x, i) => expect(x.score).toBeCloseTo(want[q][i][1], 5));
      });
    });
  }

  it('gives the same top 5 from a scores matrix (the GPU path), and skips masked rows', () => {
    const idx = readIndexBin(bytes('index-i8-384.bin'));
    const scores = new Float32Array(queries.length * idx.count);
    queries.forEach((q, qi) => {
      for (let r = 0; r < idx.count; r++) {
        let s = 0;
        for (let j = 0; j < idx.dims; j++) s += q[j] * idx.rows[r * idx.dims + j];
        scores[qi * idx.count + r] = s * idx.scales![r];
      }
    });
    const fromScores = topKFromScores(scores, queries.length, idx.count, 5);
    const direct = searchVectorIndex(idx, queries, 5);
    expect(fromScores.map((h) => h.map((x) => x.index))).toEqual(direct.map((h) => h.map((x) => x.index)));
    const mask = new Uint8Array(idx.count).fill(1);
    mask[direct[0][0].index] = 0;
    expect(topKFromScores(scores, queries.length, idx.count, 5, mask)[0].map((x) => x.index)).toEqual(searchVectorIndex(idx, queries, 5, mask)[0].map((x) => x.index));
    expect(searchVectorIndex(idx, queries, 5, mask)[0][0].index).toBe(direct[0][1].index);
  });

  it('finds a row from its own vector', () => {
    const idx = readIndexBin(bytes('index-f32-64.bin'));
    const hit = searchVectorIndex({ ...idx, basis: null, modelDims: idx.dims } as VectorIndex, [rowVector(idx, 7)], 1)[0][0];
    expect(hit.index).toBe(7);
    expect(hit.score).toBeCloseTo(1, 5);
  });

  it('refuses other files', () => {
    expect(() => readIndexBin(new ArrayBuffer(64))).toThrow(/Not a Scanner index/);
    expect(() => readIndexBin(bytes('index-i8-384.bin').slice(0, 1000))).toThrow(/cut short/);
  });

  it('reads the prints file', async () => {
    const prints = parsePrints(await gunzipText(bytes('prints.json.gz')));
    expect(prints).toHaveLength(40);
    expect(prints[3]).toMatchObject({ scryfallId: '00000000-0000-4000-8000-000000000003', name: 'Test Card 3', set: 'tst', setName: 'Test Set', cn: '4', lang: 'en', art: 1, finishes: 1 });
    expect(prints[3].back).toBeUndefined();
  });
});

describe('only my prints', () => {
  const p = (scryfallId: string, set: string, cn: string, back?: boolean) => ({ scryfallId, name: 'X', set, setName: 'S', cn, lang: 'en', art: 0, finishes: 1, ...(back ? { back } : {}) });
  const prints = [p('a', 'mh3', '1'), p('b', 'mh3', '2'), p('b', 'mh3', '2', true), p('c', 'otc', '7')];

  it('keeps the owned prints by id (both faces), else by set and number', () => {
    expect([...printMask(prints, [{ scryfallId: 'b', set: 'mh3', cn: '2' }])]).toEqual([0, 1, 1, 0]);
    // A French print the index doesn't hold: its set and number's default print.
    expect([...printMask(prints, [{ scryfallId: 'fr-c', set: 'OTC', cn: '7' }])]).toEqual([0, 0, 0, 1]);
    expect([...printMask(prints, [{ scryfallId: 'zz', set: 'xxx', cn: '1' }])]).toEqual([0, 0, 0, 0]);
  });
});

describe('search core (CPU)', () => {
  it('loads, searches and masks', async () => {
    const core = new SearchCore();
    const info = await core.load(bytes('index-i8-64.bin'), { gpu: false });
    expect(info).toMatchObject({ count: 40, dims: 64, modelDims: 384, kind: 'i8', backend: 'cpu' });
    const { hits } = await core.search(queries, 5);
    expect(hits.map((h) => h.map((x) => x.index))).toEqual(expected.formats['i8-64'].map((q) => q.map(([i]) => i)));
    const mask = new Uint8Array(40);
    mask[5] = 1;
    core.setMask(mask);
    expect((await core.search(queries, 5)).hits[0].map((x) => x.index)).toEqual([5]);
    expect(() => core.setMask(new Uint8Array(3))).toThrow(/Mask of 3 rows/);
    core.dispose();
  });
});

describe('naming from index hits', () => {
  const prints = ['A', 'A', 'B', 'C'].map((name, i) => ({ scryfallId: `id${i}`, name, set: 's', setName: 'S', cn: `${i}` }));
  it('keeps the better way up, with the margin to the first other name', () => {
    const up = [{ index: 0, score: 0.7 }, { index: 1, score: 0.69 }, { index: 2, score: 0.5 }];
    const down = [{ index: 3, score: 0.8 }, { index: 2, score: 0.6 }];
    const [r] = pairResults([up, down], prints);
    expect(r.turned).toBe(true);
    expect(r.candidates.map((c) => c.name)).toEqual(['C', 'B']);
    expect(r.margin).toBeCloseTo(0.2, 6);
    const [s] = pairResults([up, [{ index: 3, score: 0.6 }]], prints);
    expect(s.turned).toBe(false);
    expect(s.margin).toBeCloseTo(0.2, 6);
  });
});
