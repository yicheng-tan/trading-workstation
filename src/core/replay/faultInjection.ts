import type { DepthDiffEvent } from '../types';

/**
 * Returns a copy of a depth diff event with its update-id range shifted
 * forward to simulate missed/dropped messages, for exercising
 * OrderBookManager's gap-detection + resync path under the stress UI's
 * "inject gap" control.
 */
export function injectSequenceGap(_evt: DepthDiffEvent, _gapSize = 10): DepthDiffEvent {
  throw new Error('not implemented');
}
