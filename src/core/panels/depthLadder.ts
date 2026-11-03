import type { PriceLevel } from '../types';

/**
 * Buckets fine-grained price levels into coarser ticks for ladder display.
 * Bids round DOWN to the nearest tick (never overstate what a buyer is
 * willing to pay); asks round UP (never understate what a seller wants).
 * Quantity is conserved: the sum of qty before and after bucketing matches.
 */
export function groupLevelsByTick(levels: PriceLevel[], tickSize: number, side: 'bid' | 'ask'): PriceLevel[] {
  const buckets = new Map<number, number>();

  for (const level of levels) {
    const ticks = level.price / tickSize;
    const roundedTicks = side === 'bid' ? Math.floor(ticks + 1e-9) : Math.ceil(ticks - 1e-9);
    // Round the bucket price itself to avoid floating point drift (e.g. 0.1 + 0.2 issues).
    const bucketPrice = roundToTickPrecision(roundedTicks * tickSize, tickSize);
    buckets.set(bucketPrice, (buckets.get(bucketPrice) ?? 0) + level.qty);
  }

  const result: PriceLevel[] = Array.from(buckets.entries()).map(([price, qty]) => ({ price, qty }));
  result.sort((a, b) => (side === 'bid' ? b.price - a.price : a.price - b.price));
  return result;
}

/** Rounds a bucketed price to the decimal precision implied by tickSize, to avoid FP noise like 100.00000000001. */
function roundToTickPrecision(value: number, tickSize: number): number {
  const decimals = Math.max(0, decimalPlaces(tickSize));
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Display bucket size from price magnitude: coarser for pricier assets, ~4 significant digits below 1 (Binance's finest tick is 1e-8). */
export function displayTickSize(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return 0.01;
  if (price >= 10000) return 1;
  if (price >= 1000) return 0.5;
  if (price >= 100) return 0.1;
  if (price >= 10) return 0.01;
  if (price >= 1) return 0.001;
  return Math.max(1e-8, 10 ** (Math.floor(Math.log10(price)) - 3));
}

export function decimalPlaces(n: number): number {
  const s = n.toString();
  if (s.includes('e-')) {
    // Handle very small tick sizes expressed in exponential notation.
    const [, exp] = s.split('e-');
    return Number(exp);
  }
  const idx = s.indexOf('.');
  return idx === -1 ? 0 : s.length - idx - 1;
}

export interface LevelWithCumulative extends PriceLevel {
  cumulative: number;
}

/** Running total of qty in the given (already-sorted) order, for depth-bar rendering. */
export function withCumulative(levels: PriceLevel[]): LevelWithCumulative[] {
  let running = 0;
  const result: LevelWithCumulative[] = [];
  for (const level of levels) {
    running += level.qty;
    result.push({ ...level, cumulative: running });
  }
  return result;
}

export function computeMidPrice(bestBid: number | null, bestAsk: number | null): number | null {
  if (bestBid === null || bestAsk === null) return null;
  return (bestBid + bestAsk) / 2;
}
