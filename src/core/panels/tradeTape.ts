import type { AggTradeEvent, TradeTapeEntry } from '../types';

/**
 * Maps a raw Binance aggTrade event to a display-ready tape entry.
 * Per Binance's docs, `m === true` means the buyer was the market maker,
 * i.e. this print was triggered by an aggressive SELL (taker sold into the
 * bid); `m === false` means the taker bought (lifted the ask).
 */
export function classifyTrade(evt: AggTradeEvent, largeNotionalThreshold: number): TradeTapeEntry {
  const price = Number(evt.p);
  const qty = Number(evt.q);
  const notional = price * qty;
  return {
    id: evt.a,
    symbol: evt.s,
    price,
    qty,
    notional,
    side: evt.m ? 'sell' : 'buy',
    time: evt.T,
    isLarge: notional >= largeNotionalThreshold,
  };
}

/** Fixed-capacity ring buffer for the trade tape; newest entry first. */
export class TapeBuffer {
  private readonly maxLength: number;
  private buffer: TradeTapeEntry[] = [];

  constructor(maxLength: number) {
    if (maxLength <= 0) {
      throw new Error(`TapeBuffer maxLength must be positive, got ${maxLength}`);
    }
    this.maxLength = maxLength;
  }

  push(entry: TradeTapeEntry): void {
    this.buffer.unshift(entry);
    if (this.buffer.length > this.maxLength) {
      this.buffer.length = this.maxLength;
    }
  }

  get entries(): TradeTapeEntry[] {
    return this.buffer;
  }
}
