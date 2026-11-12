import { CancelledError, SiteAuthError, SiteClient, SiteError, SiteNotFoundError, SiteRateLimitError, SiteWrongAccountError, type SiteClientOptions, type SiteTransport } from '@/lib/sites/client';
import { MOX_PACING } from '@/lib/sites/moxfield/constants';
import { siteFail, type SiteRequest, type SiteResult } from '@/lib/sites/types';

/** Moxfield's real pacing, with the given overrides. */
const newClient = (transport: SiteTransport, opts: Partial<SiteClientOptions> = {}) => new SiteClient(transport, { label: 'Moxfield', ...MOX_PACING, ...opts });

/** Fake clock: sleeping just moves time forward, so tests run instantly. */
function fakeTime() {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleeps,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw new CancelledError();
      sleeps.push(Math.round(ms));
      now += ms;
    },
  };
}

const okList: SiteResult = { ok: true, kind: 'deckList', decks: [] };

function scripted(answers: SiteResult[]) {
  const calls: SiteRequest[] = [];
  const transport = async (req: SiteRequest) => {
    calls.push(req);
    return answers.shift() ?? okList;
  };
  return { calls, transport };
}

describe('SiteClient', () => {
  it('spaces requests out', async () => {
    const t = fakeTime();
    const { calls, transport } = scripted([]);
    const client = newClient(transport, { ...t, random: () => 0.5, intervalMs: 1000, jitterMs: 500 });
    await Promise.all([client.deckList(), client.deckList(), client.deckList()]);
    expect(calls).toHaveLength(3);
    // No wait before the first request, then interval + half the jitter.
    expect(t.sleeps).toEqual([1250, 1250]);
    expect(client.requests).toBe(3);
  });

  it('waits 30 s, 60 s, 120 s on HTTP 429, then gives up', async () => {
    const t = fakeTime();
    const r429 = siteFail(429, 'http', 'Moxfield answered HTTP 429');
    const waits: string[] = [];
    const { transport } = scripted([r429, r429, okList]);
    const client = newClient(transport, { ...t, random: () => 0, onWait: (m) => waits.push(m) });
    await client.deckList();
    expect(t.sleeps.filter((ms) => ms >= 30_000)).toEqual([30_000, 60_000]);
    expect(waits[0]).toMatch(/retrying in 30 s \(1\/3\)/);

    const stuck = scripted([r429, r429, r429, r429]);
    const t2 = fakeTime();
    const client2 = newClient(stuck.transport, { ...t2, random: () => 0 });
    await expect(client2.deckList()).rejects.toBeInstanceOf(SiteRateLimitError);
    expect(stuck.calls).toHaveLength(4);
    expect(t2.sleeps.filter((ms) => ms >= 30_000)).toEqual([30_000, 60_000, 120_000]);
  });

  it("names the site in its messages (provider label)", async () => {
    const t = fakeTime();
    const waits: string[] = [];
    const r429 = siteFail(429, 'http', 'HTTP 429');
    const client = new SiteClient(scripted([r429, r429]).transport, { ...MOX_PACING, label: 'Archidekt', rateLimitWaitsMs: [1], ...t, random: () => 0, onWait: (m) => waits.push(m) });
    await expect(client.deckList()).rejects.toThrow('Archidekt is rate limiting Tithies');
    expect(waits).toEqual(['Archidekt is rate limiting: retrying in 0 s (1/1)']);
  });

  it('maps auth and not-found answers to typed errors', async () => {
    const t = fakeTime();
    await expect(newClient(scripted([siteFail(401, 'no_auth', 'log in')]).transport, t).deckList()).rejects.toBeInstanceOf(SiteAuthError);
    await expect(newClient(scripted([siteFail(404, 'http', 'gone')]).transport, t).deck('abcdefgh')).rejects.toBeInstanceOf(SiteNotFoundError);
    const lost = newClient(scripted([siteFail(0, 'tab_lost', 'tab closed')]).transport, t).deckList();
    await expect(lost).rejects.toMatchObject({ code: 'tab_lost' });
  });

  it('retries network errors and 5xx a couple of times', async () => {
    const t = fakeTime();
    const flaky = scripted([siteFail(0, 'network', 'offline'), siteFail(502, 'http', 'bad gateway'), okList]);
    await newClient(flaky.transport, { ...t, random: () => 0 }).deckList();
    expect(flaky.calls).toHaveLength(3);
    expect(t.sleeps.filter((ms) => ms >= 5000)).toEqual([5000, 15_000]);

    const down = scripted([siteFail(503, 'http', 'down'), siteFail(503, 'http', 'down'), siteFail(503, 'http', 'down')]);
    await expect(newClient(down.transport, { ...fakeTime(), random: () => 0 }).deckList()).rejects.toBeInstanceOf(SiteError);
  });

  it('stops when cancelled', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(newClient(scripted([]).transport, { ...fakeTime(), signal: ac.signal }).deckList()).rejects.toBeInstanceOf(CancelledError);
  });
});

describe('SiteClient account checks', () => {
  const ALICE = { userId: '111111', userName: 'alice' };
  const BOB = { userId: '222222', userName: 'bob' };
  const expectAlice = { expectedUserId: () => ALICE.userId };

  it('accepts answers made as the expected account', async () => {
    const client = newClient(scripted([{ ok: true, kind: 'deckList', decks: [], as: ALICE }]).transport, { ...fakeTime(), ...expectAlice });
    expect(await client.deckList()).toEqual([]);
  });

  it('a 404 made as another account is a wrong account, not "deleted"', async () => {
    const client = newClient(scripted([siteFail(404, 'http', 'not found', BOB)]).transport, { ...fakeTime(), ...expectAlice });
    const err = await client.deck('abcdefgh').catch((e) => e);
    expect(err).toBeInstanceOf(SiteWrongAccountError);
    expect(err).not.toBeInstanceOf(SiteNotFoundError);
    expect(err.actual).toEqual(BOB);
  });

  it('a success made as someone else (or as nobody) is refused', async () => {
    const asBob = newClient(scripted([{ ok: true, kind: 'deckList', decks: [], as: BOB }]).transport, { ...fakeTime(), ...expectAlice });
    await expect(asBob.deckList()).rejects.toThrow('Moxfield answered as bob.');
    const asNobody = newClient(scripted([{ ok: true, kind: 'deckList', decks: [] }]).transport, { ...fakeTime(), ...expectAlice });
    await expect(asNobody.deckList()).rejects.toBeInstanceOf(SiteWrongAccountError);
  });

  it('wrong_account answers are never retried; "no session" stays an auth error', async () => {
    const wrong = scripted([siteFail(0, 'wrong_account', 'Moxfield is logged in as bob.', BOB)]);
    await expect(newClient(wrong.transport, { ...fakeTime(), ...expectAlice }).deckList()).rejects.toBeInstanceOf(SiteWrongAccountError);
    expect(wrong.calls).toHaveLength(1);
    const noSession = scripted([siteFail(0, 'no_auth', 'log in', null)]);
    await expect(newClient(noSession.transport, { ...fakeTime(), ...expectAlice }).deckList()).rejects.toBeInstanceOf(SiteAuthError);
  });
});
