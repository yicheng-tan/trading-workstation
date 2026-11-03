/** Nearest-rank percentile: p in [0, 100]. Input need not be pre-sorted. */
export function percentile(_values: number[], _p: number): number {
  throw new Error('not implemented');
}

export class RollingWindow {
  constructor(_windowMs: number, _now?: () => number) {
    throw new Error('not implemented');
  }

  push(_value: number, _atMs?: number): void {
    throw new Error('not implemented');
  }

  values(): number[] {
    throw new Error('not implemented');
  }

  percentile(_p: number): number | null {
    throw new Error('not implemented');
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

/**
 * Rolling-window performance telemetry: frame cadence (fps / p95 frame time
 * / long-task count) and message-arrival-to-render latency, each decaying
 * out of the window over time. Backs the on-screen perf overlay and the
 * benchmark report required by the PRD.
 */
export class PerfMetrics {
  constructor(_opts?: PerfMetricsOptions) {
    throw new Error('not implemented');
  }

  recordFrame(_frameDurationMs: number, _atMs?: number): void {
    throw new Error('not implemented');
  }

  recordMessageLatency(_latencyMs: number, _atMs?: number): void {
    throw new Error('not implemented');
  }

  get fps(): number {
    throw new Error('not implemented');
  }

  get p95FrameTimeMs(): number | null {
    throw new Error('not implemented');
  }

  get longTaskCount(): number {
    throw new Error('not implemented');
  }

  get p95LatencyMs(): number | null {
    throw new Error('not implemented');
  }

  snapshot(): PerfSnapshot {
    throw new Error('not implemented');
  }
}
