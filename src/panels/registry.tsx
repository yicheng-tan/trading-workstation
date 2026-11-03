import type { ComponentType } from 'react';
import type { PanelKind } from '../core/layout/schema';
import type { PanelProps } from './PanelProps';
import DepthLadderPanel from './DepthLadderPanel';
import TradeTapePanel from './TradeTapePanel';
import CandlestickChartPanel from './CandlestickChartPanel';
import WatchlistPanel from './WatchlistPanel';

/**
 * Maps each panel kind to its React component. Populated by the panels
 * implementation; the workspace shell only ever imports PANEL_COMPONENTS
 * and PANEL_TITLES from here, never the individual panel files directly, so
 * the two areas can be built independently.
 */
export const PANEL_COMPONENTS: Partial<Record<PanelKind, ComponentType<PanelProps>>> = {
  depthLadder: DepthLadderPanel,
  tradeTape: TradeTapePanel,
  candlestick: CandlestickChartPanel,
  watchlist: WatchlistPanel,
};

export const PANEL_TITLES: Record<PanelKind, string> = {
  depthLadder: 'Order Book',
  tradeTape: 'Time & Sales',
  candlestick: 'Chart',
  watchlist: 'Watchlist',
};

export const DEFAULT_WATCHLIST_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'BNBUSDT',
  'SOLUSDT',
  'XRPUSDT',
  'ADAUSDT',
  'DOGEUSDT',
  'AVAXUSDT',
  'LINKUSDT',
  'DOTUSDT',
];
