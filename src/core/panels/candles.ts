import type { Candle, KlineEvent, KlineInterval } from '../types';

const INTERVAL_MS: Record<KlineInterval, number> = {
  '1m': 60_000,
  '3m': 3 * 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 3_600_000,
  '2h': 2 * 3_600_000,
  '4h': 4 * 3_600_000,
  '6h': 6 * 3_600_000,
  '12h': 12 * 3_600_000,
  '1d': 24 * 3_600_000,
  '3d': 3 * 24 * 3_600_000,
  '1w': 7 * 24 * 3_600_000,
};

/** Start-of-bucket epoch ms for the interval containing timeMs (UTC-aligned). */
export function bucketStart(timeMs: number, interval: KlineInterval): number {
  const span = INTERVAL_MS[interval];
  return Math.floor(timeMs / span) * span;
}

/** Maps a raw kline stream event to a numeric Candle, ignoring out-of-order/older events. */
export function applyKlineEvent(current: Candle | null, evt: KlineEvent): Candle {
  const { k } = evt;
  const incoming: Candle = {
    openTime: k.t,
    closeTime: k.T,
    open: Number(k.o),
    high: Number(k.h),
    low: Number(k.l),
    close: Number(k.c),
    volume: Number(k.v),
    closed: k.x,
  };

  // If this event belongs to a different (newer) bar than `current`, it's a fresh candle - use it as-is.
  if (!current || current.openTime !== incoming.openTime) {
    return incoming;
  }

  // Same bar: guard against a stale/duplicate/out-of-order event regressing already-observed
  // high/low/volume/closed state. Merge conservatively rather than blindly overwriting.
  return {
    openTime: current.openTime,
    closeTime: incoming.closeTime,
    open: current.open,
    high: Math.max(current.high, incoming.high),
    low: Math.min(current.low, incoming.low),
    close: incoming.close,
    volume: Math.max(current.volume, incoming.volume),
    closed: current.closed || incoming.closed,
  };
}

/** Merges a live-updating candle into REST-fetched history without duplicating the in-progress bar. */
export function mergeHistory(history: Candle[], latest: Candle): Candle[] {
  if (history.length === 0) return [latest];
  const last = history[history.length - 1];
  if (last.openTime === latest.openTime) {
    return [...history.slice(0, -1), latest];
  }
  return [...history, latest];
}
