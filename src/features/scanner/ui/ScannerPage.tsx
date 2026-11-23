import { Alert, Badge, Button, Card, Checkbox, CopyButton, Group, Kbd, NumberInput, Progress, SegmentedControl, Select, Stack, Text, Title, useMantineTheme } from '@mantine/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCurrentAccount } from '@/lib/accounts/AccountProvider';
import { accountData } from '@/lib/accounts/data';
import { accountLabel } from '@/lib/accounts/types';
import { downloadText } from '@/lib/ui/download';
import { ScannerEngine } from '../engine-client';
import { cacheDetector, cachedDetector, cachedRecognizer, cacheRecognizer, isModelCached, loadModelFile } from '../model-cache';
import { ALL_METHODS, DINO_FILE } from '../models';
import { confidence, disposePhoto, nameQuads, photoToJson, refNamer, scanPhoto, type Namer, type Recognizer, type ScannedPhoto } from '../pipeline';
import { openPrintIndex, printIndexNamer, setOwnedOnly, type PrintIndex } from '../print-index';
import { checkLatest, downloadPublished, indexOnlyUpdate, installDropped, installedFiles, missingFiles, readFile, sha256Hex, type Installed, type LatestCheck } from '../published';
import type { DetectMethod, EngineInfo } from '../protocol';
import { buildReferences, ownedPrints, type BuildProgress, type PrintInfo } from '../reference';
import type { ScoredPhoto } from '../score';
import type { Quad } from '../geometry';
import { draftFromScan, fromMatch, newLabelId, parseLabels, photoChecked, sameName, serializeLabels, turnQuad, type CardMatchView, type LabelCard, type Labels, type PhotoLabels } from '../labels';
import { buildIndex, type RefIndex } from '../search-index';
import { orderCorners } from '../geometry';
import { currentRefs, dropOtherTuned, labelDrafts, labelsDownloadedAt, markLabelsDownloaded, MODEL_KEY, saveLabelDraft, tunedModelKey } from '../store';
import { CardsTable } from './CardsTable';
import { LabelEditor } from './LabelEditor';
import { LabelsTable } from './LabelsTable';
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
  scale: p.scale,
  detections: p.cards.map((c) => ({ heightPx: c.heightPx, quad: c.quad, byModel: Object.fromEntries(Object.entries(c.byMethod).map(([m, r]) => [m, r.candidates])) })),
});

/** Labels a person gave (checked, or from an older labels file): the only ones that score. */
const truthOf = (l: PhotoLabels | undefined) => l?.cards.filter((c) => c.checked || c.manual);

/** Drafts and files get fresh editing ids (the counter restarts with the page). */
const withIds = (l: PhotoLabels): PhotoLabels => ({ ...l, cards: l.cards.map((c) => ({ ...c, id: newLabelId() })) });

const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

/** Where the models come from: the published files (Hugging Face, or dropped with their manifest), files dropped on
 * the page (developer path), or the downloaded DINOv2 (with a dropped detector, if any). */
type ModelSource = 'published' | 'dropped' | 'dino';
/** What cards are named against: the every-print index, only the owned prints of it, or the reference set built here. */
type MatchAgainst = 'every' | 'mine' | 'built';
const sourceLabel = (s: ModelSource, v?: string) => (s === 'published' ? `published ${v ?? ''}`.trim() : s === 'dropped' ? 'dropped files' : 'DINOv2');

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
  const [detector, setDetector] = useState<{ size: number; backend: string; from: string } | null>(null);
  const [detectMethod, setDetectMethod] = useState<DetectMethod>('classic');
  const [modelThreshold, setModelThreshold] = useState<number>(0.2);
  const [modelCached, setModelCached] = useState<boolean | null>(null);
  /** Which recognition model: the downloaded DINOv2, or a tuned one (published, or dropped on the page: card-recognizer.onnx). */
  const [recognizer, setRecognizer] = useState<Recognizer>('dino');
  const [modelSource, setModelSource] = useState<ModelSource>('dino');
  const [tunedCached, setTunedCached] = useState(false);
  /** The running recognizer's SHA-256: the every-print index only goes with its own. */
  const [recognizerSha, setRecognizerSha] = useState<string | null>(null);
  /** The published files installed here, and what Hugging Face has (checked at most once a day). */
  const [installed, setInstalled] = useState<Installed | null>(null);
  const installedRef = useRef(installed);
  installedRef.current = installed;
  const [publishedModels, setPublishedModels] = useState(false);
  const [latest, setLatest] = useState<LatestCheck | null>(null);
  const [checking, setChecking] = useState(false);
  /** A new index alone (same models) downloads by itself: its progress, then the install waiting for the scans to end. */
  const [indexUpdate, setIndexUpdate] = useState<{ done: number; total: number } | null>(null);
  const [pendingInstall, setPendingInstall] = useState<Installed | null>(null);
  const updating = useRef(false);
  /** The every-print index as opened, and as searched (with the "only my prints" mask). */
  const [printBase, setPrintBase] = useState<PrintIndex | null>(null);
  const [printIndex, setPrintIndex] = useState<PrintIndex | null>(null);
  const [matchAgainst, setMatchAgainst] = useState<MatchAgainst>('every');
  const openedAt = useRef(performance.now());
  const [readyIn, setReadyIn] = useState<number | null>(null);
  /** The running model's vectors key (store.ts): the reference set is read and built for it. */
  const [modelKey, setModelKey] = useState<string>(MODEL_KEY);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

  const [prints, setPrints] = useState<PrintInfo[] | null>(null);
  const [index, setIndex] = useState<RefIndex | null>(null);
  const [build, setBuild] = useState<BuildProgress | null>(null);
  const [building, setBuilding] = useState(false);
  const buildAbort = useRef<AbortController | null>(null);

  const [photos, setPhotos] = useState<LoadedPhoto[]>([]);
  /** Labels of every photo (drafts saved as you go, and labels.json dropped): file -> labels. */
  const [labels, setLabels] = useState<Labels>({});
  const labelsRef = useRef(labels);
  labelsRef.current = labels;
  const [labelUpdated, setLabelUpdated] = useState<Record<string, number>>({});
  const [downloadedAt, setDownloadedAt] = useState(0);
  /** What the scanner saw at each label (cut-out, top 5), by file and label id: not saved. */
  const [matches, setMatches] = useState<Record<string, Map<string, CardMatchView>>>({});
  const matchesRef = useRef(matches);
  matchesRef.current = matches;
  const [view, setView] = useState<'results' | 'labels'>('results');
  const [labelSel, setLabelSel] = useState<string | null>(null);
  /** Placing corners: of a new card, or of the card with this id. */
  const [adding, setAdding] = useState<'new' | string | null>(null);
  const [zoom, setZoom] = useState('1');
  const [naming, setNaming] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const theme = useMantineTheme();
  const [current, setCurrent] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [method, setMethod] = useState<string>('dino-pad-cls');
  const [scale, setScale] = useState('1');
  const [maxSide, setMaxSide] = useState<number>(2000);
  // Off by default: the edge map of every scanned photo takes ~12 MB (many photos when labelling).
  const [debug, setDebug] = useState(false);
  const [cleanup, setCleanup] = useState(true);
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
        // The published models when they're here, else the files dropped earlier, else DINOv2.
        void (async () => {
          const inst = (await installedFiles()) ?? null;
          const pub = !!inst && !(await missingFiles(inst.manifest, ['detector', 'recognizer'])).length;
          const tuned = !!(await cachedRecognizer());
          if (cancelled) return;
          setInstalled(inst);
          setPublishedModels(pub);
          setTunedCached(tuned);
          const source: ModelSource = pub ? 'published' : tuned ? 'dropped' : 'dino';
          setModelSource(source);
          setRecognizer(source === 'dino' ? 'dino' : 'tuned');
          await loadDetectorFor(engine, source, inst);
          if (source === 'published' && !cancelled) await loadModel('published');
        })().catch((e: Error) => setError(`The saved models didn't load: ${e.message}`));
        // Prototype tuning from the console: await scannerEngine.call({ type: 'bench', ep: 'webgpu', opt: 'all', runs: 5 })
        (window as unknown as { scannerEngine?: ScannerEngine }).scannerEngine = engine;
        setInfo(info);
      })
      .catch((e: Error) => !cancelled && setEngineError(e.message));
    isModelCached(DINO_FILE).then(setModelCached, () => setModelCached(false));
    // What Hugging Face has (from the last check when it's less than a day old).
    void checkLatest().then((l) => !cancelled && setLatest(l));
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
    return () => {
      cancelled = true;
    };
  }, [accountKey]);
  useEffect(() => {
    let cancelled = false;
    currentRefs(modelKey).then((rows) => !cancelled && setIndex(buildIndex(rows)));
    return () => {
      cancelled = true;
    };
  }, [modelKey]);

  // The installed every-print index: its prints here, its vectors in the search worker.
  useEffect(() => {
    if (!installed) return;
    let cancelled = false;
    let opened: PrintIndex | null = null;
    openPrintIndex(installed).then(
      (idx) => {
        opened = idx;
        if (cancelled) idx?.client.dispose();
        else setPrintBase(idx);
      },
      (e: Error) => !cancelled && setError(`The every-print index didn't open: ${e.message}`),
    );
    return () => {
      cancelled = true;
      opened?.client.dispose();
      setPrintBase(null);
    };
  }, [installed]);
  // "Only my prints": the same index, limited to the collection's prints.
  useEffect(() => {
    if (!printBase) return setPrintIndex(null);
    if (matchAgainst === 'mine' && !prints) return;
    let cancelled = false;
    setOwnedOnly(printBase, matchAgainst === 'mine' ? prints : null).then(
      (v) => !cancelled && setPrintIndex(v),
      (e: Error) => setError(e.message),
    );
    return () => {
      cancelled = true;
    };
  }, [printBase, matchAgainst, prints]);

  // A new index alone (the daily refresh) downloads in the background; it replaces the open one between scans.
  useEffect(() => {
    if (updating.current || !latest?.manifest || !latest.commit || !indexOnlyUpdate(installed, latest)) return;
    updating.current = true;
    const m = latest.manifest;
    const total = m.files.index.bytes + m.files.prints.bytes;
    setIndexUpdate({ done: 0, total });
    downloadPublished(m, latest.commit, { onProgress: (done, t) => setIndexUpdate({ done, total: t }) })
      .then(async () => setPendingInstall((await installedFiles()) ?? null))
      .catch((e: Error) => setError(`Updating the every-print index: ${e.message}`))
      .finally(() => {
        updating.current = false;
        setIndexUpdate(null);
      });
  }, [latest, installed]);
  useEffect(() => {
    if (pendingInstall && !busy) {
      setInstalled(pendingInstall);
      setPendingInstall(null);
    }
  }, [pendingInstall, busy]);

  /** The every-print index goes with the running recognizer (the one that made its vectors). */
  const indexFits = !!printIndex && !!recognizerSha && recognizerSha === printIndex.installed.manifest.files.recognizer.sha256;
  const namer = useMemo<Namer | null>(() => {
    if (matchAgainst !== 'built' && printIndex && indexFits) return printIndexNamer(printIndex);
    return index?.size ? refNamer(index) : null;
  }, [matchAgainst, printIndex, indexFits, index]);
  const namerRef = useRef(namer);
  namerRef.current = namer;
  // How long the page took to be ready to scan (models started, index open).
  useEffect(() => {
    if (readyIn === null && backend && detector && (!installed || printIndex)) setReadyIn(performance.now() - openedAt.current);
  }, [backend, detector, installed, printIndex, readyIn]);

  // Object URLs and bitmaps are freed when photos go.
  const photosRef = useRef(photos);
  photosRef.current = photos;

  // Prototype debugging from the console: names the card under a hand-placed quad (full-photo
  // pixels, clockwise from the card's top-left), to tell detection failures from matching ones:
  //   await scannerDebug.identifyQuad('photo.png', [[x, y], [x, y], [x, y], [x, y]])
  useEffect(() => {
    (window as unknown as { scannerDebug?: unknown }).scannerDebug = {
      identifyQuad: async (fileName: string, corners: [number, number][]) => {
        const engine = engineRef.current;
        const nm = namerRef.current;
        const p = photosRef.current.find((x) => x.file.name === fileName);
        if (!engine || !nm?.size || !p) throw new Error('Engine, reference set or photo missing');
        const bitmap = await createImageBitmap(p.file, { imageOrientation: 'from-image' });
        const photoId = `debug-${Date.now()}`;
        await engine.call({ type: 'loadPhoto', photoId, bitmap }, [bitmap]);
        try {
          const quad = orderCorners(corners.map(([x, y]) => ({ x, y })));
          const { cards } = await engine.call({ type: 'cardFeatures', photoId, quads: [quad] });
          const f = cards[0];
          f.crop.close();
          const [byMethod] = await nm.name([f]);
          return Object.fromEntries(Object.entries(byMethod).map(([m, r]) => [m, r.candidates.map((c) => `${c.name} (${c.set} #${c.cn}) ${c.score.toFixed(3)}`)]));
        } finally {
          await engine.call({ type: 'releasePhoto', photoId });
        }
      },
    };
  }, []);
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

  /** The detector of a model source: the published one, else the one dropped on the page (DINOv2 has none of its own). */
  const loadDetectorFor = async (engine: ScannerEngine, source: ModelSource, inst: Installed | null) => {
    const bytes = source === 'published' && inst ? await readFile(inst.manifest.files.detector) : await cachedDetector();
    if (!bytes) return setDetector(null);
    const r = await engine.call({ type: 'loadDetector', bytes }, [bytes]);
    setDetector({ ...r, from: source === 'published' ? `published ${inst?.manifest.version}` : 'dropped file' });
    setDetectMethod('model');
  };

  const loadModel = (which: ModelSource = modelSource) =>
    run(which === 'dino' ? `Loading ${DINO_FILE.label}…` : `Loading the recognition model (${sourceLabel(which, installedRef.current?.manifest.version)})…`, async () => {
      const engine = engineRef.current!;
      let bytes: ArrayBuffer;
      let key = MODEL_KEY;
      let sha: string | null = null;
      if (which === 'published') {
        const inst = installedRef.current ?? (await installedFiles());
        const pub = inst ? await readFile(inst.manifest.files.recognizer) : null;
        if (!inst || !pub) throw new Error('The published recognition model is not downloaded');
        bytes = pub;
        key = tunedModelKey(pub);
        sha = inst.manifest.files.recognizer.sha256;
      } else if (which === 'dropped') {
        const tuned = await cachedRecognizer();
        if (!tuned) throw new Error('No tuned model: drop card-recognizer.onnx on the photos box');
        bytes = tuned;
        key = tunedModelKey(tuned);
        sha = await sha256Hex(tuned);
      } else {
        bytes = await loadModelFile(DINO_FILE, (done, total) => setBusy({ label: `Downloading ${DINO_FILE.label} (${mb(done)} of ${mb(total)})…`, progress: (100 * done) / total }));
        setModelCached(true);
      }
      setBusy({ label: 'Starting the model…' });
      // The bytes move to the engine: the key and hash are taken first.
      const r = await engine.call({ type: 'loadModel', bytes }, [bytes]);
      setBackend(r.backend);
      setModelSource(which);
      setRecognizer(which === 'dino' ? 'dino' : 'tuned');
      setModelKey(key);
      setRecognizerSha(sha);
    });

  /** Another model source: its detector, then its recognizer if a model was running. */
  const switchSource = async (which: ModelSource) => {
    const engine = engineRef.current;
    setModelSource(which);
    setRecognizer(which === 'dino' ? 'dino' : 'tuned');
    if (!engine) return;
    try {
      await loadDetectorFor(engine, which, installedRef.current);
    } catch (e) {
      setError((e as Error).message);
    }
    if (backend || which === 'published') await loadModel(which);
  };

  /** Downloads what the latest published version needs, installs it, then runs its models. */
  const downloadFiles = async () => {
    const l = latest;
    if (!l?.manifest || !l.commit) return;
    let ok = false;
    await run('Downloading the Scanner files…', async () => {
      await downloadPublished(l.manifest!, l.commit!, {
        onProgress: (done, total) => setBusy({ label: `Downloading the Scanner files (${mb(done)} of ${mb(total)})…`, progress: (100 * done) / total }),
      });
      setInstalled((await installedFiles()) ?? null);
      setPublishedModels(true);
      ok = true;
    });
    if (ok) await switchSource('published');
  };
  const checkNow = async () => {
    setChecking(true);
    try {
      const l = await checkLatest({ force: true });
      setLatest(l);
      if (l.error) setError(`Checking Hugging Face: ${l.error}`);
    } finally {
      setChecking(false);
    }
  };

  // The build has its own state: photos can be scanned meanwhile (against the prints done when the page opened).
  const buildRefs = async () => {
    const engine = engineRef.current;
    if (!engine || !prints) return;
    const ctl = new AbortController();
    buildAbort.current = ctl;
    setBuilding(true);
    setError(null);
    try {
      await buildReferences(engine, prints, { signal: ctl.signal, onProgress: (p) => setBuild(p), modelKey });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      buildAbort.current = null;
      // The new index first, so the page never shows "done" next to the old count.
      setIndex(buildIndex(await currentRefs(modelKey)));
      setBuilding(false);
    }
  };

  const scanAll = useCallback(
    async (list: LoadedPhoto[]) => {
      const engine = engineRef.current;
      if (!engine) return;
      await run('Scanning…', async () => {
        for (const [i, p] of list.entries()) {
          setBusy({ label: `Scanning ${p.file.name} (${i + 1} of ${list.length})…` });
          try {
            const scan = await scanPhoto(engine, p.file, namer, { scale: Number(scale), maxSide, debug, method: detectMethod, modelThreshold, cleanup }, (done, total) =>
              setBusy({ label: `Scanning ${p.file.name} (${i + 1} of ${list.length}): card ${done} of ${total}…`, progress: (100 * done) / total }),
            );
            setPhotos((ps) =>
              ps.map((x) => {
                if (x.url !== p.url) return x;
                if (x.scan) disposePhoto(x.scan);
                return { ...x, scan: { ...scan, recognizer }, error: undefined };
              }),
            );
          } catch (e) {
            setPhotos((ps) => ps.map((x) => (x.url === p.url ? { ...x, error: (e as Error).message } : x)));
          }
        }
      });
    },
    [namer, scale, maxSide, debug, detectMethod, modelThreshold, recognizer, cleanup, run],
  );

  const addFiles = async (files: File[]) => {
    // Published files dropped with their manifest (developer path): installed as if downloaded.
    if (files.some((f) => f.name.toLowerCase() === 'manifest.json')) {
      await run('Installing the dropped Scanner files…', async () => {
        const m = await installDropped(files);
        const inst = (await installedFiles()) ?? null;
        setInstalled(inst);
        setPublishedModels(!!inst && !(await missingFiles(inst.manifest, ['detector', 'recognizer'])).length);
        setNotice(m ? `Installed ${m.version}'s ${m.gallery} index of ${m.created.slice(0, 10)} (${m.count.toLocaleString()} pictures).` : null);
      });
      files = files.filter((f) => f.name.toLowerCase() !== 'manifest.json' && !/\.(onnx|bin|gz)$/i.test(f.name));
    }
    const tuned = files.find((f) => /recogni[sz]er.*\.onnx$/i.test(f.name));
    if (tuned && engineRef.current) {
      const bytes = await tuned.arrayBuffer();
      await cacheRecognizer(bytes);
      await dropOtherTuned(tunedModelKey(bytes));
      setTunedCached(true);
      await loadModel('dropped');
    }
    const onnx = files.find((f) => f.name.toLowerCase().endsWith('.onnx') && f !== tuned);
    if (onnx && engineRef.current) {
      const engine = engineRef.current;
      await run(`Loading the card detector ${onnx.name}…`, async () => {
        const bytes = await onnx.arrayBuffer();
        await cacheDetector(bytes);
        const r = await engine.call({ type: 'loadDetector', bytes }, [bytes]);
        setDetector({ ...r, from: 'dropped file' });
        setDetectMethod('model');
      });
    }
    const json = files.find((f) => f.name.toLowerCase().endsWith('.json') && !/^card-(detector|recognizer)\.json$/i.test(f.name));
    if (json) {
      try {
        const parsed = parseLabels(await json.text());
        const drafted = new Set((await labelDrafts()).map((d) => d.file));
        const next = { ...labelsRef.current };
        let kept = 0;
        for (const [f, l] of Object.entries(parsed)) {
          if (drafted.has(f)) kept++;
          else next[f] = l;
        }
        labelsRef.current = next;
        setLabels(next);
        setNotice(kept ? `${json.name}: ${kept} photo${kept === 1 ? '' : 's'} kept the labels edited here (saved in the browser); the file gave the others.` : null);
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
        { engine: info, backend, models: sourceLabel(modelSource, installed?.manifest.version), against: matchAgainst, references: namer?.size ?? 0, method, photos: scanned.map(photoToJson) },
        null,
        1,
      ),
    [info, backend, modelSource, installed, matchAgainst, namer, method, scanned],
  );
  const eta = build && build.done > 0 ? ((Date.now() - build.startedAt) / build.done) * (build.total - build.done - build.failed) : null;
  const ready = !!info && !!backend;

  // ---- Labelling mode ----

  // Drafts saved in the browser come back (they win over a labels.json dropped later).
  useEffect(() => {
    let cancelled = false;
    Promise.all([labelDrafts(), labelsDownloadedAt()])
      .then(([drafts, at]) => {
        if (cancelled) return;
        const next = { ...labelsRef.current, ...Object.fromEntries(drafts.map((d) => [d.file, withIds(d.labels)])) };
        labelsRef.current = next;
        setLabels(next);
        setLabelUpdated(Object.fromEntries(drafts.map((d) => [d.file, d.updatedAt])));
        setDownloadedAt(at);
      })
      .catch((e: Error) => setError(`Reading the saved labels failed: ${e.message}`));
    return () => {
      cancelled = true;
    };
  }, []);

  const putLabels = useCallback((file: string, next: PhotoLabels) => {
    labelsRef.current = { ...labelsRef.current, [file]: next };
    setLabels(labelsRef.current);
    setLabelUpdated((u) => ({ ...u, [file]: Date.now() }));
    const size = photosRef.current.find((x) => x.file.name === file)?.file.size ?? 0;
    void saveLabelDraft(file, size, next).catch((e: Error) => setError(`Saving the labels failed: ${e.message}`));
  }, []);
  const editCards = useCallback(
    (file: string, fn: (cards: LabelCard[]) => LabelCard[]) => {
      const cur = labelsRef.current[file];
      if (cur) putLabels(file, { ...cur, cards: fn(cur.cards) });
    },
    [putLabels],
  );
  const setMatch = (file: string, id: string, m: CardMatchView) =>
    setMatches((all) => {
      const next = new Map(all[file] ?? []);
      next.set(id, m);
      return { ...all, [file]: next };
    });

  // The photo being labelled stays loaded in the engine (full resolution) to name edited corners.
  // One engine job at a time: loading a photo and naming its cards must not interleave.
  const editPhoto = useRef<{ url: string; id: string } | null>(null);
  const editQueue = useRef<Promise<unknown>>(Promise.resolve());
  const releaseEditPhoto = () => {
    const old = editPhoto.current;
    editPhoto.current = null;
    if (old) void engineRef.current?.call({ type: 'releasePhoto', photoId: old.id }).catch(() => undefined);
  };
  const nameAt = (file: string, quads: Quad[]) => {
    const job = editQueue.current.then(async () => {
      const engine = engineRef.current;
      const p = photosRef.current.find((x) => x.file.name === file);
      if (!engine || !p) throw new Error('The photo or the engine is gone');
      if (editPhoto.current?.url !== p.url) {
        releaseEditPhoto();
        const bitmap = await createImageBitmap(p.file, { imageOrientation: 'from-image' });
        const id = `edit-${Date.now()}`;
        await engine.call({ type: 'loadPhoto', photoId: id, bitmap }, [bitmap]);
        editPhoto.current = { url: p.url, id };
      }
      return nameQuads(engine, editPhoto.current!.id, quads, namerRef.current);
    });
    editQueue.current = job.catch(() => undefined);
    setNaming((n) => n + 1);
    return job.finally(() => setNaming((n) => n - 1));
  };
  useEffect(() => {
    if (view !== 'labels') releaseEditPhoto();
  }, [view]);

  // Opening a photo in the Labels view: a draft from its scan when it has no corners yet (older
  // labels get the corners of their card), else its corners are named once for the cut-outs.
  useEffect(() => {
    if (view !== 'labels' || !shown?.scan) return;
    const file = shown.file.name;
    const cur = labelsRef.current[file];
    if (!cur?.cards.some((c) => c.quad)) {
      const draft = draftFromScan(shown.scan, method, cur?.cards);
      putLabels(file, draft.photo);
      setMatches((all) => ({ ...all, [file]: draft.matches }));
      return;
    }
    const have = matchesRef.current[file];
    const todo = cur.cards.filter((c) => c.quad && !have?.has(c.id!));
    if (!todo.length || !namerRef.current?.size) return;
    nameAt(
      file,
      todo.map((c) => c.quad!),
    ).then(
      (res) => res.forEach((r, k) => setMatch(file, todo[k].id!, { crop: r.crop, heightPx: r.heightPx, result: r.byMethod[method] })),
      (e: Error) => setError(e.message),
    );
  }, [view, shown?.url, shown?.scan]);

  /** Names a card again after its corners changed. A print given by a person stays (and its way up,
   * unless the corners were just clicked and the match agrees on the name); else the best match is taken. */
  const renameCard = async (file: string, id: string, quad: Quad, clicked: boolean) => {
    try {
      const [r] = await nameAt(file, [quad]);
      const res = r.byMethod[method];
      setMatch(file, id, { crop: r.crop, heightPx: r.heightPx, result: res });
      editCards(file, (cards) =>
        cards.map((c) => {
          if (c.id !== id) return c;
          if (!c.manual) return { ...c, ...fromMatch(quad, res) };
          const top = res?.candidates[0];
          const turn = clicked && !!res?.turned && !!top && sameName(c.name, top.name);
          return { ...c, quad: turn ? turnQuad(quad) : quad };
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const shownFile = shown?.file.name ?? '';
  const shownLabels = labels[shownFile];
  const colorOf = (c: LabelCard) => {
    if (c.checked) return theme.colors.blue[6];
    const r = c.id ? matches[shownFile]?.get(c.id)?.result : undefined;
    if (!r) return theme.colors.gray[6];
    const conf = confidence(r, method, shown?.scan?.recognizer);
    return theme.colors[conf === 'sure' ? 'green' : conf === 'review' ? 'orange' : 'red'][6];
  };
  const onQuadChange = (id: string, quad: Quad) => {
    editCards(shownFile, (cards) => cards.map((c) => (c.id === id ? { ...c, quad } : c)));
    void renameCard(shownFile, id, quad, false);
  };
  const onAdded = (quad: Quad) => {
    const target = adding;
    setAdding(null);
    if (target === 'new') {
      const id = newLabelId();
      editCards(shownFile, (cards) => [...cards, { id, name: '?', quad }]);
      setLabelSel(id);
      void renameCard(shownFile, id, quad, true);
    } else if (target) {
      editCards(shownFile, (cards) => cards.map((c) => (c.id === target ? { ...c, quad } : c)));
      setLabelSel(target);
      void renameCard(shownFile, target, quad, true);
    }
  };
  const deleteLabel = (id: string) => {
    editCards(shownFile, (cards) => cards.filter((c) => c.id !== id));
    if (labelSel === id) setLabelSel(null);
  };
  const turnLabel = (id: string) => {
    const c = shownLabels?.cards.find((x) => x.id === id);
    if (!c?.quad) return;
    const quad = turnQuad(c.quad);
    // Turned by a person: the print and this way up are kept.
    editCards(shownFile, (cards) => cards.map((x) => (x.id === id ? { ...x, quad, manual: true } : x)));
    void renameCard(shownFile, id, quad, false);
  };
  const nextUnchecked = () => {
    if (!photos.length) return;
    const at = Math.max(0, photos.findIndex((p) => p.url === current));
    for (let k = 1; k <= photos.length; k++) {
      const p = photos[(at + k) % photos.length];
      const l = labels[p.file.name];
      if (!l || !photoChecked(l)) {
        setCurrent(p.url);
        setLabelSel(null);
        setAdding(null);
        return;
      }
    }
  };
  // Keys in the Labels view (not while typing in a field).
  useEffect(() => {
    if (view !== 'labels') return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key === 'a' || e.key === 'A') setAdding('new');
      else if (e.key === 'Escape') {
        setAdding(null);
        setLabelSel(null);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && labelSel) {
        e.preventDefault();
        deleteLabel(labelSel);
      } else if (e.key === 'n' || e.key === 'N') nextUnchecked();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const downloadLabels = async () => {
    const all: Labels = { ...labelsRef.current };
    for (const d of await labelDrafts()) all[d.file] ??= d.labels;
    downloadText('labels.json', serializeLabels(all), 'application/json');
    const at = Date.now();
    await markLabelsDownloaded(at);
    setDownloadedAt(at);
  };
  const labelledPhotos = Object.values(labels).filter((l) => l.cards.length);
  const checkedPhotos = labelledPhotos.filter(photoChecked).length;
  const notDownloaded = Object.values(labelUpdated).filter((t) => t > downloadedAt).length;
  const hasTruth = Object.values(labels).some((l) => truthOf(l)?.length);

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
      {notice && (
        <Alert color="blue" withCloseButton onClose={() => setNotice(null)}>
          {notice}
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
              Recognition: {modelSource === 'dino' ? DINO_FILE.label : `tuned model (${sourceLabel(modelSource, installed?.manifest.version)})`}:{' '}
              {backend ? `running on ${backend === 'webgpu' ? 'WebGPU' : 'the CPU'}` : modelSource !== 'dino' || modelCached ? 'not started' : `not downloaded (${mb(DINO_FILE.bytes)})`}
            </Text>
            <SegmentedControl
              size="xs"
              value={modelSource}
              onChange={(v) => void switchSource(v as ModelSource)}
              data={[
                { value: 'published', label: `Published${installed ? ` ${installed.manifest.version}` : ''}`, disabled: !publishedModels },
                { value: 'dropped', label: 'Dropped files', disabled: !tunedCached },
                { value: 'dino', label: 'DINOv2 (download)' },
              ]}
              disabled={!!busy}
            />
            <Text size="sm">
              Card detector:{' '}
              {detector ? `trained model loaded (${detector.from}, input ${detector.size} px, on ${detector.backend === 'webgpu' ? 'WebGPU' : 'the CPU'})` : 'none: download the Scanner files, or drop card-detector.onnx (from the scanner trainer) on the photos box'}
            </Text>
            <Group>
              <Button size="xs" onClick={() => void loadModel()} disabled={!info || !!busy || !!backend}>
                {modelSource !== 'dino' || modelCached ? 'Start the model' : 'Download and start the model'}
              </Button>
              {readyIn !== null && (
                <Text size="xs" c="dimmed">
                  Ready {(readyIn / 1000).toFixed(1)} s after opening
                </Text>
              )}
            </Group>
          </Stack>
        </Card>
        <Card withBorder>
          <Stack gap={6}>
            <Text fw={600}>2. What cards are named against</Text>
            <SegmentedControl
              size="xs"
              value={matchAgainst}
              onChange={(v) => setMatchAgainst(v as MatchAgainst)}
              data={[
                { value: 'every', label: 'Every print' },
                { value: 'mine', label: 'Only my prints' },
                { value: 'built', label: 'Built here (my prints)' },
              ]}
            />
            {matchAgainst !== 'built' ? (
              <>
                <Text size="sm">
                  {printIndex
                    ? `${printIndex.installed.manifest.version} index of ${printIndex.installed.manifest.created.slice(0, 10)}${printIndex.installed.manifest.gallery !== 'every-print' ? ` (${printIndex.installed.manifest.gallery})` : ''}: ${(printIndex.mask ? printIndex.mask.reduce((a, b) => a + b, 0) : printIndex.prints.length).toLocaleString()} of ${printIndex.prints.length.toLocaleString()} pictures · ${printIndex.info.kind}-${printIndex.info.dims} · search on ${printIndex.info.backend === 'webgpu' ? 'WebGPU' : 'the CPU'} · opened in ${(printIndex.ms / 1000).toFixed(1)} s`
                    : installed
                      ? 'Opening the index…'
                      : 'Not downloaded yet'}
                </Text>
                {printIndex && backend && !indexFits && (
                  <Text size="sm" c="orange">
                    This index goes with {printIndex.installed.manifest.version}'s recognizer, not the one running: cards are named against the reference set built here.
                  </Text>
                )}
                <Text size="xs" c="dimmed">
                  {latest?.manifest
                    ? `On Hugging Face: ${latest.manifest.version} index of ${latest.manifest.created.slice(0, 10)}, ${latest.manifest.count.toLocaleString()} pictures (checked ${new Date(latest.at).toLocaleString()})`
                    : latest?.error
                      ? `Hugging Face: ${latest.error}`
                      : 'Not checked on Hugging Face yet'}
                </Text>
                {(indexUpdate || pendingInstall) && (
                  <Text size="xs" c="dimmed">
                    {indexUpdate
                      ? `Updating the every-print index in the background (${mb(indexUpdate.done)} of ${mb(indexUpdate.total)})…`
                      : 'A newer index is ready: it replaces this one when the scan ends.'}
                  </Text>
                )}
                <Group>
                  {latest?.manifest && latest.commit !== installed?.commit && !indexUpdate && !pendingInstall && (
                    <Button size="xs" onClick={() => void downloadFiles()} disabled={!info || !!busy}>
                      {installed ? 'Update' : 'Download'} ({mb(Object.values(latest.manifest.files).filter((f) => !installed || !Object.values(installed.manifest.files).some((g) => g.sha256 === f.sha256)).reduce((t, f) => t + f.bytes, 0))})
                    </Button>
                  )}
                  <Button size="xs" variant="default" onClick={() => void checkNow()} loading={checking} disabled={!!busy}>
                    Check for update
                  </Button>
                </Group>
              </>
            ) : (
              <>
                <Text size="sm">
                  {account ? `${accountLabel(account)}: ` : ''}
                  {prints ? `${prints.length.toLocaleString()} prints in the synced collection` : accountKey ? 'Reading the collection…' : 'No account: sync your collection first'}
                </Text>
                <Text size="sm">
                  {index ? `${index.size.toLocaleString()} card pictures have vectors (${index.prints.filter((p) => p.back).length.toLocaleString()} of them back faces)` : '…'}
                </Text>
                {build && (
                  <>
                    <Progress value={build.total ? (100 * (build.done + build.failed)) / build.total : 100} />
                    <Text size="xs" c="dimmed">
                      {build.done.toLocaleString()} of {build.total.toLocaleString()} new pictures
                      {build.failed ? ` · ${build.failed} failed` : ''}
                      {build.skipped ? ` · ${build.skipped.toLocaleString()} already done` : ''}
                      {eta !== null && build.done + build.failed < build.total ? ` · about ${Math.ceil(eta / 60000)} min left` : ''}
                    </Text>
                  </>
                )}
                <Group>
                  <Button size="xs" onClick={() => void buildRefs()} disabled={!ready || !prints?.length || building}>
                    {index?.size ? 'Add missing prints' : 'Build the reference set'}
                  </Button>
                  {building && (
                    <Button size="xs" variant="default" onClick={() => buildAbort.current?.abort()}>
                      Stop
                    </Button>
                  )}
                </Group>
              </>
            )}
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
            <input type="file" multiple accept="image/*,.json,application/json,.onnx" onChange={(e) => void addFiles([...(e.currentTarget.files ?? [])])} disabled={!ready} />
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
            <Select
              size="xs"
              w={190}
              label="Find cards with"
              value={detectMethod}
              onChange={(v) => v && setDetectMethod(v as DetectMethod)}
              data={[
                { value: 'classic', label: 'Classic (edges, lines)' },
                { value: 'model', label: 'Trained detector', disabled: !detector },
                { value: 'both', label: 'Both', disabled: !detector },
              ]}
            />
            <NumberInput size="xs" w={130} label="Detector threshold" value={modelThreshold} onChange={(v) => setModelThreshold(Number(v) || 0.2)} min={0.05} max={0.95} step={0.05} decimalScale={2} disabled={!detector} />
            <NumberInput size="xs" w={150} label="Detection size (px)" value={maxSide} onChange={(v) => setMaxSide(Number(v) || 2000)} min={600} max={4000} step={200} />
            <NumberInput size="xs" w={170} label="Warn below (card px tall)" value={minHeightPx} onChange={(v) => setMinHeightPx(Number(v) || 0)} min={0} step={50} />
            <Checkbox size="xs" label="Keep debug layers" checked={debug} onChange={(e) => setDebug(e.currentTarget.checked)} />
            <Checkbox size="xs" label="Drop bad shapes" checked={cleanup} onChange={(e) => setCleanup(e.currentTarget.checked)} title="Once named: an outline around neighbours, or a second outline of one card (see Rejected shapes)" />
            <Button size="xs" variant="default" disabled={!ready || !photos.length || !!busy} onClick={() => void scanAll(photos)}>
              Scan all again
            </Button>
          </Group>
          <Text size="xs" c="dimmed">
            {photos.length} photo{photos.length === 1 ? '' : 's'}
            {labelledPhotos.length ? ` · labels for ${labelledPhotos.length} (${checkedPhotos} checked)` : ' · no labels yet'}
            {!namer?.size ? ' · nothing to name cards against yet: cards are found but not named' : ''}
          </Text>
        </Stack>
      </Card>

      {busy && (
        <Card withBorder>
          <Text size="sm">{busy.label}</Text>
          {busy.progress !== undefined && <Progress value={busy.progress} mt={4} />}
        </Card>
      )}

      {hasTruth && scanned.length > 0 && (
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
              <Stack gap={2}>
                <Text size="xs">View</Text>
                <SegmentedControl
                  size="xs"
                  value={view}
                  onChange={(v) => {
                    setView(v as 'results' | 'labels');
                    setAdding(null);
                  }}
                  data={[
                    { value: 'results', label: 'Results' },
                    { value: 'labels', label: 'Labels' },
                  ]}
                />
              </Stack>
              <Select size="xs" w={240} label="Method shown" value={method} onChange={(v) => v && setMethod(v)} data={ALL_METHODS.map((m) => ({ value: m.id, label: m.label }))} />
              <Checkbox size="xs" label="Edges" checked={showEdges} onChange={(e) => setShowEdges(e.currentTarget.checked)} />
              <Checkbox size="xs" label="Rejected shapes" checked={showRejected} onChange={(e) => setShowRejected(e.currentTarget.checked)} />
              {!hasTruth && !!scanned.length && (
                <CopyButton value={resultsJson}>{({ copied, copy }) => <Button size="xs" variant="default" onClick={copy}>{copied ? 'Copied' : 'Copy results JSON'}</Button>}</CopyButton>
              )}
            </Group>
            {shown?.error && <Alert color="red">{shown.error}</Alert>}
            {shown?.scan && view === 'labels' && shownLabels && (
              <>
                <Group gap="sm" align="flex-end">
                  <Button size="xs" variant={adding === 'new' ? 'filled' : 'default'} onClick={() => setAdding(adding === 'new' ? null : 'new')}>
                    {adding === 'new' ? 'Click its 4 corners… (Esc)' : 'Add a card (A)'}
                  </Button>
                  <Button size="xs" variant="default" onClick={() => editCards(shownFile, (cards) => cards.map((c) => ({ ...c, checked: true })))}>
                    Mark all checked
                  </Button>
                  <Button size="xs" variant="default" onClick={nextUnchecked}>
                    Next photo to check (N)
                  </Button>
                  <Stack gap={2}>
                    <Text size="xs">Zoom</Text>
                    <SegmentedControl size="xs" value={zoom} onChange={setZoom} data={['1', '2', '4'].map((z) => ({ value: z, label: z === '1' ? 'Fit' : `${z}×` }))} />
                  </Stack>
                  <Button size="xs" onClick={() => void downloadLabels()}>
                    Download labels.json{notDownloaded ? ` (${notDownloaded} changed)` : ''}
                  </Button>
                  {naming > 0 && (
                    <Text size="xs" c="dimmed">
                      Naming…
                    </Text>
                  )}
                </Group>
                <Text size="xs" c="dimmed">
                  {shownLabels.cards.length} cards · {shownLabels.cards.filter((c) => c.checked).length} checked · {shownLabels.cards.filter((c) => !c.quad && !c.hidden).length} need an outline ·{' '}
                  {photoChecked(shownLabels) ? 'photo checked' : 'photo not checked yet'} · {checkedPhotos} of {labelledPhotos.length} photos checked. Outline every card whole, where it lies (even
                  under others); tick "Mostly hidden" when little of it shows. The filled corner is the card's own top-left. Keys: <Kbd>A</Kbd> add, <Kbd>Del</Kbd> delete the selected card,{' '}
                  <Kbd>Esc</Kbd> cancel, <Kbd>N</Kbd> next photo to check. Labels are saved in this browser as you go; download labels.json to keep them.
                </Text>
                {adding && adding !== 'new' && (
                  <Alert color="orange" p="xs">
                    Click the 4 corners of {shownLabels.cards.find((c) => c.id === adding)?.name ?? 'the card'} (Esc to cancel).
                  </Alert>
                )}
                <LabelEditor
                  src={shown.url}
                  width={shownLabels.width ?? Math.round(shown.scan.width / shown.scan.scale)}
                  height={shownLabels.height ?? Math.round(shown.scan.height / shown.scan.scale)}
                  cards={shownLabels.cards}
                  colorOf={colorOf}
                  selected={labelSel}
                  onSelect={setLabelSel}
                  onQuadChange={onQuadChange}
                  adding={!!adding}
                  onAdded={onAdded}
                  zoom={Number(zoom)}
                />
                <LabelsTable
                  cards={shownLabels.cards}
                  matches={matches[shownFile]}
                  colorOf={colorOf}
                  prints={namer?.prints ?? prints ?? []}
                  selected={labelSel}
                  onSelect={setLabelSel}
                  onChange={(id, patch) => editCards(shownFile, (cards) => cards.map((c) => (c.id === id ? { ...c, ...patch } : c)))}
                  onDelete={deleteLabel}
                  onTurn={turnLabel}
                  onOutline={(id) => {
                    setLabelSel(id);
                    setAdding(id);
                  }}
                />
              </>
            )}
            {shown?.scan && view === 'results' && (
              <>
                <Text size="xs" c="dimmed">
                  {shown.scan.width} × {shown.scan.height} px scanned ({Math.round(shown.scan.scale * 100)} %) · {shown.scan.cards.length} cards ·{' '}
                  {shown.scan.cards.filter((c) => c.source === 'grid').length} from the binder grid · load {Math.round(shown.scan.timings.loadMs)} ms · detect{' '}
                  {Math.round(shown.scan.timings.detectMs)} ms · cards {Math.round(shown.scan.timings.cardsMs)} ms
                </Text>
                <PhotoView photo={shown.scan} src={shown.url} method={method} selected={selected} onSelect={setSelected} showEdges={showEdges} showRejected={showRejected} />
                <CardsTable photo={shown.scan} method={method} labels={truthOf(labels[shown.scan.file])} selected={selected} onSelect={setSelected} minHeightPx={minHeightPx} />
              </>
            )}
            {shown && !shown.scan && !shown.error && <Text size="sm">Not scanned yet.</Text>}
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
