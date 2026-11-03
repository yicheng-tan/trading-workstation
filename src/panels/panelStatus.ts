import { useEffect, useRef } from 'react';
import type { ConnectionStatus } from '../core/hub/protocol';
import type { OrderBookStatus } from '../core/types';

/**
 * Unified visible status for a panel's status badge. Distinct from the raw
 * hub-level `ConnectionStatus` and per-stream statuses (e.g.
 * `OrderBookStatus`) - this is what the UI actually shows, folding both
 * "is the socket connected" and "is data still flowing for THIS panel" into
 * one of four states.
 */
export type PanelStatus = 'live' | 'stale' | 'reconnecting' | 'offline';

/** Order book panels get an explicit per-symbol status straight from the hub. */
export function deriveOrderBookStatus(connection: ConnectionStatus, bookStatus: OrderBookStatus): PanelStatus {
  if (connection === 'offline') return 'offline';
  if (connection === 'reconnecting' || connection === 'connecting') return 'reconnecting';
  switch (bookStatus) {
    case 'live':
      return 'live';
    case 'stale':
      return 'stale';
    case 'resyncing':
    case 'syncing':
    case 'uninitialized':
    default:
      return 'reconnecting';
  }
}

/**
 * Trade tape / candlestick / watchlist streams don't carry an explicit
 * per-message status - we infer "stale" from how long it's been since the
 * last message arrived while the hub connection itself reports live.
 */
export function deriveStreamStatus(
  connection: ConnectionStatus,
  lastUpdateAt: number | null,
  now: number,
  staleAfterMs = 8000,
): PanelStatus {
  if (connection === 'offline') return 'offline';
  if (connection === 'reconnecting' || connection === 'connecting') return 'reconnecting';
  if (lastUpdateAt === null) return 'reconnecting'; // connected but no first message yet
  return now - lastUpdateAt > staleAfterMs ? 'stale' : 'live';
}

/**
 * Runs `check` on an interval in addition to whatever event-driven calls the
 * caller makes. Needed because staleness (no message for N seconds) is only
 * detectable by the *absence* of an event, so something has to poll a clock.
 * Kept to a slow cadence (default 2s) - this is status-badge bookkeeping,
 * not per-tick rendering, so it's fine to use a plain interval + setState.
 */
export function usePeriodicCheck(check: () => void, intervalMs = 2000): void {
  const checkRef = useRef(check);
  checkRef.current = check;

  useEffect(() => {
    const id = window.setInterval(() => checkRef.current(), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
}
