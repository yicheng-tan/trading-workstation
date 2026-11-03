/**
 * Ack-gated, latest-state-wins delivery gate for a single output port (one
 * browser window/panel). Guarantees at most one in-flight batch per port so
 * a slow/backgrounded window can never build an unbounded backlog or block
 * delivery to other windows sharing the same hub.
 */
export class PortBackpressureGate<T> {
  constructor(_opts?: { maxInFlight?: number }) {
    throw new Error('not implemented');
  }

  /** Queue a payload for delivery. Sends immediately if nothing is in flight; otherwise coalesces with any already-pending payload. */
  push(_payload: T, _send: (payload: T, seq: number) => void): void {
    throw new Error('not implemented');
  }

  /** Acknowledge a previously-sent seq; flushes the latest pending payload, if any. */
  ack(_seq: number): void {
    throw new Error('not implemented');
  }

  get inFlight(): boolean {
    throw new Error('not implemented');
  }

  get lastSeqSent(): number {
    throw new Error('not implemented');
  }
}
