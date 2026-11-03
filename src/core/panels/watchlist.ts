import type { MiniTickerEvent, WatchlistRow } from '../types';

/** Maps a raw 24hr mini-ticker event to a display-ready watchlist row. */
export function applyMiniTicker(evt: MiniTickerEvent): WatchlistRow {
  const open = Number(evt.o);
  const close = Number(evt.c);
  return {
    symbol: evt.s,
    last: close,
    changePct: ((close - open) / open) * 100,
    high: Number(evt.h),
    low: Number(evt.l),
    quoteVolume: Number(evt.q),
    updatedAt: evt.E,
  };
}

export type WatchlistSortKey = 'symbol' | 'changePct' | 'quoteVolume';

/** Returns a new, sorted array; never mutates the input. */
export function sortWatchlist(rows: WatchlistRow[], by: WatchlistSortKey, dir: 'asc' | 'desc'): WatchlistRow[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[by];
    const bv = b[by];
    if (typeof av === 'string' && typeof bv === 'string') {
      return av.localeCompare(bv) * sign;
    }
    return ((av as number) - (bv as number)) * sign;
  });
}
