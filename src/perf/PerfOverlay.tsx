import { useEffect, useRef, useState } from 'react';
import { useDataHub } from '../app/DataHubContext';
import type { ConnectionStatus } from '../core/hub/protocol';
import { PerfMetrics, type PerfSnapshot } from '../core/perf/PerfMetrics';
import { fetchServerTimeOffset } from '../core/hub/binanceRest';
import { restBaseUrl } from '../core/hub/hosts';
import { downloadBenchmarkReport, runBenchmark } from './benchmarkRunner';
import './PerfOverlay.css';

/** How often the overlay's visible text re-renders. Decoupled from the rAF loop on purpose. */
const DISPLAY_REFRESH_MS = 500;
/** PRD reference scenario: 30 panels / 10 symbols, 60s sampled benchmark. */
const BENCHMARK_DURATION_MS = 60_000;

interface MemoryInfo {
  usedJSHeapSize: number;
}

function readHeapMb(): number | null {
  const mem = (performance as unknown as { memory?: MemoryInfo }).memory;
  if (!mem || typeof mem.usedJSHeapSize !== 'number') return null;
  return mem.usedJSHeapSize / (1024 * 1024);
}

function fmtMs(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)}ms`;
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: 'Connecting…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  offline: 'Offline',
};

interface OverlayState extends PerfSnapshot {
  connectionStatus: ConnectionStatus;
  heapMb: number | null;
}

/**
 * Small always-available diagnostic overlay: fps / p95 frame time / long
 * task count / p95 message latency / heap usage (Chromium-only) / hub
 * connection status, plus a one-click 60s benchmark export.
 *
 * Perf-sensitive by construction: the rAF loop below only ever writes into
 * refs and feeds `PerfMetrics`; React `setState` is only ever called from
 * the throttled interval, at most twice a second, regardless of how many
 * panels/streams are pushing frames or messages elsewhere in the app.
 */
export default function PerfOverlay() {
  const hub = useDataHub();
  const [expanded, setExpanded] = useState(false);
  const [benchmarkRunning, setBenchmarkRunning] = useState(false);
  const [benchmarkMessage, setBenchmarkMessage] = useState<string | null>(null);

  const metricsRef = useRef<PerfMetrics | null>(null);
  if (metricsRef.current === null) {
    metricsRef.current = new PerfMetrics();
  }

  const lastFrameTsRef = useRef<number | null>(null);
  const rafHandleRef = useRef<number | null>(null);
  const connectionRef = useRef<ConnectionStatus>(hub.getConnectionStatus());

  const [display, setDisplay] = useState<OverlayState>(() => ({
    ...metricsRef.current!.snapshot(),
    connectionStatus: connectionRef.current,
    heapMb: readHeapMb(),
  }));

  // Frame-duration sampling: a raw requestAnimationFrame loop that measures
  // the delta between consecutive frame timestamps and feeds PerfMetrics
  // directly. No React state touched here on every frame.
  useEffect(() => {
    const metrics = metricsRef.current!;
    const loop = (ts: number) => {
      if (lastFrameTsRef.current !== null) {
        metrics.recordFrame(ts - lastFrameTsRef.current);
      }
      lastFrameTsRef.current = ts;
      rafHandleRef.current = requestAnimationFrame(loop);
    };
    rafHandleRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafHandleRef.current !== null) cancelAnimationFrame(rafHandleRef.current);
    };
  }, []);

  // Hub connection status, tracked in a ref so it doesn't force a re-render
  // outside the throttled display tick either.
  useEffect(() => {
    connectionRef.current = hub.getConnectionStatus();
    return hub.onConnectionStatus((status) => {
      connectionRef.current = status;
    });
  }, [hub]);

  // Message-arrival-to-render latency: the shared `!miniTicker@arr` stream
  // (already deduplicated/ref-counted by the hub regardless of which
  // watchlist panels, if any, are open) gives us a cheap, always-available
  // real message stream to sample latency from, as `Date.now() -
  // row.updatedAt` per row, without the overlay needing to know about any
  // specific symbol or panel. `updatedAt` is Binance's event time, so this is
  // exchange-event -> main-thread receipt, corrected for the local clock's
  // offset from Binance's.
  // Each message carries every known row, but Binance only refreshes symbols
  // that traded, so only rows whose event time moved are fresh samples (the
  // first sighting of a symbol may be a cached row, so it only sets a baseline).
  useEffect(() => {
    const metrics = metricsRef.current!;
    const lastSeen = new Map<string, number>();
    // Until the clock offset is known, samples would mostly measure clock skew; drop them.
    let clockOffsetMs: number | null = null;
    let cancelled = false;
    fetchServerTimeOffset(restBaseUrl('primary'))
      .catch(() => fetchServerTimeOffset(restBaseUrl('fallback')))
      .then((offset) => {
        if (!cancelled) clockOffsetMs = offset;
      })
      .catch((err) => console.warn('[PerfOverlay] could not read Binance server time; latency unavailable.', err));
    const unsubscribe = hub.subscribeWatchlist((rows) => {
      const binanceNow = Date.now() + (clockOffsetMs ?? 0);
      for (const row of rows) {
        const prev = lastSeen.get(row.symbol);
        if (prev === row.updatedAt) continue;
        lastSeen.set(row.symbol, row.updatedAt);
        if (prev !== undefined && clockOffsetMs !== null) metrics.recordMessageLatency(Math.max(0, binanceNow - row.updatedAt));
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [hub]);

  // The only place React state is written from a timer: at most 2x/second.
  useEffect(() => {
    const id = window.setInterval(() => {
      setDisplay({
        ...metricsRef.current!.snapshot(),
        connectionStatus: connectionRef.current,
        heapMb: readHeapMb(),
      });
    }, DISPLAY_REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);

  async function handleRunBenchmark() {
    if (benchmarkRunning) return;
    setBenchmarkRunning(true);
    setBenchmarkMessage(`Running ${BENCHMARK_DURATION_MS / 1000}s benchmark…`);
    try {
      const report = await runBenchmark(metricsRef.current!, {
        durationMs: BENCHMARK_DURATION_MS,
        scenario: 'manual-overlay-run',
      });
      downloadBenchmarkReport(report);
      setBenchmarkMessage(`Done - downloaded benchmark-${report.startedAt}.json`);
    } catch (err) {
      setBenchmarkMessage(`Benchmark failed: ${(err as Error).message}`);
    } finally {
      setBenchmarkRunning(false);
    }
  }

  const statusClass = `perf-overlay__status perf-overlay__status--${display.connectionStatus}`;

  return (
    <div className={`perf-overlay${expanded ? ' perf-overlay--expanded' : ''}`}>
      <button
        type="button"
        className="perf-overlay__pill"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        title="Toggle performance overlay"
      >
        <span className={`perf-overlay__dot perf-overlay__dot--${display.connectionStatus}`} />
        Perf · {Math.round(display.fps)}fps
      </button>

      {expanded && (
        <div className="perf-overlay__panel" role="region" aria-label="Performance overlay">
          <div className="perf-overlay__row">
            <span>FPS</span>
            <span>{display.fps.toFixed(1)}</span>
          </div>
          <div className="perf-overlay__row">
            <span>p95 frame time</span>
            <span>{fmtMs(display.p95FrameTimeMs)}</span>
          </div>
          <div className="perf-overlay__row">
            <span>Long tasks ({'>'}50ms)</span>
            <span>{display.longTaskCount}</span>
          </div>
          <div className="perf-overlay__row">
            <span>p95 msg latency</span>
            <span>{fmtMs(display.p95LatencyMs)}</span>
          </div>
          <div className="perf-overlay__row">
            <span>JS heap</span>
            <span>{display.heapMb === null ? 'n/a' : `${display.heapMb.toFixed(1)} MB`}</span>
          </div>
          <div className="perf-overlay__row">
            <span>Connection</span>
            <span className={statusClass}>{STATUS_LABEL[display.connectionStatus]}</span>
          </div>

          <button
            type="button"
            className="perf-overlay__benchmark-btn"
            onClick={handleRunBenchmark}
            disabled={benchmarkRunning}
          >
            {benchmarkRunning ? 'Benchmarking…' : 'Run 60s Benchmark'}
          </button>
          {benchmarkMessage && <div className="perf-overlay__benchmark-msg">{benchmarkMessage}</div>}
        </div>
      )}
    </div>
  );
}
