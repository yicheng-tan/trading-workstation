import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDataHub } from '../app/DataHubContext';
import type { PanelProps } from './PanelProps';
import PanelChrome from './PanelChrome';
import { usePanelLink } from './usePanelLink';
import { deriveStreamStatus, usePeriodicCheck, type PanelStatus } from './panelStatus';
import { sortWatchlist, type WatchlistSortKey } from '../core/panels/watchlist';
import { resolveSymbol } from '../core/symbols/symbols';
import { DEFAULT_WATCHLIST_SYMBOLS } from './registry';
import { priceDecimals } from './priceFormat';
import { SYMBOL_DATALIST_ID, isDatalistPick, useSymbolSet } from './symbolDirectory';
import type { ConnectionStatus } from '../core/hub/protocol';
import type { WatchlistRow } from '../core/types';
import styles from './WatchlistPanel.module.css';

type Flash = 'up' | 'down' | null;

interface DisplayRow extends WatchlistRow {
  flash: Flash;
  /** Bumped on every price change; part of the price cell's `key` so its flash animation restarts. */
  flashSeq: number;
}

/**
 * Unlike the ladder/tape panels, the mini-ticker stream updates roughly
 * once a second for the whole market rather than at per-tick rate, and this
 * panel renders a handful of table rows (not a dense per-level view) - so
 * plain React state is fine here and keeps row diffing/sorting simple.
 */
export default function WatchlistPanel({ config, onSymbolsChange, onSettingsChange }: PanelProps) {
  const hub = useDataHub();
  const knownSymbols = useSymbolSet();
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

  const watchedList = config.symbols.length > 0 ? config.symbols : DEFAULT_WATCHLIST_SYMBOLS;
  const watchedSymbols = useMemo(() => new Set(watchedList), [watchedList]);

  const [rows, setRows] = useState<DisplayRow[]>([]);
  const [sortBy, setSortBy] = useState<WatchlistSortKey>('changePct');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [newSymbol, setNewSymbol] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const flashRef = useRef(new Map<string, { last: number; flash: Flash; seq: number }>());

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
      const flashes = flashRef.current;
      const next: DisplayRow[] = [];
      for (const row of allRows) {
        if (!watchedSymbols.has(row.symbol)) continue;
        const prev = flashes.get(row.symbol);
        const state =
          prev === undefined
            ? { last: row.last, flash: null, seq: 0 }
            : prev.last === row.last
              ? prev
              : { last: row.last, flash: row.last > prev.last ? ('up' as const) : ('down' as const), seq: prev.seq + 1 };
        flashes.set(row.symbol, state);
        next.push({ ...row, flash: state.flash, flashSeq: state.seq });
      }
      setRows(next);
      lastUpdateRef.current = Date.now();
      recomputeStatus();
    });
  }, [hub, watchedSymbols, recomputeStatus]);

  const sortedRows = useMemo(
    () => sortWatchlist(rows.filter((r) => watchedSymbols.has(r.symbol)), sortBy, sortDir),
    [rows, watchedSymbols, sortBy, sortDir],
  );
  const pendingSymbols = useMemo(
    () => watchedList.filter((s) => !rows.some((r) => r.symbol === s)),
    [watchedList, rows],
  );

  const handleSort = (key: WatchlistSortKey) => {
    if (key === sortBy) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(key);
      setSortDir(key === 'symbol' ? 'asc' : 'desc');
    }
  };

  const sortIndicator = (key: WatchlistSortKey) => (key === sortBy ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  const addSymbol = (raw: string) => {
    const resolved = resolveSymbol(raw, knownSymbols);
    if (!resolved) {
      setAddError(raw.trim() ? 'Unknown symbol' : null);
      return;
    }
    if (!watchedSymbols.has(resolved)) onSymbolsChange([...watchedList, resolved]);
    setNewSymbol('');
    setAddError(null);
  };

  const removeSymbol = (s: string) => {
    const next = watchedList.filter((x) => x !== s);
    if (next.length > 0) onSymbolsChange(next);
  };

  const canRemove = watchedList.length > 1;
  const removeButton = (s: string) => (
    <td className={styles.removeCell}>
      {canRemove && (
        <button
          type="button"
          className={styles.removeBtn}
          title={`Remove ${s} from watchlist`}
          aria-label={`Remove ${s}`}
          onClick={(e) => {
            e.stopPropagation();
            removeSymbol(s);
          }}
        >
          ✕
        </button>
      )}
    </td>
  );

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
        <form
          className={styles.addBar}
          onSubmit={(e) => {
            e.preventDefault();
            addSymbol(newSymbol);
          }}
        >
          <input
            className={`${styles.addInput} ${addError ? styles.addInputInvalid : ''}`}
            value={newSymbol}
            list={SYMBOL_DATALIST_ID}
            autoComplete="off"
            spellCheck={false}
            placeholder="Add symbol, e.g. SOL"
            aria-label="Add symbol to watchlist"
            aria-invalid={addError !== null}
            title={addError ?? undefined}
            onChange={(e) => {
              const value = e.target.value;
              setNewSymbol(value);
              setAddError(null);
              if (isDatalistPick(e) && knownSymbols?.has(value)) addSymbol(value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setNewSymbol('');
                setAddError(null);
              }
            }}
          />
          <button type="submit" className={styles.addBtn}>
            Add
          </button>
          {addError && <span className={styles.addError}>{addError}</span>}
        </form>
        <div className={styles.scroll}>
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
                <th aria-label="Remove" />
              </tr>
            </thead>
            <tbody>
              {sortedRows.length === 0 ? (
                <tr>
                  <td className={styles.empty} colSpan={7}>
                    Waiting for watchlist data…
                  </td>
                </tr>
              ) : (
                <>
                  {sortedRows.map((row) => (
                    <tr
                      key={row.symbol}
                      className={`${styles.row} ${row.symbol === symbol ? styles.selectedRow : ''}`}
                      onClick={() => handleSymbolChange(row.symbol)}
                      title={`Set link group symbol to ${row.symbol}`}
                    >
                      <td className={styles.symbolCell}>{row.symbol}</td>
                      <td
                        key={`last:${row.flashSeq}`}
                        className={`${styles.numCell} ${row.flash === 'up' ? styles.flashUp : row.flash === 'down' ? styles.flashDown : ''}`}
                      >
                        {formatPrice(row.last)}
                      </td>
                      <td className={`${styles.numCell} ${row.changePct >= 0 ? styles.gain : styles.loss}`}>
                        {row.changePct >= 0 ? '+' : ''}
                        {row.changePct.toFixed(2)}%
                      </td>
                      <td className={styles.numCell}>{formatPrice(row.high)}</td>
                      <td className={styles.numCell}>{formatPrice(row.low)}</td>
                      <td className={styles.numCell}>{formatVolume(row.quoteVolume)}</td>
                      {removeButton(row.symbol)}
                    </tr>
                  ))}
                  {pendingSymbols.map((s) => (
                    <tr key={s} className={`${styles.row} ${styles.pendingRow}`} title={`No market data for ${s} yet`}>
                      <td className={styles.symbolCell}>{s}</td>
                      <td className={styles.numCell} colSpan={5}>
                        —
                      </td>
                      {removeButton(s)}
                    </tr>
                  ))}
                </>
              )}
            </tbody>
          </table>
        </div>
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
