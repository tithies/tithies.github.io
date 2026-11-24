import { colorLetters, parseSets, rootSet, scryfallCardFacts, scryfallSets, SETS_TTL_MS, type FetchFn } from '@/lib/cards/scryfall';
import { db } from '@/lib/db';
import { resetDb } from './helpers';

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

describe('Scryfall facts', () => {
  beforeEach(resetDb);

  it('follows parents to the set a set belongs to', () => {
    const sets = new Map(
      parseSets({
        data: [
          { code: 'FIN', name: 'Final Fantasy' },
          { code: 'fic', name: 'Final Fantasy Commander', parent_set_code: 'fin' },
          { code: 'trk', name: 'Star Trek' },
          { code: 'trc', name: 'Star Trek Commander', parent_set_code: 'trk' },
          { code: 'atrc', name: 'Star Trek Commander Art Series', parent_set_code: 'trc' },
          { code: 'orphan', name: 'Orphan', parent_set_code: 'gone' },
          { nope: true },
        ],
      }).map((s) => [s.code, s]),
    );
    expect(rootSet(sets, 'FIC')?.name).toBe('Final Fantasy');
    expect(rootSet(sets, 'atrc')?.code).toBe('trk');
    expect(rootSet(sets, 'orphan')?.code).toBe('orphan');
    expect(rootSet(sets, 'zzz')).toBeNull();
    expect(colorLetters(['G', 'W', 'w', 'X'])).toBe('WG');
  });

  it('asks 75 cards per request, one after another, and keeps set, rarity and color identity', async () => {
    const bodies: number[] = [];
    const fetchFn: FetchFn = async (_url, init) => {
      const ids = (JSON.parse(String(init?.body)) as { identifiers: { id: string }[] }).identifiers.map((x) => x.id);
      bodies.push(ids.length);
      return new Response(JSON.stringify({ data: ids.filter((x) => x !== id(3)).map((x) => ({ id: x, set: 'FIC', rarity: 'Rare', color_identity: ['R', 'W'] })) }));
    };
    const ids = Array.from({ length: 160 }, (_, i) => id(i));
    const progress: number[] = [];
    const facts = await scryfallCardFacts([...ids, 'not-an-id', ids[0]], { fetchFn, onProgress: (d) => progress.push(d) });
    expect(bodies).toEqual([75, 75, 10]);
    expect(progress).toEqual([1, 2, 3]);
    expect(facts.get(id(1))).toEqual({ set: 'fic', rarity: 'rare', colors: 'WR' });
    expect(facts.has(id(3))).toBe(false);
  });

  it('keeps the set list a day, and uses an older one when Scryfall is down', async () => {
    let calls = 0;
    const ok: FetchFn = async () => (calls++, new Response(JSON.stringify({ data: [{ code: 'fin', name: 'Final Fantasy' }] })));
    const down: FetchFn = async () => (calls++, new Response('', { status: 503 }));
    expect(await scryfallSets(ok, undefined, 1000)).toHaveLength(1);
    expect(await scryfallSets(down, undefined, 2000)).toHaveLength(1);
    expect(calls).toBe(1);
    expect(await scryfallSets(down, undefined, 1000 + SETS_TTL_MS + 1)).toHaveLength(1);
    expect(calls).toBe(2);
    await db.meta.delete('scryfallSets');
    await expect(scryfallSets(down)).rejects.toThrow(/Scryfall's set list/);
  });
});
