import type { MiniTickerEvent, WatchlistRow } from '../types';

/** Maps a raw 24hr mini-ticker event to a display-ready watchlist row. */
export function applyMiniTicker(_evt: MiniTickerEvent): WatchlistRow {
  throw new Error('not implemented');
}

export type WatchlistSortKey = 'symbol' | 'changePct' | 'quoteVolume';

/** Returns a new, sorted array; never mutates the input. */
export function sortWatchlist(_rows: WatchlistRow[], _by: WatchlistSortKey, _dir: 'asc' | 'desc'): WatchlistRow[] {
  throw new Error('not implemented');
}
