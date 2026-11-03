/** Nearest-rank percentile: p in [0, 100]. Input need not be pre-sorted. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    throw new Error('percentile: values must not be empty');
  }
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank method: rank = ceil(p/100 * N), clamped to [1, N].
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

interface TimestampedSample {
  value: number;
  t: number;
}

/**
 * A rolling buffer of timestamped values that decays samples older than
 * `windowMs` (relative to an injectable clock) every time it's read or
 * pushed to. To avoid a brief polling gap making a live metric look
 * completely blank, the single most-recently-pushed sample is never
 * evicted purely due to age - only superseded once a newer sample exists
 * and the older one(s) fall outside the window.
 */
export class RollingWindow {
  private samples: TimestampedSample[] = [];
  private readonly now: () => number;

  constructor(
    private readonly windowMs: number,
    now: () => number = () => Date.now(),
  ) {
    this.now = now;
  }

  push(value: number, atMs?: number): void {
    const t = atMs ?? this.now();
    this.samples.push({ value, t });
    this.evict();
  }

  values(): number[] {
    this.evict();
    return this.samples.map((s) => s.value);
  }

  percentile(p: number): number | null {
    const vals = this.values();
    if (vals.length === 0) return null;
    return percentile(vals, p);
  }

  private evict(): void {
    const cutoff = this.now() - this.windowMs;
    while (this.samples.length > 1 && this.samples[0].t <= cutoff) {
      this.samples.shift();
    }
  }
}

export interface PerfMetricsOptions {
  frameWindowMs?: number;
  latencyWindowMs?: number;
  longTaskThresholdMs?: number;
  now?: () => number;
}

export interface PerfSnapshot {
  fps: number;
  p95FrameTimeMs: number | null;
  longTaskCount: number;
  p95LatencyMs: number | null;
  sampleCount: number;
}

const DEFAULT_FRAME_WINDOW_MS = 5000;
const DEFAULT_LATENCY_WINDOW_MS = 5000;
const DEFAULT_LONG_TASK_THRESHOLD_MS = 50;

/**
 * Rolling-window performance telemetry: frame cadence (fps / p95 frame time
 * / long-task count) and message-arrival-to-render latency, each decaying
 * out of the window over time. Backs the on-screen perf overlay and the
 * benchmark report required by the PRD.
 */
export class PerfMetrics {
  private readonly longTaskThresholdMs: number;
  private readonly frameWindow: RollingWindow;
  private readonly latencyWindow: RollingWindow;

  constructor(opts: PerfMetricsOptions = {}) {
    const now = opts.now ?? (() => Date.now());
    this.longTaskThresholdMs = opts.longTaskThresholdMs ?? DEFAULT_LONG_TASK_THRESHOLD_MS;
    this.frameWindow = new RollingWindow(opts.frameWindowMs ?? DEFAULT_FRAME_WINDOW_MS, now);
    this.latencyWindow = new RollingWindow(opts.latencyWindowMs ?? DEFAULT_LATENCY_WINDOW_MS, now);
  }

  recordFrame(frameDurationMs: number, atMs?: number): void {
    this.frameWindow.push(frameDurationMs, atMs);
  }

  recordMessageLatency(latencyMs: number, atMs?: number): void {
    this.latencyWindow.push(latencyMs, atMs);
  }

  get fps(): number {
    const values = this.frameWindow.values();
    if (values.length === 0) return 0;
    const avgFrameMs = values.reduce((sum, v) => sum + v, 0) / values.length;
    if (avgFrameMs <= 0) return 0;
    return 1000 / avgFrameMs;
  }

  get p95FrameTimeMs(): number | null {
    return this.frameWindow.percentile(95);
  }

  get longTaskCount(): number {
    return this.frameWindow.values().filter((v) => v > this.longTaskThresholdMs).length;
  }

  get p95LatencyMs(): number | null {
    return this.latencyWindow.percentile(95);
  }

  snapshot(): PerfSnapshot {
    return {
      fps: this.fps,
      p95FrameTimeMs: this.p95FrameTimeMs,
      longTaskCount: this.longTaskCount,
      p95LatencyMs: this.p95LatencyMs,
      sampleCount: this.frameWindow.values().length,
    };
  }
}
