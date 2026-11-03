import { useEffect, useState, type ReactNode } from 'react';
import styles from './PanelChrome.module.css';
import { LINK_GROUPS } from './usePanelLink';
import type { PanelStatus } from './panelStatus';

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
  const [draftSymbol, setDraftSymbol] = useState(symbol);

  // Keep the text field in sync when the symbol changes from elsewhere
  // (link-group broadcast from another panel/window, watchlist click, etc.)
  useEffect(() => {
    setDraftSymbol(symbol);
  }, [symbol]);

  const commitSymbol = () => {
    const next = draftSymbol.trim().toUpperCase();
    if (next && next !== symbol) {
      onSymbolChange(next);
    }
    setDraftSymbol(next || symbol);
  };

  return (
    <div className={styles.chrome}>
      <div className={styles.header}>
        <span className={styles.title}>{title}</span>
        <input
          className={styles.symbolInput}
          value={draftSymbol}
          onChange={(e) => setDraftSymbol(e.target.value)}
          onBlur={commitSymbol}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commitSymbol();
              e.currentTarget.blur();
            }
          }}
          aria-label="Symbol"
          spellCheck={false}
        />
        <select
          className={styles.linkSelect}
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
      <div className={styles.footer}>Data: Binance Spot (public market data)</div>
    </div>
  );
}
