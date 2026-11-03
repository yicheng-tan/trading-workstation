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

const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_JITTER_RATIO = 0.2;
const DEFAULT_STABLE_AFTER_MS = 60_000;
const DEFAULT_PROACTIVE_RECONNECT_AFTER_MS = 23.5 * 3600 * 1000;
const DEFAULT_MAX_PRIMARY_FAILURES_BEFORE_FALLBACK = 3;

/**
 * Exponential backoff + jitter + primary/fallback host selection +
 * proactive-reconnect scheduling ahead of Binance's 24h connection cap.
 */
export class ReconnectPolicy {
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly jitterRatio: number;
  private readonly stableAfterMs: number;
  private readonly proactiveReconnectAfterMs: number;
  private readonly maxPrimaryFailuresBeforeFallback: number;
  private readonly random: () => number;

  /** Total consecutive failures (across hosts), used to compute the exponential backoff exponent. */
  private consecutiveFailures = 0;
  /** Consecutive *primary*-only failures, used to decide when to fall over to the fallback host. */
  private consecutivePrimaryFailures = 0;
  private currentHost: Host = 'primary';
  private connectedAtMs: number | null = null;

  constructor(opts: ReconnectPolicyOptions = {}) {
    this.baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.jitterRatio = opts.jitterRatio ?? DEFAULT_JITTER_RATIO;
    this.stableAfterMs = opts.stableAfterMs ?? DEFAULT_STABLE_AFTER_MS;
    this.proactiveReconnectAfterMs = opts.proactiveReconnectAfterMs ?? DEFAULT_PROACTIVE_RECONNECT_AFTER_MS;
    this.maxPrimaryFailuresBeforeFallback =
      opts.maxPrimaryFailuresBeforeFallback ?? DEFAULT_MAX_PRIMARY_FAILURES_BEFORE_FALLBACK;
    this.random = opts.random ?? (() => Math.random());
  }

  recordFailure(host: Host): FailureDecision {
    this.consecutiveFailures += 1;

    if (host === 'primary') {
      this.consecutivePrimaryFailures += 1;
      if (this.consecutivePrimaryFailures >= this.maxPrimaryFailuresBeforeFallback) {
        this.currentHost = 'fallback';
      } else {
        this.currentHost = 'primary';
      }
    } else {
      // A fallback failure doesn't reset the primary-failure counter; we
      // simply stay on fallback and keep escalating the shared backoff.
      this.currentHost = 'fallback';
    }

    const exponent = this.consecutiveFailures - 1;
    const rawDelay = this.baseDelayMs * Math.pow(2, exponent);
    const cappedDelay = Math.min(rawDelay, this.maxDelayMs);

    // Jitter: +/- jitterRatio of the capped base delay. random() is in
    // [0, 1); map it to [-jitterRatio, +jitterRatio].
    const jitterSpan = cappedDelay * this.jitterRatio;
    const jitterOffset = (this.random() * 2 - 1) * jitterSpan;
    const delayMs = Math.min(this.maxDelayMs, Math.max(0, cappedDelay + jitterOffset));

    return { delayMs, nextHost: this.currentHost };
  }

  recordConnected(atMs: number): void {
    this.connectedAtMs = atMs;
  }

  recordDisconnected(atMs: number): void {
    if (this.connectedAtMs !== null) {
      const uptime = atMs - this.connectedAtMs;
      if (uptime >= this.stableAfterMs) {
        this.consecutiveFailures = 0;
        this.consecutivePrimaryFailures = 0;
      }
    }
    this.connectedAtMs = null;
  }

  shouldProactivelyReconnect(nowMs: number, connectedAtMs: number): boolean {
    return nowMs - connectedAtMs >= this.proactiveReconnectAfterMs;
  }

  reset(): void {
    this.consecutiveFailures = 0;
    this.consecutivePrimaryFailures = 0;
    this.currentHost = 'primary';
    this.connectedAtMs = null;
  }
}
