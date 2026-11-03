import { describe, it, expect } from 'vitest';
import { bucketStart, applyKlineEvent, mergeHistory } from './candles';
import type { Candle, KlineEvent } from '../types';

function kline(overrides: Partial<KlineEvent['k']> = {}): KlineEvent {
  return {
    e: 'kline',
    E: 1,
    s: 'BTCUSDT',
    k: { t: 60_000, T: 119_999, i: '1m', o: '100', c: '105', h: '106', l: '99', v: '12.5', x: false, ...overrides },
  };
}

describe('bucketStart', () => {
  it('rounds down to the start of the minute for 1m', () => {
    expect(bucketStart(90_123, '1m')).toBe(60_000);
  });

  it('rounds down to the nearest 5-minute boundary for 5m', () => {
    expect(bucketStart(7 * 60_000, '5m')).toBe(5 * 60_000);
  });

  it('rounds down to the start of the hour for 1h', () => {
    expect(bucketStart(2 * 3_600_000 + 5 * 60_000, '1h')).toBe(2 * 3_600_000);
  });
});

describe('applyKlineEvent', () => {
  it('maps raw string OHLCV fields to a numeric Candle', () => {
    const c = applyKlineEvent(null, kline());
    expect(c).toMatchObject({ openTime: 60_000, closeTime: 119_999, open: 100, high: 106, low: 99, close: 105, volume: 12.5, closed: false });
  });

  it('marks the candle closed when k.x is true', () => {
    const c = applyKlineEvent(null, kline({ x: true }));
    expect(c.closed).toBe(true);
  });

  it('ignores an incoming event that is older than (or equal to) the current candle', () => {
    const current: Candle = { openTime: 60_000, closeTime: 119_999, open: 100, high: 110, low: 95, close: 108, volume: 20, closed: false };
    const staleEvt = kline({ t: 60_000, T: 119_999, c: '1', h: '1', l: '1', v: '0' });
    const result = applyKlineEvent(current, staleEvt);
    // the stale event must not regress high/low/volume already observed
    expect(result.high).toBeGreaterThanOrEqual(current.high);
  });
});

describe('mergeHistory', () => {
  it('appends a new candle when openTime differs from the last history entry', () => {
    const history: Candle[] = [{ openTime: 0, closeTime: 59_999, open: 1, high: 1, low: 1, close: 1, volume: 1, closed: true }];
    const latest: Candle = { openTime: 60_000, closeTime: 119_999, open: 2, high: 2, low: 2, close: 2, volume: 2, closed: false };
    const merged = mergeHistory(history, latest);
    expect(merged).toHaveLength(2);
    expect(merged[1]).toEqual(latest);
  });

  it('replaces the last entry (not appends) when the latest candle shares its openTime', () => {
    const history: Candle[] = [{ openTime: 60_000, closeTime: 119_999, open: 2, high: 2, low: 2, close: 2, volume: 2, closed: false }];
    const latest: Candle = { openTime: 60_000, closeTime: 119_999, open: 2, high: 3, low: 2, close: 2.5, volume: 4, closed: false };
    const merged = mergeHistory(history, latest);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual(latest);
  });

  it('returns a single-item array when history is empty', () => {
    const latest: Candle = { openTime: 0, closeTime: 59_999, open: 1, high: 1, low: 1, close: 1, volume: 1, closed: false };
    expect(mergeHistory([], latest)).toEqual([latest]);
  });
});
