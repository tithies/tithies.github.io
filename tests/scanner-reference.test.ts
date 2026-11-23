import { describe, expect, it, vi } from 'vitest';
import { pictureStandIns, type PrintInfo } from '@/features/scanner/reference';

const print = (scryfallId: string, lang?: string): PrintInfo => ({ scryfallId, name: 'X', set: 'tmp', setName: 'Tempest', cn: scryfallId.slice(-2), lang });

/** A fake /cards/collection: cards by id, and English cards by set + number. */
function fakeScryfall(cards: { id: string; set: string; collector_number: string; lang: string; image_status: string }[]) {
  const calls: object[][] = [];
  const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const { identifiers } = JSON.parse(String(init?.body)) as { identifiers: { id?: string; set?: string; collector_number?: string }[] };
    calls.push(identifiers);
    const data = identifiers.flatMap((i) =>
      cards.filter((c) => (i.id ? c.id === i.id : c.set === i.set && c.collector_number === i.collector_number && c.lang === 'en')),
    );
    return new Response(JSON.stringify({ data }), { status: 200 });
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

describe('scanner reference pictures', () => {
  const signal = new AbortController().signal;

  it('uses the English print’s picture for a non-English print Scryfall only has a placeholder of', async () => {
    const { fetchFn, calls } = fakeScryfall([
      { id: 'ja-44', set: 'tmp', collector_number: '44', lang: 'ja', image_status: 'placeholder' },
      { id: 'en-44', set: 'tmp', collector_number: '44', lang: 'en', image_status: 'highres_scan' },
      { id: 'fr-45', set: 'tmp', collector_number: '45', lang: 'fr', image_status: 'lowres' },
    ]);
    const standIns = await pictureStandIns([print('ja-44', 'ja'), print('fr-45', 'fr'), print('en-46', 'en'), print('old-47')], signal, fetchFn);
    expect([...standIns]).toEqual([['ja-44', 'en-44']]);
    // English prints and prints without a language aren't looked up.
    expect(calls[0]).toEqual([{ id: 'ja-44' }, { id: 'fr-45' }]);
    expect(calls[1]).toEqual([{ set: 'tmp', collector_number: '44' }]);
  });

  it('asks nothing when every print is English, and asks 75 at a time', async () => {
    const none = fakeScryfall([]);
    expect((await pictureStandIns([print('a', 'en'), print('b')], signal, none.fetchFn)).size).toBe(0);
    expect(none.calls).toHaveLength(0);
    const many = fakeScryfall([]);
    await pictureStandIns(Array.from({ length: 80 }, (_, i) => print(`id-${i}`, 'de')), signal, many.fetchFn);
    expect(many.calls.map((c) => c.length)).toEqual([75, 5]);
  });

  it('goes on without stand-ins when Scryfall fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchFn = vi.fn(async () => new Response('busy', { status: 503 })) as unknown as typeof fetch;
    expect((await pictureStandIns([print('ja-44', 'ja')], signal, fetchFn)).size).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
