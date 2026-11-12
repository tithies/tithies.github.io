import { identityFromAuthorization, identityFromToken, MOX_USER_ID_CLAIM, tokenFromStartup } from '@/lib/sites/moxfield/identity';
import { MoxPageSession, type SessionInfo } from '@/lib/sites/moxfield/page-api';
import { bearer, fakeJwt, fixture } from './helpers';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

const ALICE = { userId: '111111', userName: 'alice' };
const BOB = { userId: '222222', userName: 'bob' };

describe('Moxfield identity', () => {
  it('reads the account from the token claims', () => {
    expect(identityFromToken(fakeJwt('111111', 'alice'))).toEqual({ ...ALICE, expiresAt: 2_000_000_000_000 });
    expect(identityFromAuthorization(bearer('111111', 'alice'))).toMatchObject(ALICE);
    // Numeric claims and non-ASCII usernames.
    expect(identityFromToken(fakeJwt(333 as unknown as string, 'zoé'))).toMatchObject({ userId: '333', userName: 'zoé' });
  });

  it('gives null for anything it cannot read', () => {
    expect(identityFromAuthorization(undefined)).toBeNull();
    expect(identityFromAuthorization('Basic abc')).toBeNull();
    expect(identityFromAuthorization('Bearer not-a-jwt')).toBeNull();
    expect(identityFromToken(`${b64({})}.${b64({ sub: 'alice' })}.x`)).toBeNull(); // no user id claim
    expect(identityFromToken(`${b64({})}.${b64({ [MOX_USER_ID_CLAIM]: '1' })}.x`)).toBeNull(); // no username
    expect(identityFromToken('a.%%%.c')).toBeNull();
  });

  it('finds the fresh token in a startup answer', () => {
    const body = fixture<any>('moxfield-startup.json');
    expect(identityFromToken(tokenFromStartup(body))).toMatchObject(ALICE);
    expect(tokenFromStartup({ refresh: { access_token: 'nope' } })).toBeNull();
    expect(tokenFromStartup(null)).toBeNull();
  });
});

describe('Moxfield page session', () => {
  const okDeckList = () => new Response(JSON.stringify({ decks: [] }), { status: 200 });

  function setup() {
    const changes: SessionInfo[] = [];
    const session = new MoxPageSession((s) => changes.push(s), () => 1000);
    return { session, changes };
  }

  it('follows the newest token, and its account with it', () => {
    const { session, changes } = setup();
    expect(session.status('/')).toMatchObject({ hasAuth: false, identity: null });
    session.noteRequest({ authorization: bearer('111111', 'alice'), 'x-moxfield-version': '1', accept: 'json' });
    expect(session.status('/')).toMatchObject({ hasAuth: true, identity: ALICE });
    // Same account, refreshed token: no change reported.
    session.noteRequest({ authorization: `Bearer ${fakeJwt('111111', 'alice', { jti: 'second' })}` });
    expect(changes).toEqual([{ hasAuth: true, identity: ALICE }]);
    // Logged in as someone else in this tab.
    session.noteRequest({ authorization: bearer('222222', 'bob') });
    expect(session.info()).toEqual({ hasAuth: true, identity: BOB });
    expect(changes).toHaveLength(2);
    // Requests without a token (logged-out pages, the startup call) don't touch the session.
    session.noteRequest({ accept: 'json' });
    expect(session.info().identity).toEqual(BOB);
  });

  it('takes the token handed out by startup/authenticated, and drops the session when it is refused', () => {
    const { session } = setup();
    session.noteRequest({ authorization: bearer('222222', 'bob'), 'x-moxfield-version': '7' });
    session.noteStartup(200, fixture('moxfield-startup.json'));
    expect(session.info().identity).toEqual(ALICE);
    session.noteStartup(500, null); // server error: leave it
    expect(session.info().hasAuth).toBe(true);
    session.noteStartup(401, null);
    expect(session.info()).toEqual({ hasAuth: false, identity: null });
  });

  it('refuses a request for another account before fetching anything', async () => {
    const { session } = setup();
    session.noteRequest({ authorization: bearer('222222', 'bob') });
    const fetch = vi.fn(async () => okDeckList());
    const res = await session.api({ req: { kind: 'deckList' }, expect: ALICE.userId }, fetch);
    expect(res).toMatchObject({ ok: false, code: 'wrong_account', as: BOB });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses when it cannot tell whose session it is', async () => {
    const { session } = setup();
    session.noteRequest({ authorization: 'Bearer opaque-token' });
    const fetch = vi.fn(async () => okDeckList());
    expect(await session.api({ req: { kind: 'deckList' }, expect: ALICE.userId }, fetch)).toMatchObject({ ok: false, code: 'wrong_account', as: null });
    expect(fetch).not.toHaveBeenCalled();
    // Without account checks it still works (and says it doesn't know who answered).
    expect(await session.api({ req: { kind: 'deckList' } }, fetch)).toMatchObject({ ok: true, as: null });
  });

  it('says who every answer was made as, and forgets a refused token', async () => {
    const { session } = setup();
    expect(await session.api({ req: { kind: 'deckList' } }, async () => okDeckList())).toMatchObject({ ok: false, code: 'no_auth', as: null });
    session.noteRequest({ authorization: bearer('111111', 'alice') });
    const seen: Record<string, string>[] = [];
    const ok = await session.api({ req: { kind: 'deckList' }, expect: ALICE.userId }, async (_url, headers) => {
      seen.push(headers);
      return okDeckList();
    });
    expect(ok).toMatchObject({ ok: true, kind: 'deckList', as: ALICE });
    expect(seen[0].authorization).toBe(bearer('111111', 'alice'));
    const refused = await session.api({ req: { kind: 'deckList' } }, async () => new Response('', { status: 401 }));
    expect(refused).toMatchObject({ ok: false, code: 'no_auth', as: ALICE });
    expect(session.info().hasAuth).toBe(false);
  });

  it('a refused old token does not drop a newer session', async () => {
    const { session } = setup();
    session.noteRequest({ authorization: bearer('111111', 'alice') });
    let release!: () => void;
    const pending = session.api({ req: { kind: 'deckList' } }, () => new Promise<Response>((r) => (release = () => r(new Response('', { status: 401 })))));
    session.noteRequest({ authorization: bearer('222222', 'bob') }); // logged in again meanwhile
    release();
    await pending;
    expect(session.info()).toEqual({ hasAuth: true, identity: BOB });
  });

  it('the panel reads the collection as the account of the captured request', async () => {
    const { session } = setup();
    const page = fixture<{ data: unknown[] }>('moxfield-page.json');
    const url = 'https://api2.moxfield.com/v1/collections/search?q=%20&setId=abc&pageNumber=1&pageSize=50';
    expect(session.noteCollectionSearch(url, { authorization: bearer('111111', 'alice') })).toBe(true);
    expect(session.noteCollectionSearch('https://api2.moxfield.com/v1/trade-binders', {})).toBe(false);
    // The tab switches to another account after the capture.
    session.noteRequest({ authorization: bearer('222222', 'bob') });
    expect(session.captureInfo()).toMatchObject({ hasCapture: true, account: ALICE });
    const tokens: string[] = [];
    const res = await session.readCapture(
      { pageSize: 50, delayMs: 0 },
      async (_u, headers) => {
        tokens.push(headers.authorization);
        return new Response(JSON.stringify({ ...page, pageSize: 50, totalPages: 2, totalResults: 2 * page.data.length }), { status: 200 });
      },
      undefined,
      async () => {},
    );
    expect(res.account).toEqual(ALICE);
    expect(tokens).toEqual([bearer('111111', 'alice'), bearer('111111', 'alice')]);
    expect(res.entries.length).toBeGreaterThan(0);
  });
});
