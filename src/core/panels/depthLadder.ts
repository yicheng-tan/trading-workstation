import type { PriceLevel } from '../types';

/**
 * Buckets fine-grained price levels into coarser ticks for ladder display.
 * Bids round DOWN to the nearest tick (never overstate what a buyer is
 * willing to pay); asks round UP (never understate what a seller wants).
 * Quantity is conserved: the sum of qty before and after bucketing matches.
 */
export function groupLevelsByTick(_levels: PriceLevel[], _tickSize: number, _side: 'bid' | 'ask'): PriceLevel[] {
  throw new Error('not implemented');
}

export interface LevelWithCumulative extends PriceLevel {
  cumulative: number;
}

/** Running total of qty in the given (already-sorted) order, for depth-bar rendering. */
export function withCumulative(_levels: PriceLevel[]): LevelWithCumulative[] {
  throw new Error('not implemented');
}

export function computeMidPrice(_bestBid: number | null, _bestAsk: number | null): number | null {
  throw new Error('not implemented');
}
