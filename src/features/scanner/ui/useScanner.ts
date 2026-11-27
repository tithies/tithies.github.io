/**
 * The Scanner page's runtime, on the published files only (the developer page, ScannerPage, also runs dropped files,
 * DINOv2 and a reference set built here): the engine, the files downloaded once from Hugging Face (published.ts), the
 * detector and recognizer started from them, the every-print index (all prints, or only the account's), the OCR
 * models of the print and language check, and the updates (a new index alone downloads by itself and replaces the
 * open one between jobs; new models wait for the user's "Update").
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCurrentAccount } from '@/lib/accounts/AccountProvider';
import { accountData } from '@/lib/accounts/data';
import { ScannerEngine } from '../engine-client';
import { printIndexNamer, openPrintIndex, setOwnedOnly, type PrintIndex } from '../print-index';
import { checkLatest, downloadPublished, eagerRoles, indexOnlyUpdate, installedFiles, missingFiles, readFile, type Installed, type LatestCheck, type Manifest } from '../published';
import type { Namer } from '../pipeline';
import { ownedPrints, type PrintInfo } from '../reference';
import { TextModels } from '../scanner-check';

export type ScannerState = 'starting' | 'needsFiles' | 'downloading' | 'loading' | 'ready' | 'failed';

export interface ScannerRuntime {
  state: ScannerState;
  error: string | null;
  engine: ScannerEngine | null;
  installed: Installed | null;
  latest: LatestCheck | null;
  /** Bytes still to download for the files (the first download, or a model update). */
  needed: number | null;
  /** Download progress. */
  progress: { done: number; total: number } | null;
  /** A newer version with new models: it waits for `getFiles`. */
  modelUpdate: boolean;
  /** A new index alone is downloading in the background. */
  indexUpdating: boolean;
  printIndex: PrintIndex | null;
  namer: Namer | null;
  textModels: TextModels | null;
  /** WebGPU or WASM (CPU), where the recognizer runs. */
  backend: 'webgpu' | 'wasm' | null;
  onlyMine: boolean;
  setOnlyMine: (on: boolean) => void;
  /** Downloads (or updates) the files, then starts their models. */
  getFiles: () => Promise<void>;
  checkNow: () => Promise<void>;
  /** Ready, in ms after the page opened. */
  readyIn: number | null;
}

/** The same install (read again from storage): kept as is, so what depends on it (the open index) stays. */
const sameInstall = (a: Installed | null, b: Installed | null) => !!a && !!b && a.commit === b.commit && a.installedAt === b.installedAt && a.manifest.created === b.manifest.created;

/** Bytes of the files a manifest needs that aren't stored here yet. */
async function bytesNeeded(m: Manifest): Promise<number> {
  const missing = await missingFiles(m, eagerRoles(m));
  return missing.reduce((s, r) => s + (m.files[r]?.bytes ?? 0), 0);
}

/** `idle`: no scan job is running (a new index is swapped in only then). */
export function useScanner(idle: boolean): ScannerRuntime {
  const { account } = useCurrentAccount();
  const accountKey = account?.key ?? null;
  const [engine, setEngine] = useState<ScannerEngine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [installed, setInstalled] = useState<Installed | null>(null);
  const [checkedInstall, setCheckedInstall] = useState(false);
  const [latest, setLatest] = useState<LatestCheck | null>(null);
  const [needed, setNeeded] = useState<number | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [backend, setBackend] = useState<'webgpu' | 'wasm' | null>(null);
  const [detectorOn, setDetectorOn] = useState(false);
  /** The running models' version (its manifest's recognizer hash): the index must be from the same. */
  const [modelsSha, setModelsSha] = useState<string | null>(null);
  const [printBase, setPrintBase] = useState<PrintIndex | null>(null);
  const [printIndex, setPrintIndex] = useState<PrintIndex | null>(null);
  const [onlyMine, setOnlyMine] = useState(false);
  const [prints, setPrints] = useState<PrintInfo[] | null>(null);
  const [indexUpdating, setIndexUpdating] = useState(false);
  const [pendingInstall, setPendingInstall] = useState<Installed | null>(null);
  const [readyIn, setReadyIn] = useState<number | null>(null);
  const openedAt = useRef(performance.now());
  const updating = useRef(false);

  /** Starts the stored install's detector and recognizer (read from the stored install, which a download just wrote). */
  const startModels = useCallback(async (eng: ScannerEngine) => {
    setLoading(true);
    try {
      const inst = (await installedFiles()) ?? null;
      if (!inst) return;
      const [det, rec] = [await readFile(inst.manifest.files.detector), await readFile(inst.manifest.files.recognizer)];
      if (!det || !rec) throw new Error('The Scanner files are incomplete: download them again');
      await eng.call({ type: 'loadDetector', bytes: det }, [det]);
      setDetectorOn(true);
      const r = await eng.call({ type: 'loadModel', bytes: rec }, [rec]);
      setBackend(r.backend);
      setModelsSha(inst.manifest.files.recognizer.sha256);
      setInstalled((cur) => (sameInstall(cur, inst) ? cur : inst));
    } finally {
      setLoading(false);
    }
  }, []);

  // The engine, started on open and closed on leave; the stored files' models started when they're all here.
  useEffect(() => {
    let cancelled = false;
    let started: ScannerEngine | null = null;
    ScannerEngine.start()
      .then(async ({ engine: eng }) => {
        started = eng;
        if (cancelled) return eng.dispose();
        setEngine(eng);
        const inst = (await installedFiles()) ?? null;
        const complete = !!inst && !(await missingFiles(inst.manifest)).length;
        if (cancelled) return;
        setInstalled((cur) => (sameInstall(cur, inst) ? cur : inst));
        setCheckedInstall(true);
        if (complete) await startModels(eng);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setError(`The Scanner didn't start: ${e.message}`);
        setFailed(true);
      });
    void checkLatest().then((l) => !cancelled && setLatest(l));
    return () => {
      cancelled = true;
      started?.dispose();
    };
  }, [startModels]);

  // What a download would take: the newest version's files not stored yet (else the installed version's).
  const target = latest?.manifest ?? installed?.manifest ?? null;
  useEffect(() => {
    if (!target) return setNeeded(null);
    let cancelled = false;
    void bytesNeeded(target).then((b) => !cancelled && setNeeded(b));
    return () => {
      cancelled = true;
    };
  }, [target, installed]);

  const indexOnly = indexOnlyUpdate(installed, latest);
  const modelUpdate = !!installed && !!latest?.manifest && !!latest.commit && latest.commit !== installed.commit && !indexOnly;

  const getFiles = useCallback(async () => {
    const l = latest?.manifest && latest.commit ? latest : await checkLatest({ force: true });
    setLatest(l);
    if (!l.manifest || !l.commit || !engine) {
      setError(l.error ? `Hugging Face can't be reached: ${l.error}` : 'Hugging Face has no Scanner files');
      return;
    }
    setError(null);
    setProgress({ done: 0, total: 1 });
    try {
      await downloadPublished(l.manifest, l.commit, { onProgress: (done, total) => setProgress({ done, total }) });
      await startModels(engine);
    } catch (e) {
      setError(`Downloading the Scanner files: ${(e as Error).message}`);
    } finally {
      setProgress(null);
    }
  }, [latest, engine, startModels]);

  const checkNow = useCallback(async () => {
    const l = await checkLatest({ force: true });
    setLatest(l);
    setError(l.error ? `Checking for an update: ${l.error}` : null);
  }, []);

  // The account's prints, for "only my prints".
  useEffect(() => {
    let cancelled = false;
    setPrints(null);
    if (accountKey)
      void accountData(accountKey)
        .collection.list()
        .then((entries) => !cancelled && setPrints(ownedPrints(entries)));
    return () => {
      cancelled = true;
    };
  }, [accountKey]);

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
      (e: Error) => !cancelled && setError(`The card index didn't open: ${e.message}`),
    );
    return () => {
      cancelled = true;
      opened?.client.dispose();
      setPrintBase(null);
    };
  }, [installed]);
  useEffect(() => {
    if (!printBase) return setPrintIndex(null);
    if (onlyMine && !prints) return;
    let cancelled = false;
    setOwnedOnly(printBase, onlyMine ? prints : null).then(
      (v) => !cancelled && setPrintIndex(v),
      (e: Error) => setError(e.message),
    );
    return () => {
      cancelled = true;
    };
  }, [printBase, onlyMine, prints]);

  // A new index alone (the daily refresh) downloads in the background, and replaces the open one between jobs.
  useEffect(() => {
    if (updating.current || !indexOnly || !latest?.manifest || !latest.commit) return;
    updating.current = true;
    setIndexUpdating(true);
    downloadPublished(latest.manifest, latest.commit)
      .then(async () => setPendingInstall((await installedFiles()) ?? null))
      .catch((e: Error) => setError(`Updating the card index: ${e.message}`))
      .finally(() => {
        updating.current = false;
        setIndexUpdating(false);
      });
  }, [indexOnly, latest]);
  useEffect(() => {
    if (pendingInstall && idle) {
      setInstalled(pendingInstall);
      setPendingInstall(null);
    }
  }, [pendingInstall, idle]);

  // The index goes with the running recognizer (the one that made its vectors).
  const fits = !!printIndex && !!modelsSha && printIndex.installed.manifest.files.recognizer.sha256 === modelsSha;
  const namer = useMemo(() => (printIndex && fits ? printIndexNamer(printIndex) : null), [printIndex, fits]);
  const textModels = useMemo(() => (engine && installed ? new TextModels(engine, installed) : null), [engine, installed]);

  const ready = !!engine && detectorOn && !!backend && !!namer;
  useEffect(() => {
    if (ready && readyIn === null) setReadyIn(performance.now() - openedAt.current);
  }, [ready, readyIn]);

  const state: ScannerState = failed
    ? 'failed'
    : !engine || !checkedInstall
      ? 'starting'
      : progress
        ? 'downloading'
        : ready
          ? 'ready'
          : loading || (installed && !needed)
            ? 'loading'
            : 'needsFiles';

  return { state, error, engine, installed, latest, needed, progress, modelUpdate, indexUpdating, printIndex, namer, textModels, backend, onlyMine, setOnlyMine, getFiles, checkNow, readyIn };
}
