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

/**
 * Tracks which streams are needed (ref-counted across many panel "owners"),
 * batches SUBSCRIBE/UNSUBSCRIBE frames to minimize message count, and
 * throttles outgoing frames to stay within Binance's rate limit.
 */
export class SubscriptionManager {
  constructor(_opts?: SubscriptionManagerOptions) {
    throw new Error('not implemented');
  }

  /** Returns false (and does nothing) if accepting a brand-new stream would exceed capacity. */
  subscribe(_ownerId: string, _stream: string): boolean {
    throw new Error('not implemented');
  }

  unsubscribe(_ownerId: string, _stream: string): void {
    throw new Error('not implemented');
  }

  get activeStreamCount(): number {
    throw new Error('not implemented');
  }

  get pendingCount(): number {
    throw new Error('not implemented');
  }

  isAtCapacity(): boolean {
    throw new Error('not implemented');
  }

  /** Attempt to flush queued frames, respecting the rolling-window rate limit. Returns the frames actually sent. */
  flush(): SubscribeFrame[] {
    throw new Error('not implemented');
  }
}
