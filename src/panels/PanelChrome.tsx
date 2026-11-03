import { useEffect, useRef, useState, type ReactNode } from 'react';
import styles from './PanelChrome.module.css';
import { LINK_GROUPS, linkGroupColor } from './usePanelLink';
import type { PanelStatus } from './panelStatus';
import { resolveSymbol } from '../core/symbols/symbols';
import { SYMBOL_DATALIST_ID, isDatalistPick, useSymbolSet } from './symbolDirectory';

const STATUS_LABEL: Record<PanelStatus, string> = {
  live: 'Live',
  stale: 'Stale',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
};

interface PanelChromeProps {
  title: string;
  symbol: string;
  onSymbolChange: (symbol: string) => void;
  linkGroup: string | null;
  onLinkGroupChange: (group: string | null) => void;
  status: PanelStatus;
  children: ReactNode;
}

/**
 * Shared header/wrapper rendered by every panel kind: title, an editable
 * symbol field, a link-group selector, and a connection/data status badge.
 * Keeping this in one place means every panel looks and behaves
 * consistently and only has to pass in its own symbol/status state.
 *
 * Symbol entry: Enter or blur commits, Escape cancels, picking an
 * autocomplete suggestion commits immediately. Input is resolved through
 * `resolveSymbol` ("btc" -> "BTCUSDT"); an unknown symbol is flagged on Enter
 * and reverted on blur, so the field never names a symbol the panel isn't
 * actually showing.
 */
export default function PanelChrome({
  title,
  symbol,
  onSymbolChange,
  linkGroup,
  onLinkGroupChange,
  status,
  children,
}: PanelChromeProps) {
  const knownSymbols = useSymbolSet();
  const [draftSymbol, setDraftSymbol] = useState(symbol);
  const [invalid, setInvalid] = useState(false);
  const skipBlurRef = useRef(false);

  // Keep the text field in sync when the symbol changes from elsewhere
  // (link-group broadcast from another panel/window, watchlist click, etc.)
  useEffect(() => {
    setDraftSymbol(symbol);
    setInvalid(false);
  }, [symbol]);

  // Handlers pass the DOM value rather than `draftSymbol`, which may not have
  // re-rendered yet when a commit happens from inside a change handler.
  const commit = (value: string): boolean => {
    const next = resolveSymbol(value, knownSymbols);
    if (!next) return false;
    setInvalid(false);
    if (next !== symbol) onSymbolChange(next);
    setDraftSymbol(next);
    return true;
  };

  const revert = () => {
    setInvalid(false);
    setDraftSymbol(symbol);
  };

  // After Enter/Escape/pick has already committed or reverted, drop focus
  // without letting the resulting blur event commit a second time.
  const finishEditing = (input: HTMLInputElement) => {
    if (document.activeElement !== input) return;
    skipBlurRef.current = true;
    input.blur();
  };

  const groupColor = linkGroupColor(linkGroup);

  return (
    <div className={styles.chrome}>
      <div className={styles.header} style={groupColor ? { boxShadow: `inset 3px 0 0 ${groupColor}` } : undefined}>
        {/* Hidden in the main window, where the dock tab already names the panel (workspace.css). */}
        <span className={styles.title} data-panel-title="">
          {title}
        </span>
        <input
          className={`${styles.symbolInput} ${invalid ? styles.symbolInputInvalid : ''}`}
          value={draftSymbol}
          list={SYMBOL_DATALIST_ID}
          autoComplete="off"
          onChange={(e) => {
            const value = e.target.value;
            setDraftSymbol(value);
            setInvalid(false);
            if (isDatalistPick(e) && knownSymbols?.has(value) && commit(value)) finishEditing(e.currentTarget);
          }}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => {
            if (skipBlurRef.current) {
              skipBlurRef.current = false;
              return;
            }
            if (!commit(e.currentTarget.value)) revert();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (commit(e.currentTarget.value)) finishEditing(e.currentTarget);
              else setInvalid(true);
            } else if (e.key === 'Escape') {
              revert();
              finishEditing(e.currentTarget);
            }
          }}
          aria-label="Symbol"
          aria-invalid={invalid}
          title={invalid ? 'Unknown symbol - pick one from the list' : 'Symbol (e.g. BTC, ETHUSDT). Esc to cancel.'}
          spellCheck={false}
        />
        <select
          className={styles.linkSelect}
          style={groupColor ? { color: groupColor, borderColor: groupColor, fontWeight: 600 } : undefined}
          value={linkGroup ?? ''}
          onChange={(e) => onLinkGroupChange(e.target.value === '' ? null : e.target.value)}
          aria-label="Link group"
          title="Link group"
        >
          {LINK_GROUPS.map((g) => (
            <option key={g.label} value={g.value ?? ''}>
              {g.label}
            </option>
          ))}
        </select>
        <span className={`${styles.statusBadge} ${styles[status]}`} role="status" aria-label={`Status: ${STATUS_LABEL[status]}`}>
          <span className={styles.statusDot} />
          {STATUS_LABEL[status]}
        </span>
      </div>
      <div className={styles.body}>{children}</div>
    </div>
  );
}
