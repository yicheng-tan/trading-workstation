import { percentile } from '../core/perf/PerfMetrics';
import type { PerfMetrics, PerfSnapshot } from '../core/perf/PerfMetrics';

export interface BenchmarkPercentiles {
  p50: number;
  p95: number;
}

export interface BenchmarkReport {
  /** Epoch ms when the benchmark run started. */
  startedAt: number;
  durationMs: number;
  scenario: string;
  fps: { p50: number; p95: number; min: number };
  frameTimeMs: { p50: number; p95: number; max: number };
  /** Worst (max) long-task count observed in any single sampled snapshot during the run. */
  longTaskCount: number;
  latencyMs: BenchmarkPercentiles;
  /** Number of `metrics.snapshot()` samples collected over the run. */
  sampleCount: number;
}

export interface RunBenchmarkOptions {
  /** Total wall-clock duration to sample over. Defaults to 60s per the PRD's reference scenario. */
  durationMs?: number;
  /** Free-form label describing what was running (e.g. "30-panel/10-symbol live", "10x replay"). */
  scenario?: string;
  /** How often to sample `metrics.snapshot()`. Defaults to 500ms. */
  sampleIntervalMs?: number;
  /** Injectable clock, primarily for testability. */
  now?: () => number;
  /** Injectable delay function, primarily for testability. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_DURATION_MS = 60_000;
const DEFAULT_SAMPLE_INTERVAL_MS = 500;

function safePercentile(values: number[], p: number): number {
  return values.length === 0 ? 0 : percentile(values, p);
}

/**
 * Samples a live `PerfMetrics` instance at a fixed cadence over a fixed
 * duration and reduces the samples into a single benchmark report, per the
 * PRD's "what to measure, how to measure it" requirement (deliverable:
 * PERF.md). Intended to be driven from the Perf overlay's "Run 60s
 * Benchmark" button while the reference 30-panel/10-symbol scenario (or a
 * replay-driven stress scenario) is live.
 */
export async function runBenchmark(
  metrics: PerfMetrics,
  opts: RunBenchmarkOptions = {},
): Promise<BenchmarkReport> {
  const durationMs = opts.durationMs ?? DEFAULT_DURATION_MS;
  const sampleIntervalMs = opts.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
  const scenario = opts.scenario ?? 'unspecified';
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const startedAt = now();
  const samples: PerfSnapshot[] = [];
  const elapsed = () => now() - startedAt;

  while (elapsed() < durationMs) {
    samples.push(metrics.snapshot());
    const remaining = durationMs - elapsed();
    await sleep(Math.max(0, Math.min(sampleIntervalMs, remaining)));
  }
  // One final sample right at (or just past) the end of the window.
  samples.push(metrics.snapshot());

  const fpsValues = samples.map((s) => s.fps);
  const frameTimeValues = samples.map((s) => s.p95FrameTimeMs).filter((v): v is number => v !== null);
  const latencyValues = samples.map((s) => s.p95LatencyMs).filter((v): v is number => v !== null);
  const worstLongTaskCount = samples.reduce((max, s) => Math.max(max, s.longTaskCount), 0);

  return {
    startedAt,
    durationMs,
    scenario,
    fps: {
      p50: safePercentile(fpsValues, 50),
      p95: safePercentile(fpsValues, 95),
      min: fpsValues.length ? Math.min(...fpsValues) : 0,
    },
    frameTimeMs: {
      p50: safePercentile(frameTimeValues, 50),
      p95: safePercentile(frameTimeValues, 95),
      max: frameTimeValues.length ? Math.max(...frameTimeValues) : 0,
    },
    longTaskCount: worstLongTaskCount,
    latencyMs: {
      p50: safePercentile(latencyValues, 50),
      p95: safePercentile(latencyValues, 95),
    },
    sampleCount: samples.length,
  };
}

/** Triggers a browser download of a benchmark report as `benchmark-<timestamp>.json`. */
export function downloadBenchmarkReport(report: BenchmarkReport): void {
  const json = JSON.stringify(report, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `benchmark-${report.startedAt}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
