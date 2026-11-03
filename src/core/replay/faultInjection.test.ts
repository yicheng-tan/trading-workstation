import { describe, it, expect } from 'vitest';
import { injectSequenceGap } from './faultInjection';
import { OrderBookManager } from '../orderbook/OrderBookManager';
import type { DepthDiffEvent } from '../types';

function baseEvent(): DepthDiffEvent {
  return { e: 'depthUpdate', E: 1001, s: 'BTCUSDT', U: 1001, u: 1001, b: [['100.00', '1']], a: [] };
}

describe('injectSequenceGap', () => {
  it('shifts U and u forward by gapSize while preserving the rest of the event', () => {
    const evt = baseEvent();
    const gapped = injectSequenceGap(evt, 10);
    expect(gapped.U).toBe(evt.U + 10);
    expect(gapped.u).toBe(evt.u + 10);
    expect(gapped.b).toEqual(evt.b);
    expect(gapped.s).toBe(evt.s);
  });

  it('defaults to a gap large enough to be detected as non-contiguous', () => {
    const evt = baseEvent();
    const gapped = injectSequenceGap(evt);
    expect(gapped.U).toBeGreaterThan(evt.u + 1);
  });

  it('throws for a non-positive gap size', () => {
    expect(() => injectSequenceGap(baseEvent(), 0)).toThrow();
    expect(() => injectSequenceGap(baseEvent(), -3)).toThrow();
  });

  it('end-to-end: feeding a gapped event into a live OrderBookManager marks it stale and needing resync', () => {
    const m = new OrderBookManager('BTCUSDT');
    m.applySnapshot({ lastUpdateId: 1000, bids: [['100.00', '1']], asks: [['101.00', '1']] });
    expect(m.status).toBe('live');

    const nextContiguous: DepthDiffEvent = { e: 'depthUpdate', E: 1001, s: 'BTCUSDT', U: 1001, u: 1001, b: [], a: [] };
    const gapped = injectSequenceGap(nextContiguous, 10);
    m.applyDiff(gapped);

    expect(m.status).toBe('stale');
    expect(m.needsResync()).toBe(true);
  });
});
