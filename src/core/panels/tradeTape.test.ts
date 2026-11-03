import { describe, it, expect } from 'vitest';
import { classifyTrade, TapeBuffer } from './tradeTape';
import type { AggTradeEvent } from '../types';

function trade(overrides: Partial<AggTradeEvent> = {}): AggTradeEvent {
  return { e: 'aggTrade', E: 1, s: 'BTCUSDT', a: 1, p: '100.00', q: '2.00', T: 1, m: false, ...overrides };
}

describe('classifyTrade', () => {
  it('marks a trade as "sell" (aggressive sell hitting the bid) when m is true', () => {
    const entry = classifyTrade(trade({ m: true }), 100000);
    expect(entry.side).toBe('sell');
  });

  it('marks a trade as "buy" (aggressive buy lifting the ask) when m is false', () => {
    const entry = classifyTrade(trade({ m: false }), 100000);
    expect(entry.side).toBe('buy');
  });

  it('computes notional as price * qty', () => {
    const entry = classifyTrade(trade({ p: '100.00', q: '2.5' }), 100000);
    expect(entry.notional).toBeCloseTo(250, 9);
  });

  it('flags trades at/above the large-notional threshold', () => {
    const big = classifyTrade(trade({ p: '100.00', q: '100' }), 5000);
    const small = classifyTrade(trade({ p: '100.00', q: '1' }), 5000);
    expect(big.isLarge).toBe(true);
    expect(small.isLarge).toBe(false);
  });

  it('parses string price/qty into numbers precisely', () => {
    const entry = classifyTrade(trade({ p: '63241.57', q: '0.013' }), 100000);
    expect(entry.price).toBeCloseTo(63241.57, 6);
    expect(entry.qty).toBeCloseTo(0.013, 9);
  });
});

describe('TapeBuffer', () => {
  it('returns the most recently pushed entry first', () => {
    const buf = new TapeBuffer(10);
    buf.push(classifyTrade(trade({ a: 1 }), 100000));
    buf.push(classifyTrade(trade({ a: 2 }), 100000));
    expect(buf.entries[0].id).toBe(2);
  });

  it('drops the oldest entry once maxLength is exceeded', () => {
    const buf = new TapeBuffer(2);
    buf.push(classifyTrade(trade({ a: 1 }), 100000));
    buf.push(classifyTrade(trade({ a: 2 }), 100000));
    buf.push(classifyTrade(trade({ a: 3 }), 100000));
    expect(buf.entries.map((e) => e.id)).toEqual([3, 2]);
  });

  it('throws when constructed with a non-positive maxLength', () => {
    expect(() => new TapeBuffer(0)).toThrow();
    expect(() => new TapeBuffer(-1)).toThrow();
  });
});
