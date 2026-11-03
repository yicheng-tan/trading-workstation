import { useCallback, useState } from 'react';
import { useLinkedSymbol } from '../workspace/LinkGroupContext';
import type { PanelInstanceConfig } from './PanelProps';

export const LINK_GROUPS: ReadonlyArray<{ value: string | null; label: string }> = [
  { value: null, label: 'None' },
  { value: 'A', label: 'Group A' },
  { value: 'B', label: 'Group B' },
  { value: 'C', label: 'Group C' },
  { value: 'D', label: 'Group D' },
];

/**
 * Glue between a panel's `PanelProps` contract and the cross-window
 * link-group bus (`useLinkedSymbol`).
 *
 * NOTE / known contract gap: `PanelProps` exposes `onSymbolChange` but has
 * no dedicated callback for changing a panel's `linkGroup`. The PRD asks
 * every panel chrome to offer a None/A/B/C/D link-group selector, so this
 * hook tracks the active link group as local component state (seeded from
 * `config.linkGroup`) and best-effort persists a change through
 * `onSettingsChange({ ...settings, linkGroup })`. That makes the selector
 * fully functional for live symbol-linking in the current session; whether
 * the workspace/layout layer reads `settings.linkGroup` back into
 * `config.linkGroup` on the next load is outside this panel package's
 * scope (see final report).
 */
export function usePanelLink(
  config: PanelInstanceConfig,
  onSymbolChange: (symbol: string) => void,
  onSettingsChange: (settings: Record<string, unknown>) => void,
  fallbackSymbol: string,
): {
  symbol: string;
  linkGroup: string | null;
  handleSymbolChange: (symbol: string) => void;
  handleLinkGroupChange: (group: string | null) => void;
} {
  const [linkGroup, setLinkGroupState] = useState<string | null>(config.linkGroup);
  const [symbol, setLinkedSymbol] = useLinkedSymbol(linkGroup, config.symbols[0] ?? fallbackSymbol);

  const handleSymbolChange = useCallback(
    (next: string) => {
      setLinkedSymbol(next);
      onSymbolChange(next);
    },
    [setLinkedSymbol, onSymbolChange],
  );

  const handleLinkGroupChange = useCallback(
    (next: string | null) => {
      setLinkGroupState(next);
      onSettingsChange({ ...config.settings, linkGroup: next });
    },
    [config.settings, onSettingsChange],
  );

  return { symbol, linkGroup, handleSymbolChange, handleLinkGroupChange };
}
