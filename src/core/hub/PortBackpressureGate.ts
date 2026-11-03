/**
 * Ack-gated, latest-state-wins delivery gate for a single output port (one
 * browser window/panel). Guarantees at most one in-flight batch per port so
 * a slow/backgrounded window can never build an unbounded backlog or block
 * delivery to other windows sharing the same hub.
 */
export class PortBackpressureGate<T> {
  private _inFlight = false;
  private _lastSeqSent = 0;
  private pending: T | null = null;
  private hasPending = false;
  /** The `send` callback captured from the most recent `push()`, reused to flush a coalesced pending payload on ack. */
  private lastSend: ((payload: T, seq: number) => void) | null = null;

  constructor(_opts?: { maxInFlight?: number }) {
    // maxInFlight is reserved for future multi-in-flight support; this gate
    // always enforces at most one in-flight payload per port.
  }

  /** Queue a payload for delivery. Sends immediately if nothing is in flight; otherwise coalesces with any already-pending payload. */
  push(payload: T, send: (payload: T, seq: number) => void): void {
    this.lastSend = send;
    if (this._inFlight) {
      this.pending = payload;
      this.hasPending = true;
      return;
    }
    this._inFlight = true;
    this._lastSeqSent += 1;
    send(payload, this._lastSeqSent);
  }

  /** Acknowledge a previously-sent seq; flushes the latest pending payload, if any. */
  ack(seq: number): void {
    if (seq !== this._lastSeqSent) {
      // Stale/unknown ack - ignore.
      return;
    }
    if (this.hasPending && this.lastSend) {
      const payload = this.pending as T;
      this.pending = null;
      this.hasPending = false;
      this._lastSeqSent += 1;
      this.lastSend(payload, this._lastSeqSent);
      // stays in flight
    } else {
      this._inFlight = false;
    }
  }

  get inFlight(): boolean {
    return this._inFlight;
  }

  get lastSeqSent(): number {
    return this._lastSeqSent;
  }
}
