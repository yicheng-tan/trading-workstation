import type { PanelKind } from '../core/layout/schema';

export interface PanelInstanceConfig {
  id: string;
  kind: PanelKind;
  /** Primary symbol for single-symbol panels; full list for the watchlist. */
  symbols: string[];
  linkGroup: string | null;
  settings: Record<string, unknown>;
}

export interface PanelProps {
  config: PanelInstanceConfig;
  /** Change the panel's primary symbol; propagates to its link group automatically via useLinkedSymbol. */
  onSymbolChange: (symbol: string) => void;
  onSettingsChange: (settings: Record<string, unknown>) => void;
}
