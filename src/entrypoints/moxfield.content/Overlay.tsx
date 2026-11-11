import { useEffect, useRef, useState } from 'react';
// Inlined as a data: URL. A file URL would need web_accessible_resources, which lets any page detect the extension.
import iconUrl from '@/assets/tithies-icon.webp?inline';
import { bridge, type CaptureInfo } from '@/lib/page-bridge';
import { describeQuery, groupPrints, isEligible } from '@/lib/moxfield/normalize';
import { onMessage, sendMessage } from '@/lib/messaging';
import { getSettings, overlayCollapsedItem as collapsedItem } from '@/lib/settings';
import type { RunProgress } from '@/features/f2f-buylist/types';

type Phase =
  | { kind: 'idle' }
  | { kind: 'reading'; page: number; totalPages: number; fetched: number }
  | { kind: 'starting' }
  | { kind: 'run'; progress: RunProgress }
  | { kind: 'error'; message: string };

const money = (n: number) => n.toLocaleString('en-CA', { style: 'currency', currency: 'CAD' });
const ACTIVE = new Set(['queued', 'running']);

export function Overlay() {
  const [capture, setCapture] = useState<CaptureInfo>({ hasCapture: false });
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  // null until read from storage, so a minimised panel doesn't flash open on page load.
  const [collapsed, setCollapsed] = useState<boolean | null>(null);
  const [summary, setSummary] = useState<string>('');
  const runIdRef = useRef<number | null>(null);

  useEffect(() => {
    const offs = [
      bridge.onMessage('captureUpdated', ({ data }) => setCapture(data)),
      bridge.onMessage('collectionProgress', ({ data }) => setPhase({ kind: 'reading', ...data })),
      onMessage('runProgress', ({ data }) => {
        if (runIdRef.current == null || data.runId === runIdRef.current) {
          runIdRef.current = data.runId;
          setPhase({ kind: 'run', progress: data });
        }
      }),
    ];
    const poll = setInterval(() => void bridge.sendMessage('getCaptureInfo', undefined).then(setCapture).catch(() => {}), 1500);
    void bridge.sendMessage('getCaptureInfo', undefined).then(setCapture).catch(() => {});
    // Re-attach to a run started from this tab earlier (e.g. after the overlay remounted).
    void sendMessage('getProgress', {}).then((p) => {
      if (p && ACTIVE.has(p.status)) {
        runIdRef.current = p.runId;
        setPhase({ kind: 'run', progress: p });
      }
    });
    return () => {
      offs.forEach((off) => off());
      clearInterval(poll);
    };
  }, []);

  useEffect(() => {
    void collapsedItem.getValue().then(setCollapsed);
    return collapsedItem.watch((value) => setCollapsed(value ?? false));
  }, []);

  useEffect(() => {
    if (capture.url) setSummary(describeQuery(capture.url).summary);
  }, [capture.url]);

  const busy = phase.kind === 'reading' || phase.kind === 'starting' || (phase.kind === 'run' && ACTIVE.has(phase.progress.status));

  async function start() {
    try {
      const settings = await getSettings();
      setPhase({ kind: 'reading', page: 0, totalPages: 0, fetched: 0 });
      const res = await bridge.sendMessage('fetchCollection', { pageSize: settings.moxfieldPageSize, delayMs: 350 });
      const eligible = res.entries.filter(isEligible);
      if (!eligible.length) {
        setPhase({ kind: 'error', message: `No English, non-proxy cards in this view (${res.entries.length} rows read).` });
        return;
      }
      setPhase({ kind: 'starting' });
      const { query, summary: s } = describeQuery(res.url);
      const { runId, prints } = await sendMessage('startRun', {
        source: { url: res.url, pageUrl: location.href, query, summary: s },
        entries: eligible,
      });
      runIdRef.current = runId;
      setPhase({
        kind: 'run',
        progress: { runId, status: 'queued', phase: 'bulk_rates', done: 0, total: prints, buylistPrints: 0, buylistCash: 0, buylistCredit: 0 },
      });
    } catch (e) {
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  const open = () => void sendMessage('openDashboard', { runId: runIdRef.current ?? undefined });
  const control = (action: 'pause' | 'resume') =>
    runIdRef.current != null && void sendMessage('controlRun', { runId: runIdRef.current, action });

  const minimise = (value: boolean) => {
    setCollapsed(value);
    void collapsedItem.setValue(value);
  };

  if (collapsed === null) return null;
  if (collapsed) {
    return (
      <button className="ti-fab" title="Show the Tithies panel" aria-label="Show the Tithies panel" onClick={() => minimise(false)}>
        <img src={iconUrl} alt="" />
      </button>
    );
  }

  let body: React.ReactNode = null;
  let pct = 0;
  if (phase.kind === 'reading') {
    pct = phase.totalPages ? (phase.page / phase.totalPages) * 100 : 0;
    body = <div className="ti-line">Reading Moxfield collection… page {phase.page}/{phase.totalPages || '?'} ({phase.fetched} rows)</div>;
  } else if (phase.kind === 'starting') {
    body = <div className="ti-line">Saving snapshot…</div>;
  } else if (phase.kind === 'run') {
    const p = phase.progress;
    pct = p.total ? (p.done / p.total) * 100 : 0;
    const label =
      p.status === 'completed' ? 'Done' : p.status === 'paused' ? 'Paused' : p.status === 'queued' ? 'Waiting…' : p.status === 'running' ? 'Checking F2F…' : p.status;
    body = (
      <>
        <div className="ti-line">
          <b>{label}</b> {p.done}/{p.total} prints
        </div>
        <div className="ti-line">
          F2F buys <b>{p.buylistPrints}</b> · {money(p.buylistCash)} cash / {money(p.buylistCredit)} credit
        </div>
        {p.message && p.status !== 'completed' && <div className="ti-line ti-warn">{p.message}</div>}
      </>
    );
  } else if (phase.kind === 'error') {
    body = <div className="ti-line ti-error">{phase.message}</div>;
  }

  return (
    <div className="ti-card">
      <div className="ti-header">
        <span className="ti-title">
          <img className="ti-logo" src={iconUrl} alt="" />
          Tithies · Sell to F2F
        </span>
        <button className="ti-icon" title="Minimise" onClick={() => minimise(true)}>
          –
        </button>
      </div>
      <div className="ti-line ti-dim" title={capture.url}>
        {capture.hasCapture ? `Filters: ${summary}` : 'Waiting for Moxfield to load your collection…'}
      </div>
      {body}
      {(phase.kind === 'reading' || phase.kind === 'run') && (
        <div className="ti-progress">
          <div className="ti-bar" style={{ width: `${Math.min(100, pct).toFixed(1)}%` }} />
        </div>
      )}
      <div className="ti-actions">
        <button className="ti-btn ti-primary" disabled={!capture.hasCapture || busy} onClick={start}>
          Check selling prices on F2F
        </button>
        {phase.kind === 'run' && ACTIVE.has(phase.progress.status) && (
          <button className="ti-btn" onClick={() => control('pause')}>
            Pause
          </button>
        )}
        {phase.kind === 'run' && phase.progress.status === 'paused' && (
          <button className="ti-btn" onClick={() => control('resume')}>
            Resume
          </button>
        )}
        <button className="ti-btn" onClick={open}>
          {phase.kind === 'run' ? 'Open results' : 'Dashboard'}
        </button>
      </div>
      <div className="ti-line ti-dim">English, non-proxy cards only · NM prices</div>
    </div>
  );
}
