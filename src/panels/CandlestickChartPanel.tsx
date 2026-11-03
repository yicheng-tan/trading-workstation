import { useCallback, useEffect, useRef, useState } from 'react';
import { createChart, CandlestickSeries, ColorType, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import { useDataHub } from '../app/DataHubContext';
import type { PanelProps } from './PanelProps';
import PanelChrome from './PanelChrome';
import { usePanelLink } from './usePanelLink';
import { deriveStreamStatus, usePeriodicCheck, type PanelStatus } from './panelStatus';
import { mergeHistory } from '../core/panels/candles';
import { COLORS } from './colors';
import type { ConnectionStatus } from '../core/hub/protocol';
import type { Candle, KlineInterval } from '../core/types';
import styles from './CandlestickChartPanel.module.css';

const INTERVALS: KlineInterval[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

/**
 * lightweight-charts manages its own internal canvas + render loop, so
 * there's no need to reproduce the ref+rAF pattern used by the ladder/tape
 * panels here. The important rule is the same in spirit though: candle
 * updates are pushed straight into the chart series imperatively (`.update`)
 * from inside the `subscribeCandles` callback - never through React
 * `setState` - so a live-updating in-progress bar doesn't cause a React
 * re-render on every tick across 30 panels.
 */
export default function CandlestickChartPanel({ config, onSymbolChange, onSettingsChange }: PanelProps) {
  const hub = useDataHub();
  const { symbol, linkGroup, handleSymbolChange, handleLinkGroupChange } = usePanelLink(
    config,
    onSymbolChange,
    onSettingsChange,
    'BTCUSDT',
  );

  const initialInterval = (config.settings.interval as KlineInterval | undefined) ?? '1m';
  const [interval, setIntervalState] = useState<KlineInterval>(
    INTERVALS.includes(initialInterval) ? initialInterval : '1m',
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const historyRef = useRef<Candle[]>([]);

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

  // Create the chart once per mount; light theme colors throughout.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: COLORS.textPrimary,
        fontSize: 11,
      },
      grid: {
        vertLines: { color: COLORS.gridLine },
        horzLines: { color: COLORS.gridLine },
      },
      rightPriceScale: { borderColor: COLORS.gridLine },
      timeScale: { borderColor: COLORS.gridLine, timeVisible: true, secondsVisible: false },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: COLORS.bid,
      borderUpColor: COLORS.bid,
      wickUpColor: COLORS.bid,
      downColor: COLORS.ask,
      borderDownColor: COLORS.ask,
      wickDownColor: COLORS.ask,
    });

    chartRef.current = chart;
    seriesRef.current = series;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Re-subscribe whenever symbol or interval changes; a known gap (see final
  // report) is that the hub only streams forward from subscription time with
  // no REST backfill yet, so the chart starts empty and fills in live.
  useEffect(() => {
    historyRef.current = [];
    seriesRef.current?.setData([]);
    lastUpdateRef.current = null;
    recomputeStatus();

    return hub.subscribeCandles(symbol, interval, (candle) => {
      historyRef.current = mergeHistory(historyRef.current, candle);
      seriesRef.current?.update(toChartPoint(candle));
      lastUpdateRef.current = Date.now();
      recomputeStatus();
    });
  }, [hub, symbol, interval, recomputeStatus]);

  const handleIntervalChange = (next: KlineInterval) => {
    setIntervalState(next);
    onSettingsChange({ ...config.settings, interval: next });
  };

  return (
    <PanelChrome
      title="Chart"
      symbol={symbol}
      onSymbolChange={handleSymbolChange}
      linkGroup={linkGroup}
      onLinkGroupChange={handleLinkGroupChange}
      status={status}
    >
      <div className={styles.wrapper}>
        <div className={styles.toolbar}>
          {INTERVALS.map((iv) => (
            <button
              key={iv}
              type="button"
              className={iv === interval ? styles.intervalButtonActive : styles.intervalButton}
              onClick={() => handleIntervalChange(iv)}
            >
              {iv}
            </button>
          ))}
        </div>
        <div ref={containerRef} className={styles.chartArea} />
      </div>
    </PanelChrome>
  );
}

function toChartPoint(candle: Candle) {
  return {
    time: Math.floor(candle.openTime / 1000) as UTCTimestamp,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
  };
}
