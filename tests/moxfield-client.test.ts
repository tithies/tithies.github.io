import { moxFail, type MoxApiRequest, type MoxApiResult } from '@/lib/moxfield/api';
import { MoxAuthError, MoxCancelledError, MoxError, MoxfieldClient, MoxNotFoundError, MoxRateLimitError } from '@/lib/moxfield/client';

/** Fake clock: sleeping just moves time forward, so tests run instantly. */
function fakeTime() {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleeps,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw new MoxCancelledError();
      sleeps.push(Math.round(ms));
      now += ms;
    },
  };
}

const okList: MoxApiResult = { ok: true, kind: 'deckList', decks: [] };

function scripted(answers: MoxApiResult[]) {
  const calls: MoxApiRequest[] = [];
  const transport = async (req: MoxApiRequest) => {
    calls.push(req);
    return answers.shift() ?? okList;
  };
  return { calls, transport };
}

describe('MoxfieldClient', () => {
  it('spaces requests out', async () => {
    const t = fakeTime();
    const { calls, transport } = scripted([]);
    const client = new MoxfieldClient(transport, { ...t, random: () => 0.5, intervalMs: 1000, jitterMs: 500 });
    await Promise.all([client.deckList(), client.deckList(), client.deckList()]);
    expect(calls).toHaveLength(3);
    // No wait before the first request, then interval + half the jitter.
    expect(t.sleeps).toEqual([1250, 1250]);
    expect(client.requests).toBe(3);
  });

  it('waits 30 s, 60 s, 120 s on HTTP 429, then gives up', async () => {
    const t = fakeTime();
    const r429 = moxFail(429, 'http', 'Moxfield answered HTTP 429');
    const waits: string[] = [];
    const { transport } = scripted([r429, r429, okList]);
    const client = new MoxfieldClient(transport, { ...t, random: () => 0, onWait: (m) => waits.push(m) });
    await client.deckList();
    expect(t.sleeps.filter((ms) => ms >= 30_000)).toEqual([30_000, 60_000]);
    expect(waits[0]).toMatch(/retrying in 30 s \(1\/3\)/);

    const stuck = scripted([r429, r429, r429, r429]);
    const t2 = fakeTime();
    const client2 = new MoxfieldClient(stuck.transport, { ...t2, random: () => 0 });
    await expect(client2.deckList()).rejects.toBeInstanceOf(MoxRateLimitError);
    expect(stuck.calls).toHaveLength(4);
    expect(t2.sleeps.filter((ms) => ms >= 30_000)).toEqual([30_000, 60_000, 120_000]);
  });

  it('maps auth and not-found answers to typed errors', async () => {
    const t = fakeTime();
    await expect(new MoxfieldClient(scripted([moxFail(401, 'no_auth', 'log in')]).transport, t).deckList()).rejects.toBeInstanceOf(MoxAuthError);
    await expect(new MoxfieldClient(scripted([moxFail(404, 'http', 'gone')]).transport, t).deck('abcdefgh')).rejects.toBeInstanceOf(MoxNotFoundError);
    const lost = new MoxfieldClient(scripted([moxFail(0, 'tab_lost', 'tab closed')]).transport, t).deckList();
    await expect(lost).rejects.toMatchObject({ code: 'tab_lost' });
  });

  it('retries network errors and 5xx a couple of times', async () => {
    const t = fakeTime();
    const flaky = scripted([moxFail(0, 'network', 'offline'), moxFail(502, 'http', 'bad gateway'), okList]);
    await new MoxfieldClient(flaky.transport, { ...t, random: () => 0 }).deckList();
    expect(flaky.calls).toHaveLength(3);
    expect(t.sleeps.filter((ms) => ms >= 5000)).toEqual([5000, 15_000]);

    const down = scripted([moxFail(503, 'http', 'down'), moxFail(503, 'http', 'down'), moxFail(503, 'http', 'down')]);
    await expect(new MoxfieldClient(down.transport, { ...fakeTime(), random: () => 0 }).deckList()).rejects.toBeInstanceOf(MoxError);
  });

  it('stops when cancelled', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(new MoxfieldClient(scripted([]).transport, { ...fakeTime(), signal: ac.signal }).deckList()).rejects.toBeInstanceOf(MoxCancelledError);
  });
});
