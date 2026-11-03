/**
 * Records a short sample of REAL live Binance Spot production market data
 * to disk, in the `RecordedEvent<T>` shape `ReplayEngine` consumes.
 *
 * Per the PRD constraint ("If you replay recorded data, record your own
 * short sample from the live streams rather than using archived Binance
 * datasets"), this is how that sample gets produced - run it once, check
 * the resulting file into `samples/`, and `ReplayEngine` + the stress
 * controls replay it at adjustable speed for deterministic testing.
 *
 * Usage:
 *   npx tsx scripts/recordSample.ts [symbol] [durationSeconds]
 *   npm run record:sample -- [symbol] [durationSeconds]
 *
 * Defaults: symbol="btcusdt", durationSeconds=60.
 *
 * Connects to the combined-stream endpoint for `<symbol>@depth@100ms` +
 * `<symbol>@aggTrade` using Node's built-in global `WebSocket` (stable in
 * Node 20.15+/22+, confirmed working in this environment on Node v26) -
 * no `ws` package needed. Falls back to data-stream.binance.vision if the
 * primary host is unreachable (e.g. geo-blocked), per the PRD's note.
 */

import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RecordedEvent } from '../src/core/replay/ReplayEngine';

// Node 20.15+/22+ ships a global `WebSocket` (undici-backed), but
// @types/node doesn't declare it without the `dom` lib, which this
// Node-only script intentionally doesn't pull in. Declare just the
// surface we use; this is purely a compile-time ambient type and has no
// effect on the real global at runtime.
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

const DEFAULT_SYMBOL = 'btcusdt';
const DEFAULT_DURATION_SECONDS = 60;
const PRIMARY_HOST = 'wss://stream.binance.com:9443';
const FALLBACK_HOST = 'wss://data-stream.binance.vision';
const CONNECT_TIMEOUT_MS = 10_000;

function streamPath(symbol: string): string {
  return `/stream?streams=${symbol}@depth@100ms/${symbol}@aggTrade`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connect(url: string): Promise<MinimalWebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      reject(new Error(`timed out connecting to ${url}`));
    }, CONNECT_TIMEOUT_MS);
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

async function connectWithFallback(symbol: string): Promise<{ ws: MinimalWebSocket; host: string }> {
  const primaryUrl = PRIMARY_HOST + streamPath(symbol);
  try {
    console.log(`Connecting to ${primaryUrl} ...`);
    const ws = await connect(primaryUrl);
    return { ws, host: PRIMARY_HOST };
  } catch (err) {
    console.warn(`Primary host failed (${(err as Error).message}).`);
    console.warn('Falling back to data-stream.binance.vision ...');
    const fallbackUrl = FALLBACK_HOST + streamPath(symbol);
    console.log(`Connecting to ${fallbackUrl} ...`);
    const ws = await connect(fallbackUrl);
    return { ws, host: FALLBACK_HOST };
  }
}

async function main(): Promise<void> {
  const [, , symbolArg, durationArg] = process.argv;
  const symbol = (symbolArg ?? DEFAULT_SYMBOL).toLowerCase();
  const durationSeconds = Number(durationArg ?? DEFAULT_DURATION_SECONDS);

  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    console.error(`Invalid durationSeconds: "${durationArg}" - must be a positive number.`);
    process.exitCode = 1;
    return;
  }

  const samplesDir = join(process.cwd(), 'samples');
  mkdirSync(samplesDir, { recursive: true });

  const startUnixMs = Date.now();
  const outPath = join(samplesDir, `sample-${symbol}-${startUnixMs}.ndjson`);

  let ws: MinimalWebSocket;
  let host: string;
  try {
    ({ ws, host } = await connectWithFallback(symbol));
  } catch (err) {
    console.error('Failed to connect to any Binance WebSocket host:', (err as Error).message);
    console.error('(No network access, or both hosts are blocked from this environment.)');
    process.exitCode = 1;
    return;
  }

  console.log(`Connected to ${host}.`);
  console.log(`Recording ${symbol}@depth@100ms + ${symbol}@aggTrade for ${durationSeconds}s ...`);

  const events: RecordedEvent<unknown>[] = [];
  let firstMessageAtMs: number | null = null;

  ws.addEventListener('message', (ev) => {
    const now = Date.now();
    if (firstMessageAtMs === null) firstMessageAtMs = now;
    const tMs = now - firstMessageAtMs;

    const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return; // skip any non-JSON/unparsable frame
    }
    events.push({ tMs, payload });
  });

  ws.addEventListener('error', () => {
    console.warn('WebSocket error during recording (continuing until the timer elapses).');
  });

  ws.addEventListener('close', () => {
    console.log('WebSocket closed by the server before the recording window elapsed.');
  });

  await sleep(durationSeconds * 1000);

  try {
    ws.close();
  } catch {
    // already closed - fine.
  }

  const ndjson = events.map((e) => JSON.stringify(e)).join('\n') + (events.length > 0 ? '\n' : '');
  writeFileSync(outPath, ndjson, 'utf8');
  const { size } = statSync(outPath);

  console.log('\n--- Recording summary ---');
  console.log(`Symbol:      ${symbol}`);
  console.log(`Host:        ${host}`);
  console.log(`Duration:    ${durationSeconds}s`);
  console.log(`Event count: ${events.length}`);
  console.log(`Output file: ${outPath}`);
  console.log(`File size:   ${size} bytes`);
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error('recordSample.ts failed:', err);
    process.exit(1);
  });
