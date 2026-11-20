import { ownedPrints } from '@/features/scanner/reference';
import { buildIndex } from '@/features/scanner/search-index';
import { addNoBack, clearScannerData, currentRefIds, dropOtherTuned, labelDrafts, labelsDownloadedAt, markLabelsDownloaded, MODEL_KEY, noBackIds, rowKey, saveLabelDraft, scannerDb, tunedModelKey, type RefRow } from '@/features/scanner/store';

const row = (v: Partial<RefRow>): RefRow => ({ scryfallId: '', modelKey: MODEL_KEY, name: 'X', set: 's', setName: 'S', cn: '1', vectors: {}, phash: new Uint32Array(2), addedAt: 1, ...v });

describe('scanner reference store', () => {
  beforeEach(async () => {
    await scannerDb.refs.clear();
    await scannerDb.meta.clear();
    await scannerDb.labels.clear();
  });

  it('keys rows by model and face, keeping the first model’s plain ids', () => {
    expect(rowKey(MODEL_KEY, 'abc', false)).toBe('abc');
    expect(rowKey(MODEL_KEY, 'abc', true)).toBe('abc~back');
    const tuned = tunedModelKey(new Uint8Array([1, 2, 3]).buffer);
    expect(rowKey(tuned, 'abc', true)).toBe(`${tuned}#abc~back`);
    expect(tunedModelKey(new Uint8Array([1, 2, 4]).buffer)).not.toBe(tuned);
  });

  it('lists each model’s rows apart, and indexes back faces under their print', async () => {
    const tuned = tunedModelKey(new Uint8Array(10).buffer);
    await scannerDb.refs.bulkPut([
      row({ scryfallId: 'p1' }),
      row({ scryfallId: 'p1~back', printId: 'p1', back: true, name: 'A // B' }),
      row({ scryfallId: `${tuned}#p1`, printId: 'p1', modelKey: tuned }),
    ]);
    expect([...(await currentRefIds())].sort()).toEqual(['p1', 'p1~back']);
    expect([...(await currentRefIds(tuned))]).toEqual([`${tuned}#p1`]);
    const index = buildIndex(await scannerDb.refs.where('modelKey').equals(MODEL_KEY).toArray());
    expect(index.prints.map((p) => [p.scryfallId, !!p.back])).toEqual([
      ['p1', false],
      ['p1', true],
    ]);
  });

  it('drops the rows of older tuned models, not the current one’s nor DINOv2’s', async () => {
    const old = tunedModelKey(new Uint8Array(10).buffer);
    const cur = tunedModelKey(new Uint8Array(11).buffer);
    await scannerDb.refs.bulkPut([row({ scryfallId: 'p1' }), row({ scryfallId: `${old}#p1`, modelKey: old }), row({ scryfallId: `${cur}#p1`, modelKey: cur })]);
    expect(await dropOtherTuned(cur)).toBe(1);
    expect((await scannerDb.refs.toCollection().primaryKeys()).sort()).toEqual(['p1', `${cur}#p1`].sort());
  });

  it('remembers prints without a back picture', async () => {
    await addNoBack(['a', 'b']);
    await addNoBack(['b', 'c']);
    expect([...(await noBackIds())].sort()).toEqual(['a', 'b', 'c']);
  });

  it('keeps label drafts per photo, and Remove all data clears them', async () => {
    await saveLabelDraft('a.jpg', 10, { cards: [{ name: 'Opt', checked: true }] });
    await saveLabelDraft('a.jpg', 10, { cards: [{ name: 'Opt' }, { name: 'Island' }] });
    await markLabelsDownloaded(5);
    const drafts = await labelDrafts();
    expect(drafts.map((d) => [d.file, d.labels.cards.length])).toEqual([['a.jpg', 2]]);
    expect(await labelsDownloadedAt()).toBe(5);
    await clearScannerData();
    expect(await labelDrafts()).toEqual([]);
    expect(await labelsDownloadedAt()).toBe(0);
  });

  it('counts the faces of owned prints', () => {
    const entry = (id: string, faces: string[]) => ({ card: { scryfallId: id, name: faces.join(' // '), set: 's', setName: 'S', cn: '1', faces } }) as never;
    expect(ownedPrints([entry('a', ['A']), entry('b', ['B', 'C']), entry('b', ['B', 'C'])]).map((p) => [p.scryfallId, p.faces])).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
  });
});
