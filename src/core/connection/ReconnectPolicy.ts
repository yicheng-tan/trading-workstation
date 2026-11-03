export type Host = 'primary' | 'fallback';

export interface ReconnectPolicyOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  /** Connection uptime after which a subsequent disconnect resets backoff to base. */
  stableAfterMs?: number;
  /** Proactively reconnect before Binance's own 24h forced-disconnect. */
  proactiveReconnectAfterMs?: number;
  maxPrimaryFailuresBeforeFallback?: number;
  /** Injectable RNG in [0, 1) for deterministic jitter in tests. */
  random?: () => number;
}

export interface FailureDecision {
  delayMs: number;
  nextHost: Host;
}

/**
 * Exponential backoff + jitter + primary/fallback host selection +
 * proactive-reconnect scheduling ahead of Binance's 24h connection cap.
 */
export class ReconnectPolicy {
  constructor(_opts?: ReconnectPolicyOptions) {
    throw new Error('not implemented');
  }

  recordFailure(_host: Host): FailureDecision {
    throw new Error('not implemented');
  }

  recordConnected(_atMs: number): void {
    throw new Error('not implemented');
  }

  recordDisconnected(_atMs: number): void {
    throw new Error('not implemented');
  }

  shouldProactivelyReconnect(_nowMs: number, _connectedAtMs: number): boolean {
    throw new Error('not implemented');
  }

  reset(): void {
    throw new Error('not implemented');
  }
}
