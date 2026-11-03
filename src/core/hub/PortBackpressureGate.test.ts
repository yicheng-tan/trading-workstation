import { describe, it, expect, vi } from 'vitest';
import { PortBackpressureGate } from './PortBackpressureGate';

describe('PortBackpressureGate', () => {
  it('sends the first push immediately with seq 1', () => {
    const gate = new PortBackpressureGate<string>();
    const send = vi.fn();
    gate.push('a', send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('a', 1);
    expect(gate.inFlight).toBe(true);
  });

  it('does not send a second push while a batch is still in flight', () => {
    const gate = new PortBackpressureGate<string>();
    const send = vi.fn();
    gate.push('a', send);
    gate.push('b', send);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('coalesces multiple pushes made while in flight, delivering only the latest on ack', () => {
    const gate = new PortBackpressureGate<string>();
    const send = vi.fn();
    gate.push('a', send);
    gate.push('b', send);
    gate.push('c', send);
    gate.ack(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith('c', 2);
  });

  it('becomes idle (not in flight) after ack when there is no pending payload', () => {
    const gate = new PortBackpressureGate<string>();
    const send = vi.fn();
    gate.push('a', send);
    gate.ack(1);
    expect(gate.inFlight).toBe(false);
  });

  it('ignores a stale ack that does not match the last sent seq', () => {
    const gate = new PortBackpressureGate<string>();
    const send = vi.fn();
    gate.push('a', send);
    gate.push('b', send); // pending
    gate.ack(999); // stale/unknown seq
    expect(send).toHaveBeenCalledTimes(1); // pending 'b' must not have been flushed by a bad ack
  });

  it('tracks lastSeqSent monotonically increasing across multiple flush cycles', () => {
    const gate = new PortBackpressureGate<number>();
    const send = vi.fn();
    gate.push(1, send);
    expect(gate.lastSeqSent).toBe(1);
    gate.push(2, send); // pending
    gate.ack(1);
    expect(gate.lastSeqSent).toBe(2);
  });
});
