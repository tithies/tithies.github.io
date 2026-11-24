import { clearChangeLogOf, markStaleOps, opCalls, startOp, writeLogger, getOp, listOps } from '@/lib/changes/log';
import { db } from '@/lib/db';
import { CancelledError, SiteClient, SiteError, SiteRateLimitError, SiteUnknownOutcomeError, SiteWrongAccountError, type SiteTransport, type WriteLogger, type WriteOutcome } from '@/lib/sites/client';
import { runMoxRequest } from '@/lib/sites/moxfield/api';
import { MOX_PACING } from '@/lib/sites/moxfield/constants';
import { MOX_CSV_HEADER, toMoxCsv } from '@/lib/sites/moxfield/csv';
import { binderFromAnswer, buildMoxMutation, describeMoxMutation, MAX_BULK_REMOVE, normalizeBinderList } from '@/lib/sites/moxfield/mutations';
import { MoxPageSession } from '@/lib/sites/moxfield/page-api';
import { moxfieldSite } from '@/lib/sites/moxfield/provider';
import { TabTransport } from '@/lib/sites/tab-transport';
import { siteFail, type DescribedRequest, type SiteMutation, type SiteRequest, type SiteResult } from '@/lib/sites/types';
import { ALICE, BOB, FakeTabs } from './fake-tabs';
import { bearer, resetDb } from './helpers';

const CSV = toMoxCsv([{ qty: 2, name: 'Sol Ring', set: 'C21', cn: '263', finish: 'foil' }]);
const IMPORT: SiteMutation = { site: 'moxfield', op: 'importCsv', csv: CSV, binderId: 'Bnd_1' };
const REMOVE: SiteMutation = { site: 'moxfield', op: 'bulkRemove', entryIds: ['a1', 'b2'] };

describe('Moxfield CSV', () => {
  it('writes the exact layout of Moxfield’s own export', () => {
    expect(MOX_CSV_HEADER).toBe(
      '"Count","Tradelist Count","Name","Edition","Condition","Language","Foil","Tags","Last Modified","Collector Number","Alter","Proxy","Purchase Price"',
    );
    const csv = toMoxCsv([
      { qty: 1, name: 'Abdel Adrian, Gorion\'s Ward', set: 'CLB', cn: '471', finish: 'etched' },
      { qty: 3, name: 'Aquatic Alchemist // Bubble Up', set: 'woe', cn: '40', finish: 'nonFoil' },
      { qty: 1, name: '"Ach! Hans, Run!"', set: 'unh', cn: '116', finish: 'foil', isProxy: true },
      { qty: 1, name: 'Alhammarret\'s Archive', set: 'plst', cn: 'ORI-221', finish: 'nonFoil' },
    ]);
    expect(csv.split('\n')).toEqual([
      MOX_CSV_HEADER,
      '"1","1","Abdel Adrian, Gorion\'s Ward","clb","Near Mint","English","etched","","","471","False","False",""',
      '"3","3","Aquatic Alchemist // Bubble Up","woe","Near Mint","English","","","","40","False","False",""',
      '"1","1","""Ach! Hans, Run!""","unh","Near Mint","English","foil","","","116","False","True",""',
      '"1","1","Alhammarret\'s Archive","plst","Near Mint","English","","","","ORI-221","False","False",""',
      '',
    ]);
    expect(() => toMoxCsv([{ qty: 0, name: 'x', set: 'a', cn: '1', finish: 'foil' }])).toThrow();
  });
});

describe('Moxfield writes: validation and requests', () => {
  it('builds each write Tithies makes, and nothing else', () => {
    expect(buildMoxMutation({ site: 'moxfield', op: 'createBinder', name: ' To buy ', visibility: 'private' })).toEqual({
      method: 'POST',
      url: 'https://api2.moxfield.com/v1/trade-binders',
      json: { name: 'To buy', description: '', visibility: 'private' },
    });
    expect(buildMoxMutation(REMOVE)).toEqual({ method: 'POST', url: 'https://api2.moxfield.com/v1/collections/bulk/remove', json: { collectionCardIds: ['a1', 'b2'] } });
    expect(buildMoxMutation({ site: 'moxfield', op: 'deleteCollection' })).toEqual({ method: 'DELETE', url: 'https://api2.moxfield.com/v1/collections' });
    const imp = buildMoxMutation(IMPORT)!;
    expect(imp.url).toBe(
      'https://api2.moxfield.com/v1/collections/import-file?game=paper&defaultCondition=nearMint&defaultCardLanguageId=LD58x&defaultQuantity=1&pricingProvider=tcgplayer&format=moxfield&tradeBinderId=Bnd_1',
    );
    expect(imp.file).toMatchObject({ field: 'file', text: CSV });
    expect(buildMoxMutation({ ...IMPORT, binderId: undefined })!.url).not.toContain('tradeBinderId');
  });

  it("adds one card by its card id with Moxfield's own body", () => {
    const add = { site: 'moxfield', op: 'addCard', cardId: '1MR1a', quantity: 2, finish: 'nonFoil', languageId: 'kAVXO', binderId: 'Bnd_1' } as const;
    expect(buildMoxMutation(add)).toEqual({
      method: 'POST',
      url: 'https://api2.moxfield.com/v1/collections',
      json: { cardId: '1MR1a', quantity: 2, condition: 'nearMint', game: 'paper', cardLanguageId: 'kAVXO', finish: 'nonFoil', isAlter: false, isProxy: false, tradeBinderId: 'Bnd_1' },
    });
    expect((buildMoxMutation({ ...add, binderId: undefined })!.json as object)).not.toHaveProperty('tradeBinderId');
    for (const bad of [{ cardId: 'x y' }, { quantity: 0 }, { quantity: 1.5 }, { quantity: 10_001 }, { finish: 'gold' }, { languageId: 'fr' }, { binderId: '../x' }]) {
      expect(buildMoxMutation({ ...add, ...bad })).toBeNull();
    }
  });

  it('refuses anything malformed (the page world is not trusted)', () => {
    const bad: unknown[] = [
      null,
      'x',
      { site: 'other', op: 'deleteCollection' },
      { site: 'moxfield', op: 'dropDatabase' },
      { site: 'moxfield', op: 'createBinder', name: '', visibility: 'private' },
      { site: 'moxfield', op: 'createBinder', name: 'x', visibility: 'friends' },
      { site: 'moxfield', op: 'createBinder', name: 'x'.repeat(101), visibility: 'public' },
      { site: 'moxfield', op: 'bulkRemove', entryIds: [] },
      { site: 'moxfield', op: 'bulkRemove', entryIds: ['../../v1/users'] },
      { site: 'moxfield', op: 'bulkRemove', entryIds: Array.from({ length: MAX_BULK_REMOVE + 1 }, (_, i) => `e${i}`) },
      { site: 'moxfield', op: 'importCsv', csv: 'Count,Name\n1,Sol Ring' },
      { site: 'moxfield', op: 'importCsv', csv: CSV, binderId: 'a/b' },
    ];
    for (const m of bad) expect(buildMoxMutation(m)).toBeNull();
  });

  it('describes a write for the change log exactly as it is sent', () => {
    expect(describeMoxMutation(REMOVE)).toEqual({ method: 'POST', url: 'https://api2.moxfield.com/v1/collections/bulk/remove', body: JSON.stringify({ collectionCardIds: ['a1', 'b2'] }, null, 2) });
    expect(describeMoxMutation(IMPORT)!.body).toBe(CSV);
    expect(moxfieldSite.describeMutation({ site: 'moxfield', op: 'deleteCollection' })).toEqual({ method: 'DELETE', url: 'https://api2.moxfield.com/v1/collections', body: '' });
  });

  it('reads binders from the shapes Moxfield may answer', () => {
    expect(binderFromAnswer({ id: 'b1', publicId: 'pub1', name: 'Trade', visibility: 'public' })).toEqual({ id: 'b1', publicId: 'pub1', name: 'Trade', visibility: 'public' });
    expect(binderFromAnswer({ tradeBinder: { id: 'b2', name: 'X' } })).toEqual({ id: 'b2', publicId: 'b2', name: 'X', visibility: '' });
    expect(binderFromAnswer({ name: 'no id' })).toBeNull();
    expect(normalizeBinderList([{ id: 'b1', name: 'A' }, { id: 'b1', name: 'dup' }, { nope: 1 }])).toHaveLength(1);
    expect(normalizeBinderList({ data: [{ id: 'b3', name: 'C' }] })[0].id).toBe('b3');
    expect(normalizeBinderList('junk')).toEqual([]);
  });
});

describe('Moxfield writes in the page', () => {
  const answer = (status: number, body = '{}') => new Response(body, { status });

  it('sends JSON bodies with their type, and the CSV as a multipart file', async () => {
    const seen: { url: string; init?: { method: string; body?: unknown; contentType?: string } }[] = [];
    const doFetch = async (url: string, init?: { method: string; body?: string | FormData; contentType?: string }) => {
      seen.push({ url, init });
      return answer(200, 'imported');
    };
    expect(await runMoxRequest({ kind: 'mutate', op: REMOVE }, doFetch)).toEqual({ ok: true, kind: 'mutate', status: 200, response: 'imported' });
    expect(seen[0].init).toEqual({ method: 'POST', body: JSON.stringify({ collectionCardIds: ['a1', 'b2'] }), contentType: 'application/json' });
    await runMoxRequest({ kind: 'mutate', op: IMPORT }, doFetch);
    const form = seen[1].init!.body as FormData;
    expect(seen[1].init!.contentType).toBeUndefined();
    const file = form.get('file') as File;
    expect(file.name).toBe('tithies-export.csv');
    expect(await file.text()).toBe(CSV);
  });

  it('reports refusals with the start of the answer, and never sends a malformed write', async () => {
    const doFetch = vi.fn(async () => answer(500, 'x'.repeat(40_000)));
    const res = await runMoxRequest({ kind: 'mutate', op: REMOVE }, doFetch);
    expect(res).toMatchObject({ ok: false, status: 500, code: 'http' });
    expect((res as { response: string }).response.length).toBeLessThan(33_000);
    expect(await runMoxRequest({ kind: 'mutate', op: { site: 'moxfield', op: 'bulkRemove', entryIds: [] } as never }, doFetch)).toMatchObject({ ok: false, code: 'bad_request' });
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(await runMoxRequest({ kind: 'mutate', op: REMOVE }, async () => answer(401))).toMatchObject({ ok: false, code: 'no_auth' });
    expect(await runMoxRequest({ kind: 'mutate', op: REMOVE }, async () => Promise.reject(new Error('offline')))).toMatchObject({ ok: false, code: 'network' });
  });

  it('a created binder comes back with its ids; an unreadable answer is not a success', async () => {
    const op: SiteMutation = { site: 'moxfield', op: 'createBinder', name: 'To buy', visibility: 'private' };
    expect(await runMoxRequest({ kind: 'mutate', op }, async () => answer(200, '{"id":"b9","publicId":"pb9","name":"To buy","visibility":"private"}'))).toMatchObject({
      ok: true,
      binder: { id: 'b9', publicId: 'pb9' },
    });
    expect(await runMoxRequest({ kind: 'mutate', op }, async () => answer(200, 'ok'))).toMatchObject({ ok: false, code: 'parse' });
  });

  it('the page session refuses a write for another account before sending anything', async () => {
    const session = new MoxPageSession();
    session.noteRequest({ authorization: bearer(ALICE.userId, ALICE.userName) });
    const doFetch = vi.fn(async () => answer(200));
    expect(await session.api({ req: { kind: 'mutate', op: REMOVE }, expect: BOB.userId }, doFetch)).toMatchObject({ ok: false, code: 'wrong_account' });
    expect(doFetch).not.toHaveBeenCalled();
    const res = await session.api({ req: { kind: 'mutate', op: REMOVE }, expect: ALICE.userId }, doFetch);
    expect(res).toMatchObject({ ok: true, as: ALICE });
    const [, headers, init] = doFetch.mock.calls[0] as unknown as [string, Record<string, string>, { method: string }];
    expect(headers.authorization).toMatch(/^Bearer /);
    expect(init.method).toBe('POST');
    // The token never comes back with the answer.
    expect(JSON.stringify(res)).not.toContain('Bearer');
  });
});

/** Logger that keeps what it is told. */
function memoryLog() {
  const begun: DescribedRequest[] = [];
  const ended: WriteOutcome[] = [];
  const log: WriteLogger = {
    begin: async (r) => begun.push(r),
    end: async (_h, o) => void ended.push(o),
  };
  return { log, begun, ended };
}

function scripted(answers: (SiteResult | Error)[]) {
  const calls: SiteRequest[] = [];
  const transport: SiteTransport = async (req) => {
    calls.push(req);
    const a = answers.shift() ?? { ok: true, kind: 'mutate', status: 200, response: '', as: ALICE };
    if (a instanceof Error) throw a;
    return a;
  };
  return { calls, transport };
}

const client = (transport: SiteTransport, extra: object = {}) =>
  new SiteClient(transport, {
    label: 'Moxfield',
    ...MOX_PACING,
    intervalMs: 0,
    jitterMs: 0,
    sleep: async () => {},
    describeMutation: moxfieldSite.describeMutation,
    expectedUserId: () => ALICE.userId,
    ...extra,
  });

describe('SiteClient.mutate', () => {
  it('logs every write before sending it, then its outcome', async () => {
    const { transport, calls } = scripted([]);
    const m = memoryLog();
    expect(await client(transport).mutate(REMOVE, m.log)).toMatchObject({ ok: true, kind: 'mutate' });
    expect(calls).toEqual([{ kind: 'mutate', op: REMOVE }]);
    expect(m.begun).toEqual([describeMoxMutation(REMOVE)]);
    expect(m.ended).toMatchObject([{ outcome: 'ok', status: 200, as: ALICE }]);
    expect(() => client(transport).mutate(REMOVE, undefined as never)).toThrow(/logged/);
    expect(() => client(transport, { describeMutation: undefined }).mutate(REMOVE, m.log)).toThrow(SiteError);
  });

  it('never sends a write again when its outcome is unknown', async () => {
    for (const fail of [siteFail(500, 'http', 'HTTP 500', ALICE), siteFail(0, 'timeout', 'slow', null), siteFail(0, 'tab_lost', 'lost', null), new Error('boom')]) {
      const { transport, calls } = scripted([fail]);
      const m = memoryLog();
      await expect(client(transport).mutate(REMOVE, m.log)).rejects.toBeInstanceOf(SiteUnknownOutcomeError);
      expect(calls).toHaveLength(1);
      expect(m.ended).toMatchObject([{ outcome: 'unknown' }]);
    }
  });

  it('sends it again after HTTP 429 (refused, so not made), each try logged', async () => {
    const { transport, calls } = scripted([siteFail(429, 'http', 'HTTP 429', ALICE)]);
    const m = memoryLog();
    await client(transport, { rateLimitWaitsMs: [10] }).mutate(REMOVE, m.log);
    expect(calls).toHaveLength(2);
    expect(m.ended.map((e) => e.outcome)).toEqual(['failed', 'ok']);
    const again = scripted([siteFail(429, 'http', 'HTTP 429', ALICE), siteFail(429, 'http', 'HTTP 429', ALICE)]);
    await expect(client(again.transport, { rateLimitWaitsMs: [10] }).mutate(REMOVE, memoryLog().log)).rejects.toBeInstanceOf(SiteRateLimitError);
  });

  it('refusals are logged as failed and stop; wrong account is never retried', async () => {
    const { transport } = scripted([siteFail(0, 'wrong_account', 'logged in as bob', BOB)]);
    const m = memoryLog();
    await expect(client(transport).mutate(REMOVE, m.log)).rejects.toBeInstanceOf(SiteWrongAccountError);
    expect(m.ended).toMatchObject([{ outcome: 'failed' }]);
    const bad = scripted([siteFail(400, 'http', 'HTTP 400', ALICE)]);
    await expect(client(bad.transport).mutate(REMOVE, memoryLog().log)).rejects.toMatchObject({ status: 400 });
  });

  it('a cancel while sending leaves an unknown outcome', async () => {
    const { transport } = scripted([new CancelledError()]);
    const m = memoryLog();
    await expect(client(transport).mutate(REMOVE, m.log)).rejects.toBeInstanceOf(CancelledError);
    expect(m.ended).toMatchObject([{ outcome: 'unknown' }]);
  });
});

describe('Tab transport and writes', () => {
  const SITE = { label: 'Moxfield', tabPatterns: ['https://moxfield.com/*'], syncTabUrl: 'https://moxfield.com/decks/personal' };
  const opts = { authWaitMs: 50, pollMs: 5, reloadSettleMs: 0, expect: ALICE };

  it('does not send a write again in another tab when its tab is lost (a read is retried)', async () => {
    for (const kind of ['read', 'write'] as const) {
      const port = new FakeTabs();
      port.tabs = [
        { id: 1, account: ALICE, active: true },
        { id: 2, account: ALICE },
      ];
      let first = true;
      port.onCall = () => {
        if (first) {
          first = false;
          throw new Error('tab closed');
        }
      };
      const t = new TabTransport(SITE, opts, port);
      const req: SiteRequest = kind === 'read' ? { kind: 'deckList' } : { kind: 'mutate', op: REMOVE };
      const res = await t.call(req);
      if (kind === 'read') expect(res).toMatchObject({ ok: true });
      else expect(res).toMatchObject({ ok: false, code: 'tab_lost' });
      expect(port.calls).toHaveLength(kind === 'read' ? 2 : 1);
    }
  });

  it('a write refused because the tab is someone else’s goes to a tab of the right account', async () => {
    const port = new FakeTabs();
    port.tabs = [{ id: 1, account: ALICE, active: true }];
    port.onCall = (_c, tab) => {
      if (tab.id === 1) {
        tab.account = BOB;
        port.tabs.push({ id: 2, account: ALICE });
      }
    };
    port.answer = () => ({ ok: true, kind: 'mutate', status: 200, response: '' });
    const t = new TabTransport(SITE, opts, port);
    expect(await t.call({ kind: 'mutate', op: REMOVE })).toMatchObject({ ok: true, as: ALICE });
    expect(port.calls.map((c) => c.tabId)).toEqual([1, 2]);
  });
});

describe('Change log', () => {
  beforeEach(resetDb);
  const op = (accountKey = 'moxfield:111111') =>
    startOp({ site: 'moxfield', accountKey: accountKey as never, userName: 'alice', kind: 'export', title: 'Export', source: 'test', details: {} });

  it('records each write in order, with its outcome', async () => {
    const id = await op();
    const log = writeLogger(id);
    const a = await log.begin({ method: 'POST', url: 'u1', body: 'b1' });
    const b = await log.begin({ method: 'DELETE', url: 'u2', body: '' });
    await log.end(a, { outcome: 'ok', status: 200, durationMs: 5, response: 'r' });
    await log.end(b, { outcome: 'unknown', status: 0, durationMs: 9, error: 'timeout' });
    expect((await opCalls(id)).map((c) => [c.seq, c.method, c.outcome])).toEqual([
      [1, 'POST', 'ok'],
      [2, 'DELETE', 'unknown'],
    ]);
    expect(await getOp(id)).toMatchObject({ status: 'running', calls: 2, unknownCalls: 1 });
  });

  it('an action left running by a dead worker becomes interrupted; its unanswered writes unknown', async () => {
    const id = await op();
    await writeLogger(id).begin({ method: 'POST', url: 'u', body: '' });
    await markStaleOps();
    expect(await getOp(id)).toMatchObject({ status: 'interrupted', unknownCalls: 1 });
    expect((await opCalls(id))[0].outcome).toBe('unknown');
  });

  it('forgetting an account deletes the log of its changes only', async () => {
    const mine = await op('moxfield:111111');
    const theirs = await op('moxfield:222222');
    await writeLogger(mine).begin({ method: 'POST', url: 'u', body: '' });
    await writeLogger(theirs).begin({ method: 'POST', url: 'u', body: '' });
    await clearChangeLogOf('moxfield:111111' as never);
    expect((await listOps()).map((o) => o.id)).toEqual([theirs]);
    expect(await db.changeCalls.count()).toBe(1);
  });
});

describe('Moxfield import answer (verified 2026-11-16)', () => {
  it('reads what the import says it did', async () => {
    const res = await runMoxRequest({ kind: 'mutate', op: IMPORT }, async () => new Response('{"isSuccessful":true,"totalImportedCount":57,"errors":[]}', { status: 200 }));
    expect(res).toMatchObject({ ok: true, imported: { ok: true, count: 57, errors: [] } });
    const bad = await runMoxRequest({ kind: 'mutate', op: IMPORT }, async () => new Response('{"isSuccessful":false,"totalImportedCount":1,"errors":["Line 3: card not found", {"line":4}]}', { status: 200 }));
    expect(bad).toMatchObject({ ok: true, imported: { ok: false, count: 1, errors: ['Line 3: card not found', '{"line":4}'] } });
    const odd = await runMoxRequest({ kind: 'mutate', op: IMPORT }, async () => new Response('done', { status: 200 }));
    expect(odd).toEqual({ ok: true, kind: 'mutate', status: 200, response: 'done' });
  });
});

describe('Moxfield binder search (reads)', () => {
  it("reads one binder's cards with Moxfield's own binder search", async () => {
    const { requestUrl } = await import('@/lib/sites/moxfield/api');
    expect(requestUrl({ kind: 'binderPage', publicId: '8Dr6F5OcBkCMs1E-WbFdFw', pageNumber: 2, pageSize: 100 })).toBe(
      'https://api2.moxfield.com/v1/trade-binders/8Dr6F5OcBkCMs1E-WbFdFw/search?pageNumber=2&pageSize=100&sortType=cardName&sortDirection=ascending&pricingProvider=tcgplayer',
    );
    expect(requestUrl({ kind: 'binderPage', publicId: '../v1/users', pageNumber: 1, pageSize: 100 })).toBeNull();
    const body = {
      tradeBinder: { id: 'DOQNN', publicId: '8Dr6F5OcBkCMs1E-WbFdFw', name: 'X' },
      totalResults: 1,
      totalPages: 1,
      pageSize: 100,
      totalOverall: 2,
      data: [{ id: 'e1', quantity: 2, finish: 'nonFoil', card: { id: 'c1', name: 'Sol Ring', set: 'c21', cn: '263' } }],
    };
    const res = await runMoxRequest({ kind: 'binderPage', publicId: '8Dr6F5OcBkCMs1E-WbFdFw', pageNumber: 1, pageSize: 100 }, async () => new Response(JSON.stringify(body), { status: 200 }));
    expect(res).toMatchObject({ ok: true, kind: 'binderPage', totalCopies: 2, entries: [{ id: 'e1', binderId: 'DOQNN', qty: 2 }] });
  });
});

describe('Moxfield deck writes', () => {
  const answer = (status: number, body = '{}') => new Response(body, { status });
  const IMPORT_DECK: SiteMutation = { site: 'moxfield', op: 'importDeck', deckId: 'dk1', publicId: 'pubDeck_22charsXXXXXX', version: 7, importText: '1 Sol Ring (C21) 263' };

  it("builds Moxfield's own folder, deck, import and add requests, with the deck's id and version as headers", () => {
    expect(buildMoxMutation({ site: 'moxfield', op: 'createDeckFolder', name: ' Collection / By set ' })).toEqual({
      method: 'POST',
      url: 'https://api2.moxfield.com/v1/deck-folders',
      json: { name: 'Collection/By set' },
    });
    expect(buildMoxMutation({ site: 'moxfield', op: 'createDeck', name: ' Final Fantasy - Rare ', visibility: 'private', folderId: 'rng9V', importText: '2 Cloud (FIN) 1 *F*' })).toEqual({
      method: 'POST',
      url: 'https://api2.moxfield.com/v3/decks',
      json: { name: 'Final Fantasy - Rare', format: 'none', visibility: 'private', importText: '2 Cloud (FIN) 1 *F*', pricingProvider: 'tcgplayer', usePrefPrintings: false, deckFolderId: 'rng9V' },
    });
    expect(buildMoxMutation(IMPORT_DECK)).toEqual({
      method: 'POST',
      url: 'https://api2.moxfield.com/v3/decks/dk1/import',
      headers: { 'x-public-deck-id': 'pubDeck_22charsXXXXXX', 'x-deck-version': '7' },
      json: { importText: '1 Sol Ring (C21) 263', replaceAll: false, pricingProvider: 'tcgplayer', usePrefPrintings: false },
    });
    expect(buildMoxMutation({ site: 'moxfield', op: 'addDeckCard', deckId: 'dk1', publicId: 'pubDeck', version: 8, cardId: 'Yl7l6', quantity: 3, finish: 'foil' })).toEqual({
      method: 'POST',
      url: 'https://api2.moxfield.com/v2/decks/dk1/cards/mainboard',
      headers: { 'x-public-deck-id': 'pubDeck', 'x-deck-version': '8' },
      json: { cardId: 'Yl7l6', quantity: 3, finish: 'foil', usePrefPrinting: false },
    });
    // The change log shows the headers too.
    expect(describeMoxMutation(IMPORT_DECK)).toMatchObject({ headers: { 'x-deck-version': '7' } });
  });

  it('refuses malformed deck writes', () => {
    const bad: unknown[] = [
      { site: 'moxfield', op: 'createDeckFolder', name: 'Final Fantasy: Rare' },
      { site: 'moxfield', op: 'createDeckFolder', name: 'A//B' },
      { site: 'moxfield', op: 'createDeckFolder', name: '  ' },
      { site: 'moxfield', op: 'createDeck', name: '', visibility: 'private', importText: '' },
      { site: 'moxfield', op: 'createDeck', name: 'x', visibility: 'secret', importText: '' },
      { site: 'moxfield', op: 'createDeck', name: 'x\ny', visibility: 'private', importText: '' },
      { site: 'moxfield', op: 'createDeck', name: 'x', visibility: 'private', importText: 'x'.repeat(300_000) },
      { site: 'moxfield', op: 'createDeck', name: 'x', visibility: 'private', importText: '', folderId: '../x' },
      { ...IMPORT_DECK, version: -1 },
      { ...IMPORT_DECK, version: '7' },
      { ...IMPORT_DECK, deckId: 'a/b' },
      { site: 'moxfield', op: 'addDeckCard', deckId: 'dk1', publicId: 'p', version: 1, cardId: 'c', quantity: 100, finish: 'foil' },
      { site: 'moxfield', op: 'addDeckCard', deckId: 'dk1', publicId: 'p', version: 1, cardId: 'c', quantity: 1, finish: 'gold' },
    ];
    for (const b of bad) expect(buildMoxMutation(b)).toBeNull();
  });

  it('sends the deck headers over the session’s, and reads what each answer says about the folder or deck', async () => {
    const seen: { url: string; init?: { headers?: Record<string, string> } }[] = [];
    const reply = (body: string) => async (url: string, init?: { method: string; headers?: Record<string, string> }) => (seen.push({ url, init }), answer(200, body));
    expect(await runMoxRequest({ kind: 'mutate', op: IMPORT_DECK }, reply('{"id":"dk1","publicId":"pubDeck_22charsXXXXXX","version":8}'))).toMatchObject({
      ok: true,
      deck: { id: 'dk1', version: 8 },
    });
    expect(seen[0].init?.headers).toEqual({ 'x-public-deck-id': 'pubDeck_22charsXXXXXX', 'x-deck-version': '7' });
    expect(
      await runMoxRequest({ kind: 'mutate', op: { site: 'moxfield', op: 'createDeckFolder', name: 'By set' } }, reply('{"id":"rng9V","name":"By set"}')),
    ).toMatchObject({ ok: true, folder: { id: 'rng9V', path: 'By set' } });
    const create: SiteMutation = { site: 'moxfield', op: 'createDeck', name: 'D', visibility: 'private', importText: '' };
    expect(await runMoxRequest({ kind: 'mutate', op: create }, reply('{"isSuccessful":true,"publicId":"newDeckPublicId","errors":[]}'))).toMatchObject({
      ok: true,
      deck: { publicId: 'newDeckPublicId' },
    });
    // No deck said: not a success (its outcome is unknown). The site saying it failed: a failure.
    expect(await runMoxRequest({ kind: 'mutate', op: create }, reply('{}'))).toMatchObject({ ok: false, code: 'parse' });
    expect(await runMoxRequest({ kind: 'mutate', op: create }, reply('{"isSuccessful":false,"errors":["Name taken"]}'))).toMatchObject({ ok: false, message: expect.stringContaining('Name taken') });
    // An added card's answer has no deck: its version comes from the header, as Moxfield's app reads it.
    const add: SiteMutation = { site: 'moxfield', op: 'addDeckCard', deckId: 'dk1', publicId: 'p', version: 1, cardId: 'c', quantity: 1, finish: 'nonFoil' };
    expect(await runMoxRequest({ kind: 'mutate', op: add }, async () => new Response('{"card":{}}', { status: 200, headers: { 'x-deck-version': '2' } }))).toMatchObject({ ok: true, deck: { version: 2 } });
    expect(await runMoxRequest({ kind: 'mutate', op: add }, reply('{"card":{}}'))).toMatchObject({ ok: true, deck: {} });
    // An import's row errors are kept.
    expect(await runMoxRequest({ kind: 'mutate', op: IMPORT_DECK }, reply('{"isSuccessful":true,"errors":["Unknown card"]}'))).toMatchObject({ imported: { errors: ['Unknown card'] } });
  });

  it('never replays a deck change’s own headers from the page’s requests', async () => {
    const session = new MoxPageSession();
    session.noteRequest({ authorization: bearer(ALICE.userId, ALICE.userName), 'x-public-deck-id': 'other', 'x-deck-version': '3', 'x-moxfield-version': '1' });
    const doFetch = vi.fn(async () => answer(200));
    await session.api({ req: { kind: 'mutate', op: REMOVE } }, doFetch);
    const [, headers] = doFetch.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(headers['x-public-deck-id']).toBeUndefined();
    expect(headers['x-deck-version']).toBeUndefined();
    expect(headers['x-moxfield-version']).toBe('1');
  });
});
