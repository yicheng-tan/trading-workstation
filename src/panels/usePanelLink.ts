import { useCallback, useEffect, useRef, useState } from 'react';
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
 * `PanelProps` has no dedicated link-group callback, so a link-group change
 * is persisted as `settings.linkGroup`; the workspace promotes it onto
 * `config.linkGroup`.
 *
 * The displayed symbol and `config.symbols[0]` are kept in step both ways:
 * a symbol that arrives through the link group (from another panel or
 * window) is written back via `onSymbolChange` so saved layouts record what
 * the panel actually shows, and an external config change (e.g. a layout
 * reload reusing this panel's id) is adopted and broadcast to the group.
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
  const configSymbol = config.symbols[0] ?? fallbackSymbol;
  const [linkGroup, setLinkGroupState] = useState<string | null>(config.linkGroup);
  const [symbol, setLinkedSymbol] = useLinkedSymbol(linkGroup, configSymbol);

  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;
  const configSymbolRef = useRef(configSymbol);
  configSymbolRef.current = configSymbol;
  const onSymbolChangeRef = useRef(onSymbolChange);
  onSymbolChangeRef.current = onSymbolChange;

  useEffect(() => {
    if (configSymbol !== symbolRef.current) setLinkedSymbol(configSymbol);
    // Only react to the config value itself changing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configSymbol]);

  useEffect(() => {
    if (symbol !== configSymbolRef.current) onSymbolChangeRef.current(symbol);
  }, [symbol]);

  useEffect(() => {
    setLinkGroupState(config.linkGroup);
  }, [config.linkGroup]);

  const handleLinkGroupChange = useCallback(
    (next: string | null) => {
      setLinkGroupState(next);
      onSettingsChange({ ...config.settings, linkGroup: next });
    },
    [config.settings, onSettingsChange],
  );

  return { symbol, linkGroup, handleSymbolChange: setLinkedSymbol, handleLinkGroupChange };
}
