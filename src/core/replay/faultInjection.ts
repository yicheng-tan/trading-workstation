import type { DepthDiffEvent } from '../types';

/**
 * Returns a copy of a depth diff event with its update-id range shifted
 * forward to simulate missed/dropped messages, for exercising
 * OrderBookManager's gap-detection + resync path under the stress UI's
 * "inject gap" control.
 */
export function injectSequenceGap(evt: DepthDiffEvent, gapSize = 10): DepthDiffEvent {
  if (gapSize <= 0) {
    throw new Error('injectSequenceGap: gapSize must be a positive integer');
  }
  return {
    ...evt,
    U: evt.U + gapSize,
    u: evt.u + gapSize,
  };
}
