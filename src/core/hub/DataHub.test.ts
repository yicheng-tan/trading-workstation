import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataHub } from './DataHub';
import type { HubPort, HubToClientMsg } from './protocol';
import type { DepthDiffEvent, KlineEvent, OrderBookSnapshotView, StreamRef } from '../types';

class FakeSocket {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  constructor(public readonly url: string) {
    FakeSocket.instances.push(this);
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.({});
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

interface FakeResponseInit {
  status?: number;
  retryAfterSec?: number;
  json?: unknown;
  text?: string;
}

function response({ status = 200, retryAfterSec, json, text }: FakeResponseInit): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name === 'Retry-After' && retryAfterSec !== undefined ? String(retryAfterSec) : null) },
    json: async () => json,
    text: async () => text ?? '',
  } as unknown as Response;
}

/** Records everything the hub sends and acks it right away, like a client that renders instantly. */
function connectPort(hub: DataHub, clientId: string) {
  const received: HubToClientMsg[] = [];
  const port: HubPort = {
    clientId,
    send(msg) {
      received.push(msg);
      if ('seq' in msg && typeof msg.seq === 'number') {
        const seq = msg.seq;
        queueMicrotask(() => hub.handleClientMessage(port, { type: 'ack', clientId, seq }));
      }
    },
  };
  hub.handleClientMessage(port, { type: 'hello', clientId, windowRole: 'main' });
  let subCounter = 0;
  return {
    received,
    subscribe(ref: StreamRef) {
      hub.handleClientMessage(port, { type: 'subscribe', clientId, subId: `s${++subCounter}`, ref });
    },
    books(symbol: string): OrderBookSnapshotView[] {
      return received
        .filter((m): m is Extract<HubToClientMsg, { type: 'orderBook' }> => m.type === 'orderBook')
        .map((m) => m.book)
        .filter((b) => b.symbol === symbol);
    },
    of<T extends HubToClientMsg['type']>(type: T) {
      return received.filter((m): m is Extract<HubToClientMsg, { type: T }> => m.type === type);
    },
  };
}

function diff(s: string, U: number, u: number): DepthDiffEvent {
  return { e: 'depthUpdate', E: Date.now(), s, U, u, b: [['100.00', '1.0']], a: [['101.00', '1.0']] };
}

const depthCalls = (fetchImpl: ReturnType<typeof vi.fn>, symbol: string) =>
  fetchImpl.mock.calls.filter(([url]) => String(url).includes('/api/v3/depth') && String(url).includes(`symbol=${symbol}`)).length;

describe('DataHub', () => {
  let hub: DataHub | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    FakeSocket.instances = [];
  });

  afterEach(() => {
    hub?.dispose();
    hub = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeHub(fetchImpl: ReturnType<typeof vi.fn>) {
    hub = new DataHub({ webSocketImpl: FakeSocket as never, fetchImpl: fetchImpl as never });
    const socket = FakeSocket.instances[0];
    socket.open();
    return { hub, socket };
  }

  describe('REST depth snapshot retries', () => {
    it('retries a failed snapshot with exponential backoff even when no diffs arrive', async () => {
      const fetchImpl = vi.fn(async () => response({ status: 500 }));
      const { hub } = makeHub(fetchImpl);
      connectPort(hub, 'c1').subscribe({ kind: 'depth', symbol: 'BTCUSDT' });
      await vi.advanceTimersByTimeAsync(0);
      expect(depthCalls(fetchImpl, 'BTCUSDT')).toBe(1);

      await vi.advanceTimersByTimeAsync(999);
      expect(depthCalls(fetchImpl, 'BTCUSDT')).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(depthCalls(fetchImpl, 'BTCUSDT')).toBe(2);

      // Second failure doubles the wait to 2s.
      await vi.advanceTimersByTimeAsync(1999);
      expect(depthCalls(fetchImpl, 'BTCUSDT')).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(depthCalls(fetchImpl, 'BTCUSDT')).toBe(3);
    });

    it('does not fire a snapshot per diff while a book stays desynced', async () => {
      const fetchImpl = vi.fn(async () => response({ status: 500 }));
      const { hub, socket } = makeHub(fetchImpl);
      connectPort(hub, 'c1').subscribe({ kind: 'depth', symbol: 'BTCUSDT' });
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 20; i++) socket.emit(diff('BTCUSDT', 100 + i, 100 + i));
      await vi.advanceTimersByTimeAsync(0);
      expect(depthCalls(fetchImpl, 'BTCUSDT')).toBe(1);
    });

    it('pauses every snapshot fetch for Retry-After after a 429', async () => {
      let first = true;
      const fetchImpl = vi.fn(async () => {
        if (first) {
          first = false;
          return response({ status: 429, retryAfterSec: 5 });
        }
        return response({ status: 500 });
      });
      const { hub } = makeHub(fetchImpl);
      const port = connectPort(hub, 'c1');
      port.subscribe({ kind: 'depth', symbol: 'BTCUSDT' });
      await vi.advanceTimersByTimeAsync(0);
      port.subscribe({ kind: 'depth', symbol: 'ETHUSDT' });
      await vi.advanceTimersByTimeAsync(4900);
      expect(depthCalls(fetchImpl, 'BTCUSDT')).toBe(1);
      expect(depthCalls(fetchImpl, 'ETHUSDT')).toBe(0);

      await vi.advanceTimersByTimeAsync(250);
      expect(depthCalls(fetchImpl, 'BTCUSDT')).toBe(2);
      expect(depthCalls(fetchImpl, 'ETHUSDT')).toBe(1);
    });
  });

  describe('candle history', () => {
    const minute = 60_000;
    const t0 = 1_700_000_000_000 - (1_700_000_000_000 % minute);
    const row = (openTime: number, close: string) => [openTime, '1', '2', '0.5', close, '10', openTime + minute - 1, '0', 1, '0', '0', '0'];

    it('sends REST history once as candleHistory, then streams live candles and appends them for later subscribers', async () => {
      const fetchImpl = vi.fn(async () => response({ json: [row(t0, '1.1'), row(t0 + minute, '1.2'), row(t0 + 2 * minute, '1.3')] }));
      const { hub, socket } = makeHub(fetchImpl);
      const a = connectPort(hub, 'a');
      a.subscribe({ kind: 'kline', symbol: 'BTCUSDT', interval: '1m' });
      await vi.advanceTimersByTimeAsync(0);

      const history = a.of('candleHistory');
      expect(history).toHaveLength(1);
      expect(history[0].candles.map((c) => c.close)).toEqual([1.1, 1.2, 1.3]);

      const kline: KlineEvent = {
        e: 'kline',
        E: t0 + 3 * minute,
        s: 'BTCUSDT',
        k: { t: t0 + 3 * minute, T: t0 + 4 * minute - 1, i: '1m', o: '1.3', c: '1.4', h: '1.5', l: '1.2', v: '3', x: false },
      };
      socket.emit(kline);
      await vi.advanceTimersByTimeAsync(0);
      expect(a.of('candle').at(-1)?.candle.close).toBe(1.4);

      const b = connectPort(hub, 'b');
      b.subscribe({ kind: 'kline', symbol: 'BTCUSDT', interval: '1m' });
      expect(b.of('candleHistory')[0].candles.map((c) => c.close)).toEqual([1.1, 1.2, 1.3, 1.4]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });

  describe('trade tape backfill', () => {
    it('seeds a new tape from REST and keeps live prints that arrived first', async () => {
      let resolveRest!: (r: Response) => void;
      const fetchImpl = vi.fn((_url: string) => new Promise<Response>((r) => (resolveRest = r)));
      const { hub, socket } = makeHub(fetchImpl);
      const port = connectPort(hub, 'c1');
      port.subscribe({ kind: 'aggTrade', symbol: 'ADAUSDT' });
      expect(String(fetchImpl.mock.calls[0][0])).toContain('/api/v3/aggTrades?symbol=ADAUSDT');

      socket.emit({ e: 'aggTrade', E: 3, s: 'ADAUSDT', a: 12, p: '0.5', q: '10', T: 3, m: false });
      await vi.advanceTimersByTimeAsync(0);
      resolveRest(
        response({
          json: [
            { a: 10, p: '0.49', q: '5', T: 1, m: true },
            { a: 11, p: '0.5', q: '5', T: 2, m: false },
            { a: 12, p: '0.5', q: '10', T: 3, m: false },
          ],
        }),
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(port.of('trades').at(-1)?.trades.map((t) => t.id)).toEqual([12, 11, 10]);
    });
  });

  describe('replay', () => {
    const recording = [
      { tMs: 0, payload: { stream: 'btcusdt@depth@100ms', data: diff('BTCUSDT', 101, 105) } },
      { tMs: 10, payload: { stream: 'btcusdt@depthSnapshot', data: { s: 'BTCUSDT', lastUpdateId: 102, bids: [['99.00', '2']], asks: [['102.00', '2']] } } },
      { tMs: 20, payload: { stream: 'btcusdt@depth@100ms', data: diff('BTCUSDT', 106, 110) } },
      {
        tMs: 30,
        payload: { stream: 'btcusdt@aggTrade', data: { e: 'aggTrade', E: 1, s: 'BTCUSDT', a: 7, p: '100.5', q: '0.1', T: 1, m: false } },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n');

    function replayFetch() {
      return vi.fn(async (url: string) => {
        if (url.includes('replay-sample')) return response({ text: recording });
        if (url.includes('aggTrades')) return response({ json: [] });
        return response({ json: { lastUpdateId: 5000, bids: [['100.00', '1']], asks: [['101.00', '1']] } });
      });
    }

    it('rebuilds replayed books from the recorded snapshot, ignores their live frames, and leaves other symbols live', async () => {
      const fetchImpl = replayFetch();
      const { hub, socket } = makeHub(fetchImpl);
      const port = connectPort(hub, 'c1');
      port.subscribe({ kind: 'depth', symbol: 'BTCUSDT' });
      port.subscribe({ kind: 'depth', symbol: 'ETHUSDT' });
      port.subscribe({ kind: 'aggTrade', symbol: 'BTCUSDT' });
      await vi.advanceTimersByTimeAsync(0);
      expect(port.books('BTCUSDT').at(-1)?.lastUpdateId).toBe(5000);

      hub.setReplayMode(true, 1);
      await vi.advanceTimersByTimeAsync(25);
      const replayed = port.books('BTCUSDT').at(-1)!;
      expect(replayed.status).toBe('live');
      expect(replayed.lastUpdateId).toBe(110);

      socket.emit(diff('BTCUSDT', 5001, 5002));
      socket.emit(diff('ETHUSDT', 5001, 5002));
      await vi.advanceTimersByTimeAsync(0);
      expect(port.books('BTCUSDT').at(-1)?.lastUpdateId).toBe(110);
      expect(port.books('ETHUSDT').at(-1)?.lastUpdateId).toBe(5002);

      await vi.advanceTimersByTimeAsync(10);
      expect(port.of('trades').some((m) => m.trades.some((t) => t.id === 7))).toBe(true);
      expect(depthCalls(fetchImpl, 'BTCUSDT')).toBe(1);
    });

    it('loops the recording from a clean book and resyncs from live REST when stopped', async () => {
      const fetchImpl = replayFetch();
      const { hub } = makeHub(fetchImpl);
      const port = connectPort(hub, 'c1');
      port.subscribe({ kind: 'depth', symbol: 'BTCUSDT' });
      await vi.advanceTimersByTimeAsync(0);

      hub.setReplayMode(true, 1);
      await vi.advanceTimersByTimeAsync(30);
      const before = port.books('BTCUSDT').length;
      await vi.advanceTimersByTimeAsync(30); // second pass
      const secondPass = port.books('BTCUSDT').slice(before);
      expect(secondPass[0].status).toBe('uninitialized');
      expect(secondPass.at(-1)?.lastUpdateId).toBe(110);

      hub.setReplayMode(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(depthCalls(fetchImpl, 'BTCUSDT')).toBe(2);
      expect(port.books('BTCUSDT').at(-1)?.lastUpdateId).toBe(5000);
    });
  });
});
