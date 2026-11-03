/**
 * Records a short sample of REAL live Binance Spot production market data
 * to disk, in the `RecordedEvent<T>` shape `ReplayEngine` consumes.
 *
 * Per the PRD constraint ("If you replay recorded data, record your own
 * short sample from the live streams rather than using archived Binance
 * datasets"), this is how the bundled replay sample is produced.
 *
 * Usage:
 *   npm run record:sample -- [symbols] [durationSeconds] [outPath]
 *   e.g. npm run record:sample -- btcusdt,ethusdt,solusdt 30 public/samples/replay-sample.ndjson
 *
 * Defaults: symbols="btcusdt,ethusdt,solusdt", durationSeconds=30,
 * outPath="samples/sample-<timestamp>.ndjson".
 *
 * Records `<symbol>@depth@100ms` + `<symbol>@aggTrade` for every symbol over
 * one combined-stream connection, and - once diffs are flowing - one REST
 * depth snapshot per symbol, written inline as a
 * `{ stream: '<symbol>@depthSnapshot', data: { s, lastUpdateId, bids, asks } }`
 * line at the moment it arrived. That's exactly Binance's local-order-book
 * procedure (buffer diffs, fetch snapshot, replay), so the hub can rebuild a
 * consistent book from the recording alone. Uses Node's built-in `WebSocket`
 * and `fetch` (Node 22+); falls back to the binance.vision hosts if the
 * primary ones are unreachable.
 */

import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RecordedEvent } from '../src/core/replay/ReplayEngine';

// Node 22+ ships a global `WebSocket` (undici-backed), but
// @types/node doesn't declare it without the `dom` lib, which this
// Node-only script intentionally doesn't pull in. Declare just the
// surface we use; this is purely a compile-time ambient type.
interface MinimalWebSocketEventMap {
  open: unknown;
  close: unknown;
  error: unknown;
  message: { data: string | ArrayBuffer | Blob };
}
interface MinimalWebSocket {
  addEventListener<K extends keyof MinimalWebSocketEventMap>(
    type: K,
    listener: (ev: MinimalWebSocketEventMap[K]) => void,
  ): void;
  close(): void;
}
declare const WebSocket: { new (url: string): MinimalWebSocket };

const DEFAULT_SYMBOLS = 'btcusdt,ethusdt,solusdt';
const DEFAULT_DURATION_SECONDS = 30;
const HOSTS = [
  { ws: 'wss://stream.binance.com:9443', rest: 'https://api.binance.com' },
  { ws: 'wss://data-stream.binance.vision', rest: 'https://data-api.binance.vision' },
];
const CONNECT_TIMEOUT_MS = 10_000;
/** Let diffs buffer for a moment before snapshotting, as the sync procedure expects. */
const SNAPSHOT_DELAY_MS = 1500;

function streamPath(symbols: string[]): string {
  return `/stream?streams=${symbols.flatMap((s) => [`${s}@depth@100ms`, `${s}@aggTrade`]).join('/')}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connect(url: string): Promise<MinimalWebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error(`timed out connecting to ${url}`)), CONNECT_TIMEOUT_MS);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`connection error for ${url}`));
    });
  });
}

async function main(): Promise<void> {
  const [, , symbolsArg, durationArg, outArg] = process.argv;
  const symbols = (symbolsArg ?? DEFAULT_SYMBOLS).toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  const durationSeconds = Number(durationArg ?? DEFAULT_DURATION_SECONDS);

  if (symbols.length === 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    console.error('Usage: recordSample.ts [symbols,comma,separated] [durationSeconds>0] [outPath]');
    process.exitCode = 1;
    return;
  }

  const outPath = outArg ?? join(process.cwd(), 'samples', `sample-${Date.now()}.ndjson`);
  mkdirSync(dirname(outPath), { recursive: true });

  let ws: MinimalWebSocket | null = null;
  let host = HOSTS[0];
  for (const candidate of HOSTS) {
    const url = candidate.ws + streamPath(symbols);
    try {
      console.log(`Connecting to ${url} ...`);
      ws = await connect(url);
      host = candidate;
      break;
    } catch (err) {
      console.warn(`  failed: ${(err as Error).message}`);
    }
  }
  if (!ws) {
    console.error('Failed to connect to any Binance WebSocket host (no network, or both hosts blocked).');
    process.exitCode = 1;
    return;
  }

  console.log(`Recording ${symbols.join(', ')} (depth@100ms + aggTrade) for ${durationSeconds}s from ${host.ws} ...`);

  const events: RecordedEvent<unknown>[] = [];
  const startedAt = Date.now();
  const record = (payload: unknown) => events.push({ tMs: Date.now() - startedAt, payload });

  ws.addEventListener('message', (ev) => {
    try {
      record(JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)));
    } catch {
      // skip unparsable frames
    }
  });
  ws.addEventListener('close', () => console.log('WebSocket closed by the server before the recording window elapsed.'));

  await sleep(SNAPSHOT_DELAY_MS);
  await Promise.all(
    symbols.map(async (symbol) => {
      const res = await fetch(`${host.rest}/api/v3/depth?symbol=${symbol.toUpperCase()}&limit=1000`);
      if (!res.ok) throw new Error(`depth snapshot for ${symbol} failed: ${res.status}`);
      const snap = (await res.json()) as { lastUpdateId: number; bids: unknown; asks: unknown };
      record({ stream: `${symbol}@depthSnapshot`, data: { s: symbol.toUpperCase(), ...snap } });
    }),
  );

  await sleep(Math.max(0, durationSeconds * 1000 - (Date.now() - startedAt)));
  try {
    ws.close();
  } catch {
    // already closed
  }

  events.sort((a, b) => a.tMs - b.tMs);
  writeFileSync(outPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

  console.log('\n--- Recording summary ---');
  console.log(`Symbols:     ${symbols.join(', ')}`);
  console.log(`Host:        ${host.ws}`);
  console.log(`Duration:    ${durationSeconds}s`);
  console.log(`Event count: ${events.length}`);
  console.log(`Output file: ${outPath} (${statSync(outPath).size} bytes)`);
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error('recordSample.ts failed:', err);
    process.exit(1);
  });
