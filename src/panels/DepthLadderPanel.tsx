import { useCallback, useEffect, useRef, useState } from 'react';
import { useDataHub } from '../app/DataHubContext';
import type { PanelProps } from './PanelProps';
import PanelChrome from './PanelChrome';
import { usePanelLink } from './usePanelLink';
import { deriveOrderBookStatus, type PanelStatus } from './panelStatus';
import { groupLevelsByTick, withCumulative, computeMidPrice, type LevelWithCumulative } from '../core/panels/depthLadder';
import { COLORS } from './colors';
import type { ConnectionStatus } from '../core/hub/protocol';
import type { OrderBookSnapshotView, OrderBookStatus } from '../core/types';

/**
 * PERFORMANCE PATTERN (read before touching this file):
 *
 * The reference scenario is 30 panels × 10 symbols, several of which may be
 * depth ladders receiving order-book diffs multiple times per second each.
 * If every tick called `setState` and let React re-render a DOM row per
 * price level, 30 of these panels alone would be enough to drop frames.
 *
 * Instead:
 *  - The live `OrderBookSnapshotView` is written into a plain `useRef`
 *    inside the subscription callback - NOT into React state. This never
 *    triggers a re-render.
 *  - A single `requestAnimationFrame` loop (started once per mount) reads
 *    whatever is currently in that ref and paints it onto a `<canvas>`.
 *    Painting is "pull" based (read latest ref each frame) rather than
 *    "push" based (react to every message), so a burst of 50 book updates
 *    in one frame interval still only costs one paint.
 *  - React state/setState is reserved for things that change rarely and
 *    actually need to re-render chrome around the canvas (status badge,
 *    symbol text) - never for the tick-rate book data itself.
 */

const ROW_HEIGHT = 18;
const MID_ROW_HEIGHT = 22;
const LADDER_FONT = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export default function DepthLadderPanel({ config, onSymbolChange, onSettingsChange }: PanelProps) {
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

  const bookRef = useRef<OrderBookSnapshotView | null>(null);
  const connectionRef = useRef<ConnectionStatus>(hub.getConnectionStatus());
  const bookStatusRef = useRef<OrderBookStatus | null>(null);

  const [status, setStatus] = useState<PanelStatus>('reconnecting');
  const statusRef = useRef<PanelStatus>('reconnecting');

  const recomputeStatus = useCallback(() => {
    const next = bookStatusRef.current
      ? deriveOrderBookStatus(connectionRef.current, bookStatusRef.current)
      : connectionRef.current === 'offline'
        ? 'offline'
        : 'reconnecting';
    if (next !== statusRef.current) {
      statusRef.current = next;
      setStatus(next);
    }
  }, []);

  // Connection-level status (rare changes - fine to use React state).
  useEffect(() => {
    connectionRef.current = hub.getConnectionStatus();
    recomputeStatus();
    return hub.onConnectionStatus((s) => {
      connectionRef.current = s;
      recomputeStatus();
    });
  }, [hub, recomputeStatus]);

  // Order book subscription - hot path, writes into refs only.
  useEffect(() => {
    bookRef.current = null;
    bookStatusRef.current = null;
    recomputeStatus();
    return hub.subscribeOrderBook(symbol, (book) => {
      bookRef.current = book;
      bookStatusRef.current = book.status;
      recomputeStatus();
    });
  }, [hub, symbol, recomputeStatus]);

  // Track container size via ResizeObserver; size the canvas backing store
  // at `size * devicePixelRatio` so strokes/text stay crisp on HiDPI screens.
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
      // setTransform (not scale) so repeated resizes don't compound the dpr scale.
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      applySize(width, height);
    });
    ro.observe(container);
    applySize(container.clientWidth, container.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Single rAF loop for the lifetime of the component; reads refs each frame.
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      const { width, height } = sizeRef.current;
      if (ctx && width > 0 && height > 0) {
        renderLadder(ctx, width, height, bookRef.current);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <PanelChrome
      title="Order Book"
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

/** Picks a display tick size from price magnitude: coarser buckets for pricier assets. */
function pickTickSize(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return 0.01;
  if (price >= 10000) return 1;
  if (price >= 1000) return 0.5;
  if (price >= 100) return 0.1;
  if (price >= 10) return 0.01;
  if (price >= 1) return 0.001;
  return 0.0001;
}

function decimalsFor(tickSize: number): number {
  const s = tickSize.toString();
  const idx = s.indexOf('.');
  return idx === -1 ? 0 : s.length - idx - 1;
}

function formatPrice(value: number, decimals: number): string {
  return value.toFixed(Math.min(decimals, 8));
}

function renderLadder(ctx: CanvasRenderingContext2D, width: number, height: number, book: OrderBookSnapshotView | null) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = COLORS.panelBg;
  ctx.fillRect(0, 0, width, height);

  if (!book || (book.bids.length === 0 && book.asks.length === 0)) {
    ctx.fillStyle = COLORS.textSecondary;
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Waiting for order book…', width / 2, height / 2);
    return;
  }

  const refPrice = book.bestBid?.price ?? book.bestAsk?.price ?? book.bids[0]?.price ?? book.asks[0]?.price ?? 100;
  const tickSize = pickTickSize(refPrice);
  const decimals = decimalsFor(tickSize);

  const sideHeight = Math.max(0, height - MID_ROW_HEIGHT);
  const rowsPerSide = Math.max(1, Math.floor(sideHeight / 2 / ROW_HEIGHT));

  const groupedBids = withCumulative(groupLevelsByTick(book.bids, tickSize, 'bid')).slice(0, rowsPerSide);
  const groupedAsksAsc = withCumulative(groupLevelsByTick(book.asks, tickSize, 'ask')).slice(0, rowsPerSide);
  const asksForDraw = [...groupedAsksAsc].reverse(); // best ask nearest the spread row

  const maxCumulative = Math.max(
    groupedBids[groupedBids.length - 1]?.cumulative ?? 0,
    groupedAsksAsc[groupedAsksAsc.length - 1]?.cumulative ?? 0,
    1e-9,
  );

  const asksAreaHeight = asksForDraw.length * ROW_HEIGHT;
  const asksAreaTop = Math.max(0, sideHeight / 2 - asksAreaHeight);
  asksForDraw.forEach((level, i) => {
    drawLevelRow(ctx, width, asksAreaTop + i * ROW_HEIGHT, level, maxCumulative, 'ask', decimals);
  });

  const bidsAreaTop = sideHeight / 2 + MID_ROW_HEIGHT;
  groupedBids.forEach((level, i) => {
    drawLevelRow(ctx, width, bidsAreaTop + i * ROW_HEIGHT, level, maxCumulative, 'bid', decimals);
  });

  // Spread / mid row.
  const mid = computeMidPrice(book.bestBid?.price ?? null, book.bestAsk?.price ?? null);
  ctx.fillStyle = COLORS.headerBg;
  ctx.fillRect(0, sideHeight / 2, width, MID_ROW_HEIGHT);
  ctx.strokeStyle = COLORS.gridLine;
  ctx.beginPath();
  ctx.moveTo(0, sideHeight / 2);
  ctx.lineTo(width, sideHeight / 2);
  ctx.moveTo(0, sideHeight / 2 + MID_ROW_HEIGHT);
  ctx.lineTo(width, sideHeight / 2 + MID_ROW_HEIGHT);
  ctx.stroke();

  ctx.fillStyle = COLORS.textPrimary;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '600 11px sans-serif';
  const label =
    mid !== null
      ? `Mid ${formatPrice(mid, decimals)}   Spread ${book.spread !== null ? formatPrice(book.spread, decimals) : '—'}`
      : 'Mid —';
  ctx.fillText(label, width / 2, sideHeight / 2 + MID_ROW_HEIGHT / 2);
}

function drawLevelRow(
  ctx: CanvasRenderingContext2D,
  width: number,
  y: number,
  level: LevelWithCumulative,
  maxCumulative: number,
  side: 'bid' | 'ask',
  decimals: number,
) {
  const barColor = side === 'bid' ? COLORS.bidBg : COLORS.askBg;
  const textColor = side === 'bid' ? COLORS.bid : COLORS.ask;
  const barWidth = Math.max(0, (level.cumulative / maxCumulative) * width);

  // Cumulative depth bar, right-aligned so bars grow leftward from the panel edge.
  ctx.fillStyle = barColor;
  ctx.fillRect(width - barWidth, y, barWidth, ROW_HEIGHT - 1);

  ctx.textBaseline = 'middle';
  ctx.font = LADDER_FONT;

  ctx.fillStyle = textColor;
  ctx.textAlign = 'left';
  ctx.fillText(formatPrice(level.price, decimals), 6, y + ROW_HEIGHT / 2);

  ctx.fillStyle = COLORS.textPrimary;
  ctx.textAlign = 'right';
  ctx.fillText(level.qty.toFixed(4), width - 6, y + ROW_HEIGHT / 2);
}
