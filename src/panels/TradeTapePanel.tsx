import { useCallback, useEffect, useRef, useState } from 'react';
import { useDataHub } from '../app/DataHubContext';
import type { PanelProps } from './PanelProps';
import PanelChrome from './PanelChrome';
import { usePanelLink } from './usePanelLink';
import { deriveStreamStatus, usePeriodicCheck, type PanelStatus } from './panelStatus';
import { TapeBuffer } from '../core/panels/tradeTape';
import { COLORS } from './colors';
import type { ConnectionStatus } from '../core/hub/protocol';
import type { TradeTapeEntry } from '../core/types';

/**
 * Same ref + requestAnimationFrame pattern as DepthLadderPanel (see the
 * comment block there for the full rationale): the live trade tape is kept
 * in a `TapeBuffer` referenced via `useRef`, mutated directly inside the
 * `subscribeTrades` callback with no `setState`. A single rAF loop repaints
 * the `<canvas>` from whatever is currently in the buffer. This keeps React
 * re-renders out of the tick-rate path even though individual symbols can
 * print several trades per second, which matters once ~30 panels are doing
 * this simultaneously.
 */

const TAPE_CAPACITY = 300;
const ROW_HEIGHT = 16;
// `isLarge` on each TradeTapeEntry is already computed upstream (hub-side,
// via core/panels/tradeTape.classifyTrade + its own threshold) - this panel
// just renders the flag, it doesn't classify trades itself.
const TAPE_FONT = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export default function TradeTapePanel({ config, onSymbolChange, onSettingsChange }: PanelProps) {
  const hub = useDataHub();
  const { symbol, linkGroup, handleSymbolChange, handleLinkGroupChange } = usePanelLink(
    config,
    onSymbolChange,
    onSettingsChange,
    'BTCUSDT',
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef({ width: 0, height: 0 });

  const bufferRef = useRef(new TapeBuffer(TAPE_CAPACITY));
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

  // New symbol -> fresh tape (old symbol's prints are no longer relevant).
  useEffect(() => {
    bufferRef.current = new TapeBuffer(TAPE_CAPACITY);
    lastUpdateRef.current = null;
    recomputeStatus();
    return hub.subscribeTrades(symbol, (trades: TradeTapeEntry[]) => {
      for (const t of trades) bufferRef.current.push(t);
      lastUpdateRef.current = Date.now();
      recomputeStatus();
    });
  }, [hub, symbol, recomputeStatus]);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const applySize = (width: number, height: number) => {
      sizeRef.current = { width, height };
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const ctx = canvas.getContext('2d');
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      applySize(entry.contentRect.width, entry.contentRect.height);
    });
    ro.observe(container);
    applySize(container.clientWidth, container.clientHeight);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      const { width, height } = sizeRef.current;
      if (ctx && width > 0 && height > 0) {
        renderTape(ctx, width, height, bufferRef.current.entries);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <PanelChrome
      title="Time & Sales"
      symbol={symbol}
      onSymbolChange={handleSymbolChange}
      linkGroup={linkGroup}
      onLinkGroupChange={handleLinkGroupChange}
      status={status}
    >
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }}>
        <canvas ref={canvasRef} style={{ display: 'block' }} />
      </div>
    </PanelChrome>
  );
}

function renderTape(ctx: CanvasRenderingContext2D, width: number, height: number, entries: TradeTapeEntry[]) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = COLORS.panelBg;
  ctx.fillRect(0, 0, width, height);

  if (entries.length === 0) {
    ctx.fillStyle = COLORS.textSecondary;
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Waiting for trades…', width / 2, height / 2);
    return;
  }

  const maxRows = Math.max(1, Math.floor(height / ROW_HEIGHT));
  const decimals = pickDecimals(entries[0].price);

  ctx.font = TAPE_FONT;
  ctx.textBaseline = 'middle';

  for (let i = 0; i < Math.min(maxRows, entries.length); i++) {
    const entry = entries[i];
    const y = i * ROW_HEIGHT;
    const isAsk = entry.side === 'sell'; // consistent with ladder: sells shown in ask/red, buys in bid/green

    if (entry.isLarge) {
      ctx.fillStyle = COLORS.largeHighlight;
      ctx.fillRect(0, y, width, ROW_HEIGHT - 1);
    } else if (i % 2 === 1) {
      ctx.fillStyle = '#fafbfc';
      ctx.fillRect(0, y, width, ROW_HEIGHT - 1);
    }

    const color = isAsk ? COLORS.ask : COLORS.bid;
    ctx.fillStyle = color;
    ctx.font = entry.isLarge ? `700 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` : TAPE_FONT;
    ctx.textAlign = 'left';
    ctx.fillText(entry.price.toFixed(decimals), 6, y + ROW_HEIGHT / 2);

    ctx.fillStyle = COLORS.textPrimary;
    ctx.textAlign = 'center';
    ctx.fillText(entry.qty.toFixed(4), width / 2, y + ROW_HEIGHT / 2);

    ctx.fillStyle = COLORS.textSecondary;
    ctx.textAlign = 'right';
    ctx.fillText(formatTime(entry.time), width - 6, y + ROW_HEIGHT / 2);
  }
}

function pickDecimals(price: number): number {
  if (price >= 1000) return 2;
  if (price >= 1) return 4;
  return 6;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
