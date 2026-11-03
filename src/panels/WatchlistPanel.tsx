import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDataHub } from '../app/DataHubContext';
import type { PanelProps } from './PanelProps';
import PanelChrome from './PanelChrome';
import { usePanelLink } from './usePanelLink';
import { deriveStreamStatus, usePeriodicCheck, type PanelStatus } from './panelStatus';
import { sortWatchlist, type WatchlistSortKey } from '../core/panels/watchlist';
import { DEFAULT_WATCHLIST_SYMBOLS } from './registry';
import { priceDecimals } from './priceFormat';
import type { ConnectionStatus } from '../core/hub/protocol';
import type { WatchlistRow } from '../core/types';
import styles from './WatchlistPanel.module.css';

/**
 * Unlike the ladder/tape panels, the mini-ticker stream updates roughly
 * once a second for the whole market rather than at per-tick rate, and this
 * panel renders a handful of table rows (not a dense per-level view) - so
 * plain React state is fine here and keeps row diffing/sorting simple.
 */
export default function WatchlistPanel({ config, onSettingsChange }: PanelProps) {
  const hub = useDataHub();
  // `config.symbols` is the watched list here, so the link-group symbol
  // (set by clicking a row) lives in `settings.selectedSymbol` instead.
  const selectedSymbol = typeof config.settings.selectedSymbol === 'string' ? config.settings.selectedSymbol : 'BTCUSDT';
  const linkConfig = useMemo(() => ({ ...config, symbols: [selectedSymbol] }), [config, selectedSymbol]);
  const persistSelectedSymbol = useCallback(
    (next: string) => onSettingsChange({ ...config.settings, selectedSymbol: next }),
    [config.settings, onSettingsChange],
  );
  const { symbol, linkGroup, handleSymbolChange, handleLinkGroupChange } = usePanelLink(
    linkConfig,
    persistSelectedSymbol,
    onSettingsChange,
    'BTCUSDT',
  );

  const watchedSymbols = useMemo(
    () => new Set(config.symbols.length > 0 ? config.symbols : DEFAULT_WATCHLIST_SYMBOLS),
    [config.symbols],
  );

  const [rows, setRows] = useState<WatchlistRow[]>([]);
  const [sortBy, setSortBy] = useState<WatchlistSortKey>('changePct');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const connectionRef = useRef<ConnectionStatus>(hub.getConnectionStatus());
  const lastUpdateRef = useRef<number | null>(null);
  const [status, setStatus] = useState<PanelStatus>('reconnecting');
  const statusRef = useRef<PanelStatus>('reconnecting');

  const recomputeStatus = useCallback(() => {
    const next = deriveStreamStatus(connectionRef.current, lastUpdateRef.current, Date.now());
    if (next !== statusRef.current) {
      statusRef.current = next;
      setStatus(next);
    }
  }, []);

  usePeriodicCheck(recomputeStatus);

  useEffect(() => {
    connectionRef.current = hub.getConnectionStatus();
    recomputeStatus();
    return hub.onConnectionStatus((s) => {
      connectionRef.current = s;
      recomputeStatus();
    });
  }, [hub, recomputeStatus]);

  useEffect(() => {
    return hub.subscribeWatchlist((allRows) => {
      setRows(allRows.filter((r) => watchedSymbols.has(r.symbol)));
      lastUpdateRef.current = Date.now();
      recomputeStatus();
    });
  }, [hub, watchedSymbols, recomputeStatus]);

  const sortedRows = useMemo(() => sortWatchlist(rows, sortBy, sortDir), [rows, sortBy, sortDir]);

  const handleSort = (key: WatchlistSortKey) => {
    if (key === sortBy) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(key);
      setSortDir(key === 'symbol' ? 'asc' : 'desc');
    }
  };

  const sortIndicator = (key: WatchlistSortKey) => (key === sortBy ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  return (
    <PanelChrome
      title="Watchlist"
      symbol={symbol}
      onSymbolChange={handleSymbolChange}
      linkGroup={linkGroup}
      onLinkGroupChange={handleLinkGroupChange}
      status={status}
    >
      <div className={styles.wrapper}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.sortable} onClick={() => handleSort('symbol')}>
                Symbol{sortIndicator('symbol')}
              </th>
              <th>Last</th>
              <th className={styles.sortable} onClick={() => handleSort('changePct')}>
                Chg%{sortIndicator('changePct')}
              </th>
              <th>High</th>
              <th>Low</th>
              <th className={styles.sortable} onClick={() => handleSort('quoteVolume')}>
                Quote Vol{sortIndicator('quoteVolume')}
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.length === 0 ? (
              <tr>
                <td className={styles.empty} colSpan={6}>
                  Waiting for watchlist data…
                </td>
              </tr>
            ) : (
              sortedRows.map((row) => (
                <tr
                  key={row.symbol}
                  className={styles.row}
                  onClick={() => handleSymbolChange(row.symbol)}
                  title={`Set link group symbol to ${row.symbol}`}
                >
                  <td className={styles.symbolCell}>{row.symbol}</td>
                  <td className={styles.numCell}>{formatPrice(row.last)}</td>
                  <td className={`${styles.numCell} ${row.changePct >= 0 ? styles.gain : styles.loss}`}>
                    {row.changePct >= 0 ? '+' : ''}
                    {row.changePct.toFixed(2)}%
                  </td>
                  <td className={styles.numCell}>{formatPrice(row.high)}</td>
                  <td className={styles.numCell}>{formatPrice(row.low)}</td>
                  <td className={styles.numCell}>{formatVolume(row.quoteVolume)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </PanelChrome>
  );
}

function formatPrice(value: number): string {
  return value.toFixed(priceDecimals(value));
}

function formatVolume(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return value.toFixed(2);
}
