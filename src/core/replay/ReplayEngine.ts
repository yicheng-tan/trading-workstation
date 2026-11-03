export interface RecordedEvent<T = unknown> {
  /** Relative offset in ms from the start of the recording. */
  tMs: number;
  payload: T;
}

export interface ReplayEngineOptions {
  speed?: number;
  setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  now?: () => number;
}

/**
 * Replays a recorded sequence of events (our own captured Binance stream
 * samples) through the same pipeline the live hub uses, at an adjustable
 * speed, for deterministic stress testing. Never uses archived Binance
 * datasets - only our own short recordings per the PRD.
 */
export class ReplayEngine<T = unknown> {
  private readonly setTimeoutFn: (cb: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly nowFn: () => number;

  private speed = 1;
  private _nextIndex = 0;
  private _isPlaying = false;
  private timerHandle: unknown | null = null;
  private scheduledAtMs: number | null = null;
  private currentDelayMs: number | null = null;
  private remainingMs: number | null = null;

  constructor(
    private readonly events: RecordedEvent<T>[],
    private readonly onEvent: (payload: T, index: number) => void,
    opts?: ReplayEngineOptions,
  ) {
    this.setTimeoutFn = opts?.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimeoutFn = opts?.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.nowFn = opts?.now ?? (() => Date.now());
    if (opts?.speed !== undefined) {
      this.setSpeed(opts.speed);
    }
  }

  start(): void {
    if (this.events.length === 0) return;
    this._nextIndex = 0;
    this._isPlaying = true;
    this.remainingMs = null;
    const first = this.events[0];
    this.scheduleTimer(first.tMs / this.speed);
  }

  pause(): void {
    if (this.timerHandle !== null) {
      this.clearTimeoutFn(this.timerHandle);
      const elapsed = this.nowFn() - (this.scheduledAtMs ?? this.nowFn());
      this.remainingMs = Math.max(0, (this.currentDelayMs ?? 0) - elapsed);
      this.timerHandle = null;
    }
    this._isPlaying = false;
  }

  resume(): void {
    if (this.remainingMs === null) return;
    this._isPlaying = true;
    const delay = this.remainingMs;
    this.remainingMs = null;
    this.scheduleTimer(delay);
  }

  stop(): void {
    if (this.timerHandle !== null) {
      this.clearTimeoutFn(this.timerHandle);
      this.timerHandle = null;
    }
    this.remainingMs = null;
    this._isPlaying = false;
    this._nextIndex = 0;
  }

  setSpeed(speed: number): void {
    if (speed <= 0) {
      throw new Error('ReplayEngine.setSpeed: speed must be a positive number');
    }
    this.speed = speed;
  }

  get isPlaying(): boolean {
    return this._isPlaying;
  }

  get nextIndex(): number {
    return this._nextIndex;
  }

  private scheduleTimer(delayMs: number): void {
    this.scheduledAtMs = this.nowFn();
    this.currentDelayMs = delayMs;
    this.timerHandle = this.setTimeoutFn(() => this.fire(), delayMs);
  }

  private fire(): void {
    this.timerHandle = null;
    const idx = this._nextIndex;
    const evt = this.events[idx];
    this._nextIndex = idx + 1;
    this.onEvent(evt.payload, idx);

    if (this._nextIndex >= this.events.length) {
      this._isPlaying = false;
      return;
    }

    const next = this.events[this._nextIndex];
    const delay = (next.tMs - evt.tMs) / this.speed;
    this.scheduleTimer(delay);
  }
}
