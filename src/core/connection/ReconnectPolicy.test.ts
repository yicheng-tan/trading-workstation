import { describe, it, expect } from 'vitest';
import { ReconnectPolicy } from './ReconnectPolicy';

describe('ReconnectPolicy', () => {
  it('returns the base delay and stays on primary for the first failure', () => {
    const rp = new ReconnectPolicy({ baseDelayMs: 500, jitterRatio: 0, random: () => 0.5 });
    const d = rp.recordFailure('primary');
    expect(d.nextHost).toBe('primary');
    expect(d.delayMs).toBe(500);
  });

  it('escalates delay exponentially on consecutive failures, capped at maxDelayMs', () => {
    const rp = new ReconnectPolicy({ baseDelayMs: 500, maxDelayMs: 4000, jitterRatio: 0, random: () => 0.5 });
    const d1 = rp.recordFailure('primary').delayMs;
    const d2 = rp.recordFailure('primary').delayMs;
    const d3 = rp.recordFailure('primary').delayMs;
    const d4 = rp.recordFailure('primary').delayMs;
    expect(d2).toBeGreaterThan(d1);
    expect(d3).toBeGreaterThan(d2);
    expect(d4).toBeLessThanOrEqual(4000);
  });

  it('applies jitter within +/- jitterRatio of the computed base delay', () => {
    const rp = new ReconnectPolicy({ baseDelayMs: 1000, jitterRatio: 0.2, random: () => 1 }); // max jitter
    const d = rp.recordFailure('primary').delayMs;
    expect(d).toBeLessThanOrEqual(1200);
    expect(d).toBeGreaterThanOrEqual(800);
  });

  it('switches to the fallback host after the configured number of consecutive primary failures', () => {
    const rp = new ReconnectPolicy({ maxPrimaryFailuresBeforeFallback: 3, jitterRatio: 0, random: () => 0 });
    rp.recordFailure('primary');
    rp.recordFailure('primary');
    const third = rp.recordFailure('primary');
    expect(third.nextHost).toBe('fallback');
  });

  it('resets backoff to base after a connection stays up longer than stableAfterMs', () => {
    const rp = new ReconnectPolicy({ baseDelayMs: 500, jitterRatio: 0, random: () => 0, stableAfterMs: 60_000 });
    const d1 = rp.recordFailure('primary').delayMs;
    rp.recordConnected(0);
    rp.recordDisconnected(70_000); // stayed up 70s >= stableAfterMs
    const dAfterStable = rp.recordFailure('primary').delayMs;
    expect(dAfterStable).toBe(d1); // back to base, not escalated further
  });

  it('keeps escalating backoff when a connection drops quickly (flapping)', () => {
    const rp = new ReconnectPolicy({ baseDelayMs: 500, jitterRatio: 0, random: () => 0, stableAfterMs: 60_000 });
    const d1 = rp.recordFailure('primary').delayMs;
    rp.recordConnected(0);
    rp.recordDisconnected(5_000); // only up for 5s, below stableAfterMs
    const d2 = rp.recordFailure('primary').delayMs;
    expect(d2).toBeGreaterThan(d1);
  });

  it('signals a proactive reconnect once connection age reaches the configured threshold', () => {
    const rp = new ReconnectPolicy({ proactiveReconnectAfterMs: 23.5 * 3600 * 1000 });
    const connectedAt = 0;
    expect(rp.shouldProactivelyReconnect(1000, connectedAt)).toBe(false);
    expect(rp.shouldProactivelyReconnect(23.5 * 3600 * 1000 + 1, connectedAt)).toBe(true);
  });

  it('reset() clears accumulated failure state back to base delay', () => {
    const rp = new ReconnectPolicy({ baseDelayMs: 500, jitterRatio: 0, random: () => 0 });
    rp.recordFailure('primary');
    rp.recordFailure('primary');
    rp.reset();
    const d = rp.recordFailure('primary').delayMs;
    expect(d).toBe(500);
  });

  it('also escalates delay across consecutive fallback-host failures', () => {
    const rp = new ReconnectPolicy({ baseDelayMs: 500, jitterRatio: 0, random: () => 0 });
    const d1 = rp.recordFailure('fallback').delayMs;
    const d2 = rp.recordFailure('fallback').delayMs;
    expect(d2).toBeGreaterThan(d1);
  });
});
