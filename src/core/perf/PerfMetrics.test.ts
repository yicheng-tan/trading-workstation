import { describe, it, expect } from 'vitest';
import { percentile, RollingWindow, PerfMetrics } from './PerfMetrics';

describe('percentile', () => {
  it('computes the median (p50) of an odd-length array', () => {
    expect(percentile([3, 1, 2], 50)).toBe(2);
  });

  it('computes p95 of 1..100 using nearest-rank', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 95)).toBe(95);
  });

  it('returns the single value for a one-element array at any percentile', () => {
    expect(percentile([42], 10)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });
});

describe('RollingWindow', () => {
  it('evicts values older than the window relative to the injected clock', () => {
    let t = 0;
    const w = new RollingWindow(1000, () => t);
    w.push(10, 0);
    t = 500;
    w.push(20, 500);
    t = 1600; // first sample (t=0) is now outside the 1000ms window
    expect(w.values()).toEqual([20]);
  });

  it('percentile() returns null when there are no samples in the window', () => {
    const w = new RollingWindow(1000, () => 0);
    expect(w.percentile(50)).toBeNull();
  });
});

describe('PerfMetrics', () => {
  it('reports ~60fps for a steady 16.7ms frame cadence', () => {
    let t = 0;
    const pm = new PerfMetrics({ now: () => t });
    for (let i = 0; i < 30; i++) {
      pm.recordFrame(16.7, t);
      t += 16.7;
    }
    expect(pm.fps).toBeGreaterThan(55);
    expect(pm.fps).toBeLessThan(65);
  });

  it('counts long tasks only for frames exceeding the threshold', () => {
    const pm = new PerfMetrics({ now: () => 0, longTaskThresholdMs: 50 });
    pm.recordFrame(10, 0);
    pm.recordFrame(60, 0);
    pm.recordFrame(20, 0);
    pm.recordFrame(120, 0);
    expect(pm.longTaskCount).toBe(2);
  });

  it('computes p95 frame time from recorded samples', () => {
    const pm = new PerfMetrics({ now: () => 0 });
    for (let i = 1; i <= 100; i++) pm.recordFrame(i, 0);
    expect(pm.p95FrameTimeMs).toBe(95);
  });

  it('computes p95 message latency from recorded samples', () => {
    const pm = new PerfMetrics({ now: () => 0 });
    for (let i = 1; i <= 100; i++) pm.recordMessageLatency(i, 0);
    expect(pm.p95LatencyMs).toBe(95);
  });

  it('decays old samples out of the frame window over time', () => {
    let t = 0;
    const pm = new PerfMetrics({ now: () => t, frameWindowMs: 1000 });
    pm.recordFrame(16.7, 0);
    t = 2000; // past the window
    pm.recordFrame(16.7, 2000);
    expect(pm.snapshot().sampleCount).toBe(1);
  });

  it('snapshot() is consistent with the individual getters', () => {
    const pm = new PerfMetrics({ now: () => 0 });
    pm.recordFrame(16.7, 0);
    pm.recordMessageLatency(30, 0);
    const snap = pm.snapshot();
    expect(snap.fps).toBe(pm.fps);
    expect(snap.p95FrameTimeMs).toBe(pm.p95FrameTimeMs);
    expect(snap.p95LatencyMs).toBe(pm.p95LatencyMs);
    expect(snap.longTaskCount).toBe(pm.longTaskCount);
  });
});
