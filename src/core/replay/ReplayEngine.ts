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
  constructor(
    _events: RecordedEvent<T>[],
    _onEvent: (payload: T, index: number) => void,
    _opts?: ReplayEngineOptions,
  ) {
    throw new Error('not implemented');
  }

  start(): void {
    throw new Error('not implemented');
  }

  pause(): void {
    throw new Error('not implemented');
  }

  resume(): void {
    throw new Error('not implemented');
  }

  stop(): void {
    throw new Error('not implemented');
  }

  setSpeed(_speed: number): void {
    throw new Error('not implemented');
  }

  get isPlaying(): boolean {
    throw new Error('not implemented');
  }

  get nextIndex(): number {
    throw new Error('not implemented');
  }
}
