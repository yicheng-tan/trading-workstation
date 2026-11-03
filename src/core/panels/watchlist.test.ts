import { describe, it, expect } from 'vitest';
import { applyMiniTicker, sortWatchlist } from './watchlist';
import type { MiniTickerEvent, WatchlistRow } from '../types';

function ticker(overrides: Partial<MiniTickerEvent> = {}): MiniTickerEvent {
  return { e: '24hrMiniTicker', E: 1, s: 'BTCUSDT', c: '110', o: '100', h: '115', l: '95', v: '1000', q: '105000', ...overrides };
}

describe('applyMiniTicker', () => {
  it('computes changePct as (close - open) / open * 100', () => {
    const row = applyMiniTicker(ticker({ o: '100', c: '110' }));
    expect(row.changePct).toBeCloseTo(10, 9);
  });

  it('parses all numeric fields from strings', () => {
    const row = applyMiniTicker(ticker({ h: '115', l: '95', q: '105000' }));
    expect(row.high).toBe(115);
    expect(row.low).toBe(95);
    expect(row.quoteVolume).toBe(105000);
    expect(row.symbol).toBe('BTCUSDT');
  });

  it('handles a negative change correctly', () => {
    const row = applyMiniTicker(ticker({ o: '100', c: '90' }));
    expect(row.changePct).toBeCloseTo(-10, 9);
  });
});

describe('sortWatchlist', () => {
  const rows: WatchlistRow[] = [
    { symbol: 'ETHUSDT', last: 1, changePct: 2, high: 1, low: 1, quoteVolume: 500, updatedAt: 1 },
    { symbol: 'BTCUSDT', last: 1, changePct: 10, high: 1, low: 1, quoteVolume: 1000, updatedAt: 1 },
    { symbol: 'SOLUSDT', last: 1, changePct: -5, high: 1, low: 1, quoteVolume: 200, updatedAt: 1 },
  ];

  it('sorts by changePct descending (gainers first)', () => {
    const sorted = sortWatchlist(rows, 'changePct', 'desc');
    expect(sorted.map((r) => r.symbol)).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  });

  it('sorts by quoteVolume ascending', () => {
    const sorted = sortWatchlist(rows, 'quoteVolume', 'asc');
    expect(sorted.map((r) => r.symbol)).toEqual(['SOLUSDT', 'ETHUSDT', 'BTCUSDT']);
  });

  it('sorts by symbol alphabetically', () => {
    const sorted = sortWatchlist(rows, 'symbol', 'asc');
    expect(sorted.map((r) => r.symbol)).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  });

  it('does not mutate the input array', () => {
    const copy = [...rows];
    sortWatchlist(rows, 'changePct', 'desc');
    expect(rows).toEqual(copy);
  });
});
