import type { CardMatch, MethodResult } from '@/features/scanner/pipeline';
import { cardFinish, cardLang, cardStatus, chosenPrint, defaultFinish, finishesOf, toExportItems } from '@/features/scanner/scan-export';
import { needsCheck, nextJob, shouldYield } from '@/features/scanner/scan-queue';
import { addSessionPhotos, clearScannerSession, measureScannerSession, removeSessionPhoto, saveSessionPhoto, sessionPhotos, updateSessionCard, type StoredCard, type StoredPhoto } from '@/features/scanner/scan-session';
import { scannerDb } from '@/features/scanner/store';

const quad = [
  { x: 0, y: 0 },
  { x: 63, y: 0 },
  { x: 63, y: 88 },
  { x: 0, y: 88 },
] as StoredCard['quad'];

/** An every-print index hit: same name and artwork groups decide the same-art candidates. */
const hit = (set: string, cn: string, score: number, more: Partial<CardMatch & { art: number; finishes: number }> = {}): CardMatch =>
  ({ scryfallId: `${set}-${cn}`, name: 'Grenzo, Havoc Raiser', set, setName: set.toUpperCase(), cn, lang: 'en', score, art: 1, finishes: 3, ...more }) as CardMatch;

const result = (hits: CardMatch[], margin = 0.2): MethodResult => ({ candidates: hits.slice(0, 5), more: hits, margin, turned: false });

const card = (n: number, v: Partial<StoredCard> = {}): StoredCard => ({ n, quad, heightPx: 900, source: 'model', crop: new Blob(['c'], { type: 'image/webp' }), result: result([hit('m3c', '213', 0.86), hit('tdc', '216', 0.83)]), ...v });

const photo = (id: string, addedAt: number, v: Partial<StoredPhoto> = {}): StoredPhoto => ({ id, name: `${id}.jpg`, size: 3, type: 'image/jpeg', blob: new Blob(['abc']), addedAt, width: 4000, height: 3000, status: 'named', cards: [], ...v });

describe('scanner session store', () => {
  beforeEach(() => clearScannerSession());

  it('keeps photos with their file and cut-outs, oldest first, and updates one card', async () => {
    const files = [new File(['one'], 'a.jpg', { type: 'image/jpeg' }), new File(['two!'], 'b.jpg', { type: 'image/jpeg' })];
    let k = 0;
    const added = await addSessionPhotos(files, 1000, () => `id${++k}`);
    expect(added.map((p) => [p.id, p.status, p.addedAt])).toEqual([
      ['id1', 'queued', 1000],
      ['id2', 'queued', 1001],
    ]);
    await saveSessionPhoto({ ...added[1], status: 'named', cards: [card(1), card(2)] });
    const saved = await updateSessionCard('id2', 2, (c) => ({ ...c, edit: { lang: 'fr' } }));
    expect(saved?.cards.map((c) => c.edit?.lang)).toEqual([undefined, 'fr']);
    expect(await updateSessionCard('gone', 1, (c) => c)).toBeNull();
    const all = await sessionPhotos();
    expect(all.map((p) => p.name)).toEqual(['a.jpg', 'b.jpg']);
    expect(await all[1].cards[0].crop.text()).toBe('c');
    expect(await all[0].blob.text()).toBe('one');
    expect(await measureScannerSession()).toMatchObject({ photos: 2, cards: 2 });
    await removeSessionPhoto('id1');
    expect((await sessionPhotos()).map((p) => p.id)).toEqual(['id2']);
    await clearScannerSession();
    expect(await scannerDb.scanPhotos.count()).toBe(0);
  });
});

describe('scanner job order', () => {
  it('names every waiting photo first, then checks photo by photo', () => {
    const checked = card(1, { check: { ms: 1, times: {} } });
    const photos = [photo('b', 2, { cards: [card(1), checked] }), photo('a', 1, { cards: [checked] }), photo('c', 3, { status: 'queued' })];
    expect(nextJob(photos, { check: true })).toEqual({ kind: 'name', photoId: 'c' });
    expect(shouldYield(photos)).toBe(true);
    const named = photos.map((p) => ({ ...p, status: 'named' as const }));
    expect(nextJob(named, { check: true })).toEqual({ kind: 'check', photoId: 'b', cards: [1] });
    expect(nextJob(named, { check: false })).toBeNull();
    expect(shouldYield(named)).toBe(false);
  });

  it('checks only listed cards not checked yet that have the index top 20', () => {
    expect(needsCheck(card(1))).toBe(true);
    expect(needsCheck(card(1, { edit: { removed: true } }))).toBe(false);
    expect(needsCheck(card(1, { result: { candidates: [hit('m3c', '213', 0.9)], margin: 0.2, turned: false } }))).toBe(false);
    expect(nextJob([photo('f', 1, { status: 'failed', cards: [card(1)] })], { check: true })).toBeNull();
  });
});

describe('scanned cards as a list', () => {
  it('takes the user’s print, else the check’s pick, else the search’s best', () => {
    const c = card(1);
    expect(chosenPrint(c)?.set).toBe('m3c');
    const checked = card(1, { check: { print: { pick: 1, how: 'read' }, ms: 1, times: {} } });
    expect(chosenPrint(checked)?.set).toBe('tdc');
    expect(chosenPrint({ ...checked, edit: { print: hit('otc', '168', 0.8) } })?.set).toBe('otc');
  });

  it('reads finishes from the index bitmask, non-foil first', () => {
    expect(finishesOf(hit('a', '1', 1, { finishes: 3 }))).toEqual(['nonFoil', 'foil']);
    expect(defaultFinish(hit('a', '1', 1, { finishes: 2 }))).toBe('foil');
    expect(defaultFinish(hit('a', '1', 1, { finishes: 4 }))).toBe('etched');
    expect(finishesOf(undefined)).toEqual(['nonFoil', 'foil', 'etched']);
    // A finish the chosen print doesn't exist in falls back to its default.
    expect(cardFinish(card(1, { edit: { finish: 'etched' } }))).toBe('nonFoil');
    expect(cardFinish(card(1, { edit: { finish: 'foil' } }))).toBe('foil');
  });

  it('takes the user’s language, else the one read, else English', () => {
    expect(cardLang(card(1))).toBe('en');
    expect(cardLang(card(1, { check: { language: { lang: 'ja', how: 'script' }, ms: 1, times: {} } }))).toBe('ja');
    expect(cardLang(card(1, { edit: { lang: 'fr' }, check: { language: { lang: 'ja', how: 'script' }, ms: 1, times: {} } }))).toBe('fr');
  });

  it('is sure when the name is sure and the print decided', () => {
    expect(cardStatus(card(1))).toBe('review');
    expect(cardStatus(card(1, { check: { print: { pick: 1, how: 'read' }, ms: 1, times: {} } }))).toBe('sure');
    expect(cardStatus(card(1, { check: { print: { pick: 0, how: 'unsure' }, ms: 1, times: {} } }))).toBe('review');
    expect(cardStatus(card(1, { result: result([hit('m3c', '213', 0.86), hit('otc', '168', 0.8, { art: 2 })]) }))).toBe('sure');
    expect(cardStatus(card(1, { result: result([hit('m3c', '213', 0.45)]) }))).toBe('review');
    expect(cardStatus(card(1, { result: result([hit('m3c', '213', 0.2)]) }))).toBe('unknown');
    expect(cardStatus(card(1, { edit: { lang: 'de' } }))).toBe('user');
  });

  it('exports listed cards not sent yet, one item each', () => {
    const photos = [
      photo('p1', 1, {
        cards: [
          card(1, { check: { print: { pick: 1, how: 'read' }, language: { lang: 'fr', how: 'words' }, ms: 1, times: {} } }),
          card(2, { edit: { removed: true } }),
          card(3, { sentAt: 5 }),
          card(4, { edit: { finish: 'foil' } }),
        ],
      }),
    ];
    expect(toExportItems(photos)).toEqual([
      { key: 'p1:1', cardId: '', scryfallId: 'tdc-216', name: 'Grenzo, Havoc Raiser', set: 'tdc', setName: 'TDC', cn: '216', finish: 'nonFoil', lang: 'fr', printLang: 'en', qty: 1, note: 'Scanned' },
      { key: 'p1:4', cardId: '', scryfallId: 'm3c-213', name: 'Grenzo, Havoc Raiser', set: 'm3c', setName: 'M3C', cn: '213', finish: 'foil', lang: 'en', printLang: 'en', qty: 1, note: 'Scanned' },
    ]);
  });
});
