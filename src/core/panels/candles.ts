import type { Candle, KlineEvent, KlineInterval } from '../types';

/** Start-of-bucket epoch ms for the interval containing timeMs (UTC-aligned). */
export function bucketStart(_timeMs: number, _interval: KlineInterval): number {
  throw new Error('not implemented');
}

/** Maps a raw kline stream event to a numeric Candle, ignoring out-of-order/older events. */
export function applyKlineEvent(_current: Candle | null, _evt: KlineEvent): Candle {
  throw new Error('not implemented');
}

/** Merges a live-updating candle into REST-fetched history without duplicating the in-progress bar. */
export function mergeHistory(_history: Candle[], _latest: Candle): Candle[] {
  throw new Error('not implemented');
}
