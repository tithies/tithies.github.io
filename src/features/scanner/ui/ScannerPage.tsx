import { Alert, Badge, Button, Card, Checkbox, CopyButton, Group, NumberInput, Progress, SegmentedControl, Select, Stack, Text, Title } from '@mantine/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCurrentAccount } from '@/lib/accounts/AccountProvider';
import { accountData } from '@/lib/accounts/data';
import { accountLabel } from '@/lib/accounts/types';
import { ScannerEngine } from '../engine-client';
import { isModelCached, loadModelFile } from '../model-cache';
import { ALL_METHODS, DINO_FILE } from '../models';
import { disposePhoto, photoToJson, scanPhoto, type ScannedPhoto } from '../pipeline';
import type { EngineInfo } from '../protocol';
import { buildReferences, ownedPrints, type BuildProgress, type PrintInfo } from '../reference';
import { parseLabels, type Labels, type ScoredPhoto } from '../score';
import { buildIndex, type RefIndex } from '../search-index';
import { currentRefs } from '../store';
import { CardsTable } from './CardsTable';
import { PhotoView } from './PhotoView';
import { ResultsTable } from './ResultsTable';

type Busy = { label: string; progress?: number } | null;

interface LoadedPhoto {
  file: File;
  url: string;
  scan: ScannedPhoto | null;
  error?: string;
}

const toScored = (p: ScannedPhoto): ScoredPhoto => ({
  file: p.file,
  detections: p.cards.map((c) => ({ heightPx: c.heightPx, byModel: Object.fromEntries(Object.entries(c.byMethod).map(([m, r]) => [m, r.candidates])) })),
});

const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

/**
 * Hidden prototype page (dashboard.html#/collection/scanner): phase 0 of SCANNER_DEV.md. It
 * starts the engine, builds the reference set from the current account's prints, scans photos
 * dropped on it (with labels.json to score them) and shows what each method found.
 */
export function ScannerPage() {
  const { key: accountKey, account } = useCurrentAccount();
  const engineRef = useRef<ScannerEngine | null>(null);
  const [info, setInfo] = useState<EngineInfo | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [backend, setBackend] = useState<string | null>(null);
  const [modelCached, setModelCached] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

  const [prints, setPrints] = useState<PrintInfo[] | null>(null);
  const [index, setIndex] = useState<RefIndex | null>(null);
  const [build, setBuild] = useState<BuildProgress | null>(null);
  const buildAbort = useRef<AbortController | null>(null);

  const [photos, setPhotos] = useState<LoadedPhoto[]>([]);
  const [labels, setLabels] = useState<Labels | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [method, setMethod] = useState<string>(ALL_METHODS[0].id);
  const [scale, setScale] = useState('1');
  const [maxSide, setMaxSide] = useState<number>(2000);
  const [debug, setDebug] = useState(true);
  const [showEdges, setShowEdges] = useState(false);
  const [showRejected, setShowRejected] = useState(false);
  const [minHeightPx, setMinHeightPx] = useState<number>(0);
  const [dragging, setDragging] = useState(false);

  // Engine: started on open, closed on leave.
  useEffect(() => {
    let cancelled = false;
    ScannerEngine.start()
      .then(({ engine, info }) => {
        if (cancelled) return engine.dispose();
        engineRef.current = engine;
        // Prototype tuning from the console: await scannerEngine.call({ type: 'bench', ep: 'webgpu', opt: 'all', runs: 5 })
        (window as unknown as { scannerEngine?: ScannerEngine }).scannerEngine = engine;
        setInfo(info);
      })
      .catch((e: Error) => !cancelled && setEngineError(e.message));
    isModelCached(DINO_FILE).then(setModelCached, () => setModelCached(false));
    return () => {
      cancelled = true;
      buildAbort.current?.abort();
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  // The current account's prints, and the reference vectors already made.
  useEffect(() => {
    let cancelled = false;
    setPrints(null);
    if (accountKey)
      accountData(accountKey)
        .collection.list()
        .then((entries) => !cancelled && setPrints(ownedPrints(entries)));
    currentRefs().then((rows) => !cancelled && setIndex(buildIndex(rows)));
    return () => {
      cancelled = true;
    };
  }, [accountKey]);

  // Object URLs and bitmaps are freed when photos go.
  const photosRef = useRef(photos);
  photosRef.current = photos;
  useEffect(
    () => () => {
      for (const p of photosRef.current) {
        URL.revokeObjectURL(p.url);
        if (p.scan) disposePhoto(p.scan);
      }
    },
    [],
  );

  const run = useCallback(async (label: string, fn: () => Promise<void>) => {
    setError(null);
    setBusy({ label });
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

  const loadModel = () =>
    run(`Loading ${DINO_FILE.label}…`, async () => {
      const engine = engineRef.current!;
      const bytes = await loadModelFile(DINO_FILE, (done, total) => setBusy({ label: `Downloading ${DINO_FILE.label} (${mb(done)} of ${mb(total)})…`, progress: (100 * done) / total }));
      setModelCached(true);
      setBusy({ label: 'Starting the model…' });
      const r = await engine.call({ type: 'loadModel', bytes }, [bytes]);
      setBackend(r.backend);
    });

  const buildRefs = () => {
    const engine = engineRef.current;
    if (!engine || !prints) return;
    const ctl = new AbortController();
    buildAbort.current = ctl;
    void run('Building the reference set…', async () => {
      try {
        await buildReferences(engine, prints, { signal: ctl.signal, onProgress: (p) => setBuild(p) });
      } finally {
        buildAbort.current = null;
        setIndex(buildIndex(await currentRefs()));
      }
    });
  };

  const scanAll = useCallback(
    async (list: LoadedPhoto[]) => {
      const engine = engineRef.current;
      if (!engine) return;
      await run('Scanning…', async () => {
        for (const [i, p] of list.entries()) {
          setBusy({ label: `Scanning ${p.file.name} (${i + 1} of ${list.length})…` });
          try {
            const scan = await scanPhoto(engine, p.file, index, { scale: Number(scale), maxSide, debug }, (done, total) =>
              setBusy({ label: `Scanning ${p.file.name} (${i + 1} of ${list.length}): card ${done} of ${total}…`, progress: (100 * done) / total }),
            );
            setPhotos((ps) =>
              ps.map((x) => {
                if (x.url !== p.url) return x;
                if (x.scan) disposePhoto(x.scan);
                return { ...x, scan, error: undefined };
              }),
            );
          } catch (e) {
            setPhotos((ps) => ps.map((x) => (x.url === p.url ? { ...x, error: (e as Error).message } : x)));
          }
        }
      });
    },
    [index, scale, maxSide, debug, run],
  );

  const addFiles = async (files: File[]) => {
    const json = files.find((f) => f.name.toLowerCase().endsWith('.json'));
    if (json) {
      try {
        setLabels(parseLabels(await json.text()));
      } catch (e) {
        setError((e as Error).message);
      }
    }
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (!images.length) return;
    const fresh = images.map((file): LoadedPhoto => ({ file, url: URL.createObjectURL(file), scan: null }));
    setPhotos((ps) => [...ps, ...fresh]);
    setCurrent((c) => c ?? fresh[0].url);
    if (backend) await scanAll(fresh);
  };

  const shown = photos.find((p) => p.url === current) ?? null;
  const scanned = useMemo(() => photos.flatMap((p) => (p.scan ? [p.scan] : [])), [photos]);
  const resultsJson = useMemo(
    () =>
      JSON.stringify(
        { engine: info, backend, references: index?.size ?? 0, method, photos: scanned.map(photoToJson) },
        null,
        1,
      ),
    [info, backend, index, method, scanned],
  );
  const eta = build && build.done > 0 ? ((Date.now() - build.startedAt) / build.done) * (build.total - build.done - build.failed) : null;
  const ready = !!info && !!backend;

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={2}>Scanner</Title>
        <Badge color="orange" variant="light">
          Prototype (phase 0)
        </Badge>
      </Group>
      {engineError && <Alert color="red">The engine didn't start: {engineError}</Alert>}
      {error && (
        <Alert color="red" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Group align="stretch" grow>
        <Card withBorder>
          <Stack gap={6}>
            <Text fw={600}>1. Engine and model</Text>
            <Text size="sm">
              {info ? `OpenCV ${info.opencv} · onnxruntime ${info.ort} · WebGPU ${info.webgpu ? 'available' : 'not available'}` : engineError ? 'Not started' : 'Starting…'}
            </Text>
            <Text size="sm">
              {DINO_FILE.label}: {backend ? `running on ${backend === 'webgpu' ? 'WebGPU' : 'the CPU'}` : modelCached ? 'downloaded, not started' : `not downloaded (${mb(DINO_FILE.bytes)})`}
            </Text>
            <Group>
              <Button size="xs" onClick={loadModel} disabled={!info || !!busy || !!backend}>
                {modelCached ? 'Start the model' : 'Download and start the model'}
              </Button>
            </Group>
          </Stack>
        </Card>
        <Card withBorder>
          <Stack gap={6}>
            <Text fw={600}>2. Reference set (prints you own)</Text>
            <Text size="sm">
              {account ? `${accountLabel(account)}: ` : ''}
              {prints ? `${prints.length.toLocaleString()} prints in the synced collection` : accountKey ? 'Reading the collection…' : 'No account: sync your collection first'}
            </Text>
            <Text size="sm">{index ? `${index.size.toLocaleString()} prints have vectors` : '…'}</Text>
            {build && (
              <>
                <Progress value={build.total ? (100 * (build.done + build.failed)) / build.total : 100} />
                <Text size="xs" c="dimmed">
                  {build.done.toLocaleString()} of {build.total.toLocaleString()} new prints
                  {build.failed ? ` · ${build.failed} failed` : ''}
                  {build.skipped ? ` · ${build.skipped.toLocaleString()} already done` : ''}
                  {eta !== null && build.done + build.failed < build.total ? ` · about ${Math.ceil(eta / 60000)} min left` : ''}
                </Text>
              </>
            )}
            <Group>
              <Button size="xs" onClick={buildRefs} disabled={!ready || !prints?.length || !!busy}>
                {index?.size ? 'Add missing prints' : 'Build the reference set'}
              </Button>
              {buildAbort.current && (
                <Button size="xs" variant="default" onClick={() => buildAbort.current?.abort()}>
                  Stop
                </Button>
              )}
            </Group>
          </Stack>
        </Card>
      </Group>

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
        <Stack gap={6}>
          <Text fw={600}>3. Photos</Text>
          <Text size="sm">
            Drop photos here (full camera resolution), with labels.json to score them, or pick them:{' '}
            <input type="file" multiple accept="image/*,.json,application/json" onChange={(e) => void addFiles([...(e.currentTarget.files ?? [])])} disabled={!ready} />
          </Text>
          <Group gap="lg" align="flex-end">
            <Stack gap={2}>
              <Text size="xs">Simulate lower resolution</Text>
              <SegmentedControl
                size="xs"
                value={scale}
                onChange={setScale}
                data={[
                  { value: '1', label: '100 %' },
                  { value: '0.5', label: '50 %' },
                  { value: '0.33', label: '33 %' },
                  { value: '0.25', label: '25 %' },
                ]}
              />
            </Stack>
            <NumberInput size="xs" w={150} label="Detection size (px)" value={maxSide} onChange={(v) => setMaxSide(Number(v) || 2000)} min={600} max={4000} step={200} />
            <NumberInput size="xs" w={170} label="Warn below (card px tall)" value={minHeightPx} onChange={(v) => setMinHeightPx(Number(v) || 0)} min={0} step={50} />
            <Checkbox size="xs" label="Keep debug layers" checked={debug} onChange={(e) => setDebug(e.currentTarget.checked)} />
            <Button size="xs" variant="default" disabled={!ready || !photos.length || !!busy} onClick={() => void scanAll(photos)}>
              Scan all again
            </Button>
          </Group>
          <Text size="xs" c="dimmed">
            {photos.length} photo{photos.length === 1 ? '' : 's'}
            {labels ? ` · labels for ${Object.keys(labels).length}` : ' · no labels.json'}
            {!index?.size ? ' · no reference set yet: cards are found but not named' : ''}
          </Text>
        </Stack>
      </Card>

      {busy && (
        <Card withBorder>
          <Text size="sm">{busy.label}</Text>
          {busy.progress !== undefined && <Progress value={busy.progress} mt={4} />}
        </Card>
      )}

      {labels && scanned.length > 0 && (
        <Card withBorder>
          <Stack gap={6}>
            <Group justify="space-between">
              <Text fw={600}>Scores (labelled photos)</Text>
              <CopyButton value={resultsJson}>{({ copied, copy }) => <Button size="xs" variant="default" onClick={copy}>{copied ? 'Copied' : 'Copy results JSON'}</Button>}</CopyButton>
            </Group>
            <ResultsTable photos={scanned.map(toScored)} labels={labels} />
          </Stack>
        </Card>
      )}

      {photos.length > 0 && (
        <Card withBorder>
          <Stack gap="sm">
            <Group gap="md" align="flex-end">
              <Select
                size="xs"
                w={280}
                label="Photo"
                value={current}
                onChange={(v) => {
                  setCurrent(v);
                  setSelected(null);
                }}
                data={photos.map((p) => ({ value: p.url, label: `${p.file.name}${p.scan ? ` · ${p.scan.cards.length} cards` : p.error ? ' · failed' : ''}` }))}
              />
              <Select size="xs" w={240} label="Method shown" value={method} onChange={(v) => v && setMethod(v)} data={ALL_METHODS.map((m) => ({ value: m.id, label: m.label }))} />
              <Checkbox size="xs" label="Edges" checked={showEdges} onChange={(e) => setShowEdges(e.currentTarget.checked)} />
              <Checkbox size="xs" label="Rejected shapes" checked={showRejected} onChange={(e) => setShowRejected(e.currentTarget.checked)} />
              {!labels && !!scanned.length && (
                <CopyButton value={resultsJson}>{({ copied, copy }) => <Button size="xs" variant="default" onClick={copy}>{copied ? 'Copied' : 'Copy results JSON'}</Button>}</CopyButton>
              )}
            </Group>
            {shown?.error && <Alert color="red">{shown.error}</Alert>}
            {shown?.scan && (
              <>
                <Text size="xs" c="dimmed">
                  {shown.scan.width} × {shown.scan.height} px scanned ({Math.round(shown.scan.scale * 100)} %) · {shown.scan.cards.length} cards ·{' '}
                  {shown.scan.cards.filter((c) => c.source === 'grid').length} from the binder grid · load {Math.round(shown.scan.timings.loadMs)} ms · detect{' '}
                  {Math.round(shown.scan.timings.detectMs)} ms · cards {Math.round(shown.scan.timings.cardsMs)} ms
                </Text>
                <PhotoView photo={shown.scan} src={shown.url} method={method} selected={selected} onSelect={setSelected} showEdges={showEdges} showRejected={showRejected} />
                <CardsTable photo={shown.scan} method={method} labels={labels?.[shown.scan.file]} selected={selected} onSelect={setSelected} minHeightPx={minHeightPx} />
              </>
            )}
            {shown && !shown.scan && !shown.error && <Text size="sm">Not scanned yet.</Text>}
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
