import { describe, it, expect, vi } from 'vitest';
import { SubscriptionManager } from './SubscriptionManager';

describe('SubscriptionManager', () => {
  it('sends one SUBSCRIBE frame for a brand-new stream on flush', () => {
    const sm = new SubscriptionManager();
    sm.subscribe('panel-1', 'btcusdt@depth@100ms');
    const sent = sm.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: 'SUBSCRIBE', params: ['btcusdt@depth@100ms'] });
  });

  it('does not re-subscribe on the wire when a second owner wants an already-active stream', () => {
    const sm = new SubscriptionManager();
    sm.subscribe('panel-1', 'btcusdt@depth@100ms');
    sm.flush();
    sm.subscribe('panel-2', 'btcusdt@depth@100ms');
    expect(sm.flush()).toHaveLength(0);
    expect(sm.activeStreamCount).toBe(1);
  });

  it('keeps a stream alive while any owner still references it', () => {
    const sm = new SubscriptionManager();
    sm.subscribe('panel-1', 'btcusdt@depth@100ms');
    sm.subscribe('panel-2', 'btcusdt@depth@100ms');
    sm.flush();
    sm.unsubscribe('panel-1', 'btcusdt@depth@100ms');
    expect(sm.flush()).toHaveLength(0);
    expect(sm.activeStreamCount).toBe(1);
  });

  it('unsubscribes on the wire once the last owner releases a stream', () => {
    const sm = new SubscriptionManager();
    sm.subscribe('panel-1', 'btcusdt@depth@100ms');
    sm.flush();
    sm.unsubscribe('panel-1', 'btcusdt@depth@100ms');
    const sent = sm.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: 'UNSUBSCRIBE', params: ['btcusdt@depth@100ms'] });
    expect(sm.activeStreamCount).toBe(0);
  });

  it('batches multiple new streams requested before a flush into a single SUBSCRIBE frame', () => {
    const sm = new SubscriptionManager();
    sm.subscribe('p1', 'btcusdt@depth@100ms');
    sm.subscribe('p2', 'ethusdt@depth@100ms');
    sm.subscribe('p3', 'btcusdt@aggTrade');
    const sent = sm.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].params.sort()).toEqual(
      ['btcusdt@aggTrade', 'btcusdt@depth@100ms', 'ethusdt@depth@100ms'].sort(),
    );
  });

  it('throttles frames to the configured messages-per-second budget, deferring the rest', () => {
    let t = 0;
    const sm = new SubscriptionManager({ maxMessagesPerSecond: 1, now: () => t });
    sm.subscribe('p1', 'btcusdt@depth@100ms');
    sm.flush(); // consumes the 1 allowed message in this window
    sm.unsubscribe('p1', 'btcusdt@depth@100ms'); // queues an UNSUBSCRIBE
    sm.subscribe('p2', 'ethusdt@depth@100ms'); // queues a SUBSCRIBE

    // Still within the same 1s window -> rate limit blocks further sends.
    expect(sm.flush()).toHaveLength(0);

    // Advance past the window -> queued frames can now go out.
    t += 1001;
    const sent = sm.flush();
    expect(sent.length).toBeGreaterThan(0);
  });

  it('rejects subscribing to a brand-new stream once at capacity, without affecting existing streams', () => {
    const sm = new SubscriptionManager({ maxStreamsPerConnection: 2 });
    expect(sm.subscribe('p1', 'a@depth@100ms')).toBe(true);
    expect(sm.subscribe('p2', 'b@depth@100ms')).toBe(true);
    expect(sm.isAtCapacity()).toBe(true);
    expect(sm.subscribe('p3', 'c@depth@100ms')).toBe(false);
    expect(sm.activeStreamCount).toBe(2);
  });

  it('still allows a second owner to join an already-active stream even at capacity', () => {
    const sm = new SubscriptionManager({ maxStreamsPerConnection: 1 });
    expect(sm.subscribe('p1', 'a@depth@100ms')).toBe(true);
    expect(sm.subscribe('p2', 'a@depth@100ms')).toBe(true);
    expect(sm.activeStreamCount).toBe(1);
  });

  it('is idempotent for duplicate subscribe calls from the same owner on the same stream', () => {
    const sm = new SubscriptionManager();
    sm.subscribe('p1', 'a@depth@100ms');
    sm.subscribe('p1', 'a@depth@100ms');
    sm.flush();
    sm.unsubscribe('p1', 'a@depth@100ms');
    const sent = sm.flush();
    expect(sent).toHaveLength(1);
    expect(sm.activeStreamCount).toBe(0);
  });
});
