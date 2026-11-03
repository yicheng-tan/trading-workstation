export interface SubscribeFrame {
  method: 'SUBSCRIBE' | 'UNSUBSCRIBE';
  params: string[];
  id: number;
}

export interface SubscriptionManagerOptions {
  /** Binance caps outbound control messages at 5/sec per connection. */
  maxMessagesPerSecond?: number;
  /** Binance caps a single connection at 1024 streams. */
  maxStreamsPerConnection?: number;
  now?: () => number;
}

const DEFAULT_MAX_MESSAGES_PER_SECOND = 5;
const DEFAULT_MAX_STREAMS_PER_CONNECTION = 1024;
const RATE_WINDOW_MS = 1000;

/**
 * Tracks which streams are needed (ref-counted across many panel "owners"),
 * batches SUBSCRIBE/UNSUBSCRIBE frames to minimize message count, and
 * throttles outgoing frames to stay within Binance's rate limit.
 */
export class SubscriptionManager {
  private readonly maxMessagesPerSecond: number;
  private readonly maxStreamsPerConnection: number;
  private readonly now: () => number;

  /** stream -> set of owner ids currently referencing it. */
  private owners = new Map<string, Set<string>>();
  /** Streams newly activated since the last successful flush; need a SUBSCRIBE frame. */
  private pendingSubscribe = new Set<string>();
  /** Streams newly deactivated since the last successful flush; need an UNSUBSCRIBE frame. */
  private pendingUnsubscribe = new Set<string>();

  /** Timestamps (per `now()`) of frames sent within the current rolling window. */
  private sendTimestamps: number[] = [];
  private nextId = 1;

  constructor(opts: SubscriptionManagerOptions = {}) {
    this.maxMessagesPerSecond = opts.maxMessagesPerSecond ?? DEFAULT_MAX_MESSAGES_PER_SECOND;
    this.maxStreamsPerConnection = opts.maxStreamsPerConnection ?? DEFAULT_MAX_STREAMS_PER_CONNECTION;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Returns false (and does nothing) if accepting a brand-new stream would exceed capacity. */
  subscribe(ownerId: string, stream: string): boolean {
    const existingOwners = this.owners.get(stream);
    const isBrandNewStream = !existingOwners || existingOwners.size === 0;

    if (isBrandNewStream && this.activeStreamCount >= this.maxStreamsPerConnection) {
      return false;
    }

    if (!existingOwners) {
      this.owners.set(stream, new Set([ownerId]));
    } else {
      existingOwners.add(ownerId);
    }

    if (isBrandNewStream) {
      // If this stream was queued for UNSUBSCRIBE (raced back to life before
      // the frame went out), cancel that instead of sending both frames.
      if (this.pendingUnsubscribe.has(stream)) {
        this.pendingUnsubscribe.delete(stream);
      } else {
        this.pendingSubscribe.add(stream);
      }
    }

    return true;
  }

  unsubscribe(ownerId: string, stream: string): void {
    const existingOwners = this.owners.get(stream);
    if (!existingOwners || !existingOwners.has(ownerId)) {
      return;
    }
    existingOwners.delete(ownerId);
    if (existingOwners.size === 0) {
      this.owners.delete(stream);
      if (this.pendingSubscribe.has(stream)) {
        // Never actually went out on the wire; just drop the intent.
        this.pendingSubscribe.delete(stream);
      } else {
        this.pendingUnsubscribe.add(stream);
      }
    }
  }

  get activeStreamCount(): number {
    return this.owners.size;
  }

  get pendingCount(): number {
    return this.pendingSubscribe.size + this.pendingUnsubscribe.size;
  }

  isAtCapacity(): boolean {
    return this.activeStreamCount >= this.maxStreamsPerConnection;
  }

  /** Attempt to flush queued frames, respecting the rolling-window rate limit. Returns the frames actually sent. */
  flush(): SubscribeFrame[] {
    const sent: SubscribeFrame[] = [];

    if (this.pendingSubscribe.size > 0 && this.tryRecordSend()) {
      sent.push({ method: 'SUBSCRIBE', params: Array.from(this.pendingSubscribe), id: this.nextId++ });
      this.pendingSubscribe = new Set();
    }

    if (this.pendingUnsubscribe.size > 0 && this.tryRecordSend()) {
      sent.push({ method: 'UNSUBSCRIBE', params: Array.from(this.pendingUnsubscribe), id: this.nextId++ });
      this.pendingUnsubscribe = new Set();
    }

    return sent;
  }

  /** Returns true (and records the send) if sending one more frame right now stays within the rate budget. */
  private tryRecordSend(): boolean {
    const now = this.now();
    this.sendTimestamps = this.sendTimestamps.filter((t) => now - t < RATE_WINDOW_MS);
    if (this.sendTimestamps.length >= this.maxMessagesPerSecond) {
      return false;
    }
    this.sendTimestamps.push(now);
    return true;
  }
}
