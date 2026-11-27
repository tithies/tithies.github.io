import { ActionIcon, Alert, Badge, Button, Card, Group, Image, Kbd, Loader, Progress, SegmentedControl, Select, Stack, Switch, Text, Title, Tooltip } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconArrowRight, IconPhotoPlus, IconPlus, IconRefresh, IconTrash } from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCurrentAccount } from '@/lib/accounts/AccountProvider';
import { LANGUAGE_LABELS } from '@/lib/cards/languages';
import { useRecentExports } from '@/lib/export/client';
import { ExportDialog } from '@/lib/export/ui/ExportDialog';
import { ExportProgressModal, RecentExportsModal } from '@/lib/export/ui/ExportProgress';
import { siteOf } from '@/lib/sites/registry';
import type { Quad } from '../geometry';
import type { LabelCard } from '../labels';
import { checkPhoto, disposePhoto, loadPhoto, nameQuads, scanPhoto, ScanStopped } from '../pipeline';
import { ClosedError } from '../protocol';
import { CHECKED_METHOD, checkCard, type CardCheck } from '../scanner-check';
import { cardStatus, chosenPrint, listed, toExportItems } from '../scan-export';
import { nextJob, shouldYield, type ScanJob } from '../scan-queue';
import {
  addSessionPhotos,
  clearScannerSession,
  cropBlob,
  markSessionSent,
  putSessionCard,
  removeSessionPhoto,
  replaceSessionPhoto,
  saveSessionPhoto,
  sessionPhotos,
  updateSessionCard,
  type StoredCard,
  type StoredPhoto,
} from '../scan-session';
import { LabelEditor } from './LabelEditor';
import { ScanPrintPicker } from './ScanPrintPicker';
import { STATUS_COLOR, ScanTable } from './ScanTable';
import { useScanner } from './useScanner';

const mb = (b: number) => `${Math.max(1, Math.round(b / 1e6))} MB`;
/** The check's text lines are not kept. */
const withoutLines = ({ lines: _, ...rest }: CardCheck): Omit<CardCheck, 'lines'> => rest;
const sameQuad = (a: Quad, b: Quad) => a.every((p, i) => p.x === b[i].x && p.y === b[i].y);

/** Object URLs for Blobs, one per Blob, revoked when the page goes. */
function useBlobUrls(): (b: Blob) => string {
  const urls = useRef(new Map<Blob, string>());
  useEffect(() => {
    const map = urls.current;
    return () => {
      for (const u of map.values()) URL.revokeObjectURL(u);
      map.clear();
    };
  }, []);
  return useCallback((b: Blob) => {
    let u = urls.current.get(b);
    if (!u) urls.current.set(b, (u = URL.createObjectURL(b)));
    return u;
  }, []);
}

type RunningJob = ScanJob & { done: number; total: number };

/** How the scan takes its cards' print and language: read on each card, or every card in one language (nothing read). */
const CARDS_MODES = [
  { group: 'Read each card', items: [{ value: 'read', label: 'Read each card: print and language' }] },
  { group: 'All in one language: faster, nothing read', items: Object.entries(LANGUAGE_LABELS).map(([value, label]) => ({ value, label: `All in ${label}` })) },
];

/**
 * Whether this tab runs the Scanner: one tab at a time (they'd share the session's queue, and each would load the
 * models). Another tab waits, and takes over when the first one closes. Null while asking.
 */
function useSingleTab(name: string): boolean | null {
  const [mine, setMine] = useState<boolean | null>(null);
  useEffect(() => {
    if (!navigator.locks) return setMine(true);
    const stop = new AbortController();
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    const hold = async () => {
      setMine(true);
      await held;
    };
    void navigator.locks
      .request(name, { ifAvailable: true }, async (lock) => {
        if (lock) return hold();
        setMine(false);
        await navigator.locks.request(name, { signal: stop.signal }, hold).catch(() => undefined);
      })
      .catch(() => setMine(true));
    return () => {
      release();
      stop.abort();
    };
  }, [name]);
  return mine;
}

/**
 * Collection → Scanner: photos of cards in, one row per card found, the user's corrections, then the cards added to the
 * account's collection or a binder (lib/export). Every photo is found and named first, then each card's print and
 * language are checked (scan-queue.ts). The session is kept in IndexedDB until "Clear scan" (scan-session.ts).
 */
export function ScanPage() {
  const mine = useSingleTab('tithies-scanner-page');
  if (mine === null) return <Loader size="sm" />;
  if (!mine)
    return (
      <Stack>
        <Title order={2}>Scanner</Title>
        <Alert color="blue" title="The Scanner is open in another tab">
          Use that tab: only one runs the Scanner at a time. This one takes over when the other closes.
        </Alert>
      </Stack>
    );
  return <ScanSession />;
}

function ScanSession() {
  const [photos, setPhotos] = useState<StoredPhoto[] | null>(null);
  const photosRef = useRef<StoredPhoto[]>([]);
  photosRef.current = photos ?? [];
  const [job, setJob] = useState<RunningJob | null>(null);
  const rt = useScanner(!job);
  /** 'read' (the print and language check), or the language every card is taken to be in (nothing read). */
  const [cardsMode, setCardsMode] = useLocalStorage<string>({ key: 'tithies:scanner:cards', defaultValue: 'read' });
  const reading = cardsMode === 'read';
  const assumed = reading ? null : cardsMode;
  const readingRef = useRef(reading);
  readingRef.current = reading;
  /** Bumped when the page goes or the scan is cleared: the work started before stops, and its results are dropped. */
  const gen = useRef(0);
  useEffect(
    () => () => {
      gen.current++;
    },
    [],
  );
  // The switch this mode replaced (2026-11-27).
  useEffect(() => {
    try {
      localStorage.removeItem('tithies:scanner:check');
    } catch {
      // Storage refused: nothing to clean.
    }
  }, []);
  const [shownId, setShownId] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [zoom, setZoom] = useState('1');
  const [picking, setPicking] = useState<number | null>(null);
  const [editing, setEditing] = useState(0);
  /** Cards being named again (photo id:number). */
  const [renaming, setRenaming] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const urlOf = useBlobUrls();
  const { account } = useCurrentAccount();
  const site = siteOf(account?.type ?? 'moxfield');
  const canExport = site.capabilities.exportTo.collection || site.capabilities.exportTo.binders;
  const [exporting, setExporting] = useState(false);
  const recentExports = useRecentExports(null, 10, 'Scanner');
  const [pickingExport, setPickingExport] = useState(false);
  const [viewedExport, setViewedExport] = useState<number | null>(null);

  useEffect(() => {
    void sessionPhotos().then((ps) => {
      setPhotos(ps);
      setShownId((id) => id ?? ps[0]?.id ?? null);
    });
  }, []);

  /** A photo as saved: replaced in the page's list. */
  const show = useCallback((p: StoredPhoto | null) => {
    if (p) setPhotos((ps) => ps?.map((x) => (x.id === p.id ? p : x)) ?? null);
  }, []);
  const editCard = useCallback((photoId: string, n: number, change: (c: StoredCard) => StoredCard) => void updateSessionCard(photoId, n, change).then(show), [show]);

  const checkable = reading && !!rt.textModels?.available;
  const checkOpts = useMemo(() => (rt.textModels ? { models: rt.textModels, prints: true, language: true } : null), [rt.textModels]);

  // The work, one job at a time: every photo named first, then the checks.
  useEffect(() => {
    if (rt.state !== 'ready' || job || !photos || !rt.engine) return;
    const next = nextJob(photos, { check: checkable });
    if (!next) return;
    const engine = rt.engine;
    const p = photos.find((x) => x.id === next.photoId)!;
    const my = gen.current;
    const live = () => gen.current === my;
    setJob({ ...next, done: 0, total: next.kind === 'check' ? next.cards.length : 0 });
    void (async () => {
      try {
        if (next.kind === 'name') {
          const scan = await scanPhoto(engine, new File([p.blob], p.name, { type: p.type }), rt.namer, { scale: 1, modelThreshold: 0.2, cleanup: true, check: null, stop: () => !live() }, (done, total) =>
            setJob((j) => live() && j ? { ...j, done, total } : j),
          );
          try {
            const cards: StoredCard[] = [];
            for (const c of scan.cards) {
              const result = c.byMethod[CHECKED_METHOD];
              if (result) cards.push({ n: c.n, quad: c.quad, heightPx: c.heightPx, source: c.source, crop: await cropBlob(c.crop), result });
            }
            const named: StoredPhoto = { ...p, width: scan.width, height: scan.height, status: 'named', cards };
            if (live() && (await replaceSessionPhoto(named))) show(named);
          } finally {
            disposePhoto(scan);
          }
        } else if (checkOpts) {
          const cards = p.cards.filter((c) => next.cards.includes(c.n));
          await checkPhoto(
            engine,
            p.blob,
            cards.map((c) => ({ quad: c.quad, result: c.result })),
            checkOpts,
            async (k, { check }) => {
              if (!live()) return;
              const card = cards[k];
              // The card as it is now: an outline moved meanwhile is checked again on its own.
              show(await updateSessionCard(p.id, card.n, (c) => (sameQuad(c.quad, card.quad) ? { ...c, check: withoutLines(check) } : c)));
              setJob((j) => j && { ...j, done: k + 1 });
            },
            () => !live() || shouldYield(photosRef.current) || !readingRef.current || !photosRef.current.some((x) => x.id === p.id),
          );
        }
      } catch (e) {
        // Stopped (cleared, the page left, or the engine or index closed under it): the photo stays queued, or its
        // cards to check, for the next job.
        if (!live() || e instanceof ScanStopped || e instanceof ClosedError) return;
        const msg = (e as Error).message;
        if (next.kind === 'name') {
          const failed: StoredPhoto = { ...p, status: 'failed', error: msg };
          if (await replaceSessionPhoto(failed)) show(failed);
        } else setError(`Checking ${p.name}: ${msg}`);
      } finally {
        if (live()) setJob(null);
      }
    })();
  }, [rt.state, rt.engine, rt.namer, job, photos, checkable, checkOpts, show]);

  const addFiles = async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (!images.length) return;
    const rows = await addSessionPhotos(images);
    setPhotos((ps) => [...(ps ?? []), ...rows]);
    setShownId((id) => id ?? rows[0].id);
  };

  const shown = photos?.find((p) => p.id === shownId) ?? null;

  /** A card at corners the user gave (a moved outline, or a missed card): named and checked again at full resolution. */
  const outline = async (p: StoredPhoto, quad: Quad, n: number | null) => {
    const engine = rt.engine;
    if (!engine || !rt.namer) return;
    const my = gen.current;
    const key = `${p.id}:${n}`;
    setEditing((k) => k + 1);
    if (n !== null) setRenaming((s) => new Set(s).add(key));
    let id: string | null = null;
    try {
      id = (await loadPhoto(engine, p.blob)).id;
      const [named] = await nameQuads(engine, id, [quad], rt.namer);
      const result = named.byMethod[CHECKED_METHOD];
      const crop = await cropBlob(named.crop);
      named.crop.close();
      if (!result) return;
      let check: StoredCard['check'];
      if (readingRef.current && checkOpts && rt.textModels?.available && result.more) check = withoutLines((await checkCard(engine, checkOpts.models, id, quad, result, checkOpts)).check);
      if (gen.current !== my) return;
      const old = n === null ? undefined : p.cards.find((c) => c.n === n);
      const saved = await putSessionCard(p.id, { n: n ?? 0, quad, heightPx: named.heightPx, source: old?.source ?? 'user', crop, result, ...(check ? { check } : {}) });
      if (saved) {
        show(saved.photo);
        setSelected(saved.n);
      }
    } catch (e) {
      if (gen.current === my) setError(`Naming the card: ${(e as Error).message}`);
    } finally {
      if (id) await engine.call({ type: 'releasePhoto', photoId: id }).catch(() => undefined);
      if (gen.current === my) {
        setEditing((k) => k - 1);
        setRenaming((s) => {
          const next = new Set(s);
          next.delete(key);
          return next;
        });
      }
    }
  };

  // Cards to review, in photo order: "Next to review" goes through them.
  const listedCards = useMemo(() => (photos ?? []).flatMap((p) => p.cards.filter(listed).map((c) => ({ p, c }))), [photos]);
  const statusOf = (c: StoredCard) => cardStatus(c, { checking: checkable });
  const toReview = listedCards.filter(({ c }) => !c.sentAt && (statusOf(c) === 'review' || statusOf(c) === 'unknown'));
  const pending = listedCards.filter(({ c }) => statusOf(c) === 'pending').length;
  const nextToReview = () => {
    if (!toReview.length) return;
    const at = toReview.findIndex(({ p, c }) => p.id === shownId && selected !== null && c.n === selected);
    const { p, c } = toReview[(at + 1) % toReview.length];
    setShownId(p.id);
    setSelected(c.n);
  };
  const items = useMemo(() => toExportItems(photos ?? [], assumed ?? 'en'), [photos, assumed]);

  // Keys: A adds a missed card, Esc stops, N goes to the next card to review.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Escape') setAdding(false);
      else if (e.key === 'a' || e.key === 'A') shown?.status === 'named' && setAdding(true);
      else if (e.key === 'n' || e.key === 'N') nextToReview();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const removePhoto = async (id: string) => {
    await removeSessionPhoto(id);
    setPhotos((ps) => ps?.filter((p) => p.id !== id) ?? null);
    if (shownId === id) setShownId(photosRef.current.find((p) => p.id !== id)?.id ?? null);
  };
  /** Stops everything (the running job stops at its next card) and empties the scan. */
  const clearScan = async () => {
    gen.current++;
    setJob(null);
    setPhotos([]);
    setShownId(null);
    setSelected(null);
    setRenaming(new Set());
    setEditing(0);
    await clearScannerSession();
  };
  const retryPhoto = async (p: StoredPhoto) => {
    const again: StoredPhoto = { ...p, status: 'queued', error: undefined };
    await saveSessionPhoto(again);
    show(again);
  };

  const jobPhoto = job ? photos?.find((p) => p.id === job.photoId) : undefined;
  const jobText = job
    ? job.kind === 'name'
      ? `Finding the cards in ${jobPhoto?.name ?? 'a photo'}${job.total ? ` (${job.done} of ${job.total})` : ''}…`
      : `Reading prints and languages in ${jobPhoto?.name ?? 'a photo'}: card ${Math.min(job.done + 1, job.total)} of ${job.total}…`
    : null;
  const waiting = (photos ?? []).filter((p) => p.status === 'queued').length;
  const pickingCard = shown && picking !== null ? shown.cards.find((c) => c.n === picking) : undefined;
  const labelCards = useMemo<LabelCard[]>(
    () =>
      (shown?.cards ?? []).map((c) => {
        const pr = chosenPrint(c);
        return { id: String(c.n), name: pr?.name ?? '?', set: pr?.set, cn: pr?.cn, quad: c.quad, hidden: !listed(c) };
      }),
    [shown],
  );
  const colorOf = (l: LabelCard) => {
    const c = shown?.cards.find((x) => String(x.n) === l.id);
    if (!c || !listed(c)) return 'var(--mantine-color-gray-5)';
    return `var(--mantine-color-${STATUS_COLOR[statusOf(c)]}-6)`;
  };
  const busyOf = (l: LabelCard) => {
    const c = shown?.cards.find((x) => String(x.n) === l.id);
    return !!c && listed(c) && (statusOf(c) === 'pending' || renaming.has(`${shown!.id}:${c.n}`));
  };
  const checkingShown: 'now' | 'waiting' | 'off' = !checkable ? 'off' : job?.kind === 'check' && job.photoId === shownId ? 'now' : 'waiting';

  return (
    <Stack>
      <Group justify="space-between" align="flex-end">
        <Stack gap={2}>
          <Title order={2}>Scanner</Title>
          <Text size="sm" c="dimmed">
            Photos of your cards: each card is found and named, its print and language read, then you add them to your collection or a binder.
          </Text>
        </Stack>
        {rt.state === 'ready' && (
          <Text size="xs" c="dimmed">
            Ready{rt.readyIn !== null ? ` in ${(rt.readyIn / 1000).toFixed(1)} s` : ''} · {rt.backend === 'webgpu' ? 'on the graphics card' : 'on the processor (slower)'} · index of {rt.installed?.manifest.created.slice(0, 10)}
            {rt.indexUpdating ? ' · updating the index…' : ''}
          </Text>
        )}
      </Group>

      {rt.state === 'starting' && (
        <Group gap="xs">
          <Loader size="xs" />
          <Text size="sm">Starting the Scanner…</Text>
        </Group>
      )}
      {rt.state === 'loading' && (
        <Group gap="xs">
          <Loader size="xs" />
          <Text size="sm">Starting the models…</Text>
        </Group>
      )}
      {rt.state === 'needsFiles' && (
        <Alert color="blue" title="The Scanner needs its models and card index">
          <Stack gap="xs" align="flex-start">
            <Text size="sm">
              They're downloaded once from Hugging Face{rt.needed ? ` (about ${mb(rt.needed)})` : ''} and kept in this browser. Your photos never leave it.
            </Text>
            <Button leftSection={<IconPhotoPlus size={16} />} onClick={() => void rt.getFiles()}>
              Get the Scanner{rt.needed ? ` (${mb(rt.needed)})` : ''}
            </Button>
          </Stack>
        </Alert>
      )}
      {rt.state === 'downloading' && rt.progress && (
        <Stack gap={4}>
          <Text size="sm">
            Downloading the Scanner ({mb(rt.progress.done)} of {mb(rt.progress.total)})…
          </Text>
          <Progress value={(100 * rt.progress.done) / Math.max(1, rt.progress.total)} animated />
        </Stack>
      )}
      {rt.modelUpdate && rt.state === 'ready' && (
        <Alert color="blue" title="A new version of the Scanner is out">
          <Group>
            <Text size="sm">Its models changed{rt.needed ? ` (${mb(rt.needed)} to download)` : ''}.</Text>
            <Button size="xs" onClick={() => void rt.getFiles()} disabled={!!job}>
              Update
            </Button>
          </Group>
        </Alert>
      )}
      {(rt.error || error) && (
        <Alert color="red" withCloseButton onClose={() => setError(null)}>
          {error ?? rt.error}
        </Alert>
      )}

      <Card
        withBorder
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void addFiles([...e.dataTransfer.files]);
        }}
        style={dragging ? { outline: '2px dashed var(--mantine-color-blue-5)' } : undefined}
      >
        <Stack gap="sm">
          <Group justify="space-between">
            <Group gap="sm">
              <Button component="label" leftSection={<IconPhotoPlus size={16} />} variant="light">
                Add photos
                <input type="file" multiple accept="image/*" hidden onChange={(e) => void addFiles([...(e.currentTarget.files ?? [])])} />
              </Button>
              <Text size="xs" c="dimmed">
                or drop them here. Full camera resolution reads the most.
              </Text>
            </Group>
            <Group gap="md">
              <Tooltip
                label="Read each card: its bottom line and text give the right print among reprints with the same artwork, and its language (about 3 s a card). Or take every card to be in one language: faster, and the prints among same-art reprints are left to you."
                multiline
                w={340}
              >
                <Select size="xs" w={270} data={CARDS_MODES} value={cardsMode} onChange={(v) => v && setCardsMode(v)} allowDeselect={false} searchable comboboxProps={{ withinPortal: true }} aria-label="How the scan takes the cards' print and language" />
              </Tooltip>
              <Tooltip label="Name cards only against the prints of your collection" withinPortal>
                <Switch size="sm" label="Only my prints" checked={rt.onlyMine} onChange={(e) => rt.setOnlyMine(e.currentTarget.checked)} />
              </Tooltip>
            </Group>
          </Group>
          {(jobText || waiting > 0) && (
            <Group gap="xs">
              <Loader size="xs" />
              <Text size="sm">
                {jobText ?? 'Waiting for the Scanner…'}
                {waiting > (job?.kind === 'name' ? 1 : 0) ? ` · ${waiting - (job?.kind === 'name' ? 1 : 0)} photo(s) waiting` : ''}
              </Text>
            </Group>
          )}
          {!!photos?.length && (
            <Group gap="xs">
              {photos.map((p) => (
                <Card key={p.id} padding={4} withBorder onClick={() => setShownId(p.id)} style={{ cursor: 'pointer', outline: p.id === shownId ? '2px solid var(--mantine-color-blue-5)' : undefined }}>
                  <Stack gap={2} align="center">
                    <Image src={urlOf(p.blob)} h={64} w={86} fit="cover" radius={3} alt={p.name} />
                    <Group gap={4}>
                      <Badge size="xs" variant="light" color={p.status === 'failed' ? 'red' : p.status === 'queued' ? 'gray' : 'blue'}>
                        {p.status === 'queued' ? 'waiting' : p.status === 'failed' ? 'failed' : `${p.cards.filter(listed).length} cards`}
                      </Badge>
                      {p.status === 'failed' && (
                        <Tooltip label="Try again" withinPortal>
                          <ActionIcon
                            size="xs"
                            variant="subtle"
                            aria-label="Try again"
                            onClick={(e) => {
                              e.stopPropagation();
                              void retryPhoto(p);
                            }}
                          >
                            <IconRefresh size={12} />
                          </ActionIcon>
                        </Tooltip>
                      )}
                      <ActionIcon
                        size="xs"
                        variant="subtle"
                        color="red"
                        aria-label="Remove photo"
                        onClick={(e) => {
                          e.stopPropagation();
                          void removePhoto(p.id);
                        }}
                      >
                        <IconTrash size={12} />
                      </ActionIcon>
                    </Group>
                  </Stack>
                </Card>
              ))}
            </Group>
          )}
          {!!photos?.length && (
            <Group justify="space-between">
              <Group gap="xs">
                <Text size="sm">
                  {listedCards.length} card{listedCards.length === 1 ? '' : 's'} in {photos.length} photo{photos.length === 1 ? '' : 's'}
                  {toReview.length ? ` · ${toReview.length} to review` : ''}
                  {pending ? ` · ${pending} being read` : ''}
                </Text>
                {toReview.length > 0 && (
                  <Button size="compact-sm" variant="subtle" rightSection={<IconArrowRight size={14} />} onClick={nextToReview}>
                    Next to review <Kbd ml={4}>N</Kbd>
                  </Button>
                )}
              </Group>
              <Group gap="xs">
                {recentExports.length > 0 && (
                  <Button size="xs" variant="subtle" onClick={() => (recentExports.length === 1 ? setViewedExport(recentExports[0].id!) : setPickingExport(true))}>
                    Recent exports
                  </Button>
                )}
                <Tooltip label="Stops the scan and empties it: photos, cards and corrections" withinPortal>
                  <Button size="xs" variant="default" color="red" onClick={() => void clearScan()}>
                    Clear scan
                  </Button>
                </Tooltip>
                {canExport && (
                  <Tooltip label={`${pending} card${pending === 1 ? ' is' : 's are'} still being read: ${pending === 1 ? 'its' : 'their'} print and language may change`} disabled={!pending} withinPortal>
                    <Button size="xs" onClick={() => setExporting(true)} disabled={!items.length}>
                      Add {items.length} card{items.length === 1 ? '' : 's'} to {site.label}…
                    </Button>
                  </Tooltip>
                )}
              </Group>
            </Group>
          )}
        </Stack>
      </Card>

      {shown && (
        <Stack gap="xs">
          <Group justify="space-between">
            <Text size="sm" fw={600}>
              {shown.name}
              {shown.status === 'failed' && (
                <Text span c="red" size="sm" fw={400}>
                  {' '}
                  · couldn't be scanned: {shown.error}
                </Text>
              )}
            </Text>
            {shown.status === 'named' && (
              <Group gap="xs">
                {editing > 0 && <Loader size="xs" />}
                <Button size="xs" variant={adding ? 'filled' : 'light'} leftSection={<IconPlus size={14} />} onClick={() => setAdding((a) => !a)}>
                  {adding ? 'Click its 4 corners… (Esc stops)' : 'Add a missed card'} <Kbd ml={4}>A</Kbd>
                </Button>
                <SegmentedControl size="xs" value={zoom} onChange={setZoom} data={[{ value: '1', label: 'Fit' }, { value: '2', label: '2×' }, { value: '4', label: '4×' }]} />
              </Group>
            )}
          </Group>
          {shown.status === 'named' ? (
            <>
              <Text size="xs" c="dimmed">
                Click a card to find its row; drag the corners of the selected one to fix its outline (it's named again).
              </Text>
              <LabelEditor
                src={urlOf(shown.blob)}
                width={shown.width}
                height={shown.height}
                cards={labelCards}
                colorOf={colorOf}
                busy={busyOf}
                numberOf={(c) => Number(c.id)}
                selected={selected === null ? null : String(selected)}
                onSelect={(id) => setSelected(id === null ? null : Number(id))}
                onQuadChange={(id, quad) => void outline(shown, quad, Number(id))}
                adding={adding}
                onAdded={(quad) => {
                  setAdding(false);
                  void outline(shown, quad, null);
                }}
                zoom={Number(zoom)}
              />
              <ScanTable
                photo={shown}
                urlOf={urlOf}
                selected={selected}
                onSelect={setSelected}
                onEdit={(n, change) => editCard(shown.id, n, change)}
                onPickPrint={setPicking}
                checking={checkingShown}
                assumed={assumed}
                renaming={new Set(shown.cards.filter((c) => renaming.has(`${shown.id}:${c.n}`)).map((c) => c.n))}
              />
            </>
          ) : (
            <Image src={urlOf(shown.blob)} radius="sm" alt={shown.name} />
          )}
        </Stack>
      )}

      {shown && pickingCard && rt.printIndex && (
        <ScanPrintPicker
          card={pickingCard}
          prints={rt.printIndex.prints}
          onClose={() => setPicking(null)}
          onPick={(p) => editCard(shown.id, pickingCard.n, (c) => ({ ...c, edit: { ...c.edit, print: p, finish: undefined } }))}
        />
      )}
      <ExportDialog
        opened={exporting}
        onClose={() => setExporting(false)}
        site={site}
        items={items}
        sourceAccountKey={null}
        source={`Scanner (${photos?.length ?? 0} photo${photos?.length === 1 ? '' : 's'})`}
        onStarted={() => {
          void markSessionSent(items.map((i) => i.key)).then((changed) => changed.forEach(show));
        }}
      />
      <RecentExportsModal
        opened={pickingExport}
        ops={recentExports}
        onPick={(id) => {
          setPickingExport(false);
          setViewedExport(id);
        }}
        onClose={() => setPickingExport(false)}
      />
      <ExportProgressModal opId={viewedExport} onClose={() => setViewedExport(null)} />
    </Stack>
  );
}
