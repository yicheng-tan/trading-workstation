import type { AggTradeEvent, TradeTapeEntry } from '../types';

/**
 * Maps a raw Binance aggTrade event to a display-ready tape entry.
 * Per Binance's docs, `m === true` means the buyer was the market maker,
 * i.e. this print was triggered by an aggressive SELL (taker sold into the
 * bid); `m === false` means the taker bought (lifted the ask).
 */
export function classifyTrade(_evt: AggTradeEvent, _largeNotionalThreshold: number): TradeTapeEntry {
  throw new Error('not implemented');
}

/** Fixed-capacity ring buffer for the trade tape; newest entry first. */
export class TapeBuffer {
  constructor(_maxLength: number) {
    throw new Error('not implemented');
  }

  push(_entry: TradeTapeEntry): void {
    throw new Error('not implemented');
  }

  get entries(): TradeTapeEntry[] {
    throw new Error('not implemented');
  }
}
