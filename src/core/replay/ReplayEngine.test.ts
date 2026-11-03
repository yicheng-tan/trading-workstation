import { describe, it, expect, vi } from 'vitest';
import { ReplayEngine, type RecordedEvent } from './ReplayEngine';

function fakeTimers() {
  let nextHandle = 1;
  const pending = new Map<number, { cb: () => void; ms: number }>();
  const setTimeoutFn = vi.fn((cb: () => void, ms: number) => {
    const handle = nextHandle++;
    pending.set(handle, { cb, ms });
    return handle;
  });
  const clearTimeoutFn = vi.fn((handle: unknown) => {
    pending.delete(handle as number);
  });
  const fire = (handle: number) => {
    const entry = pending.get(handle);
    pending.delete(handle);
    entry?.cb();
  };
  return { setTimeoutFn, clearTimeoutFn, pending, fire };
}

const events: RecordedEvent<string>[] = [
  { tMs: 0, payload: 'first' },
  { tMs: 100, payload: 'second' },
  { tMs: 300, payload: 'third' },
];

describe('ReplayEngine', () => {
  it('schedules the first event via setTimeoutFn when started', () => {
    const timers = fakeTimers();
    const onEvent = vi.fn();
    const engine = new ReplayEngine(events, onEvent, { setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn });
    engine.start();
    expect(timers.setTimeoutFn).toHaveBeenCalledTimes(1);
    expect(timers.setTimeoutFn.mock.calls[0][1]).toBe(0);
  });

  it('emits events in order as scheduled timers fire, scheduling the next with the correct relative delay', () => {
    const timers = fakeTimers();
    const onEvent = vi.fn();
    const engine = new ReplayEngine(events, onEvent, { setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn });
    engine.start();
    timers.fire(1); // fires 'first' at t=0, schedules 'second' with delay 100
    expect(onEvent).toHaveBeenNthCalledWith(1, 'first', 0);
    expect(timers.setTimeoutFn.mock.calls[1][1]).toBe(100);

    timers.fire(2); // fires 'second', schedules 'third' with delay 200 (300-100)
    expect(onEvent).toHaveBeenNthCalledWith(2, 'second', 1);
    expect(timers.setTimeoutFn.mock.calls[2][1]).toBe(200);
  });

  it('divides scheduling delay by the configured speed multiplier', () => {
    const timers = fakeTimers();
    const onEvent = vi.fn();
    const engine = new ReplayEngine(events, onEvent, { setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn, speed: 2 });
    engine.start();
    timers.fire(1);
    // delay between first (0) and second (100) at 2x speed = 50ms
    expect(timers.setTimeoutFn.mock.calls[1][1]).toBe(50);
  });

  it('pause() clears the pending timer; resume() reschedules the remaining delay', () => {
    const timers = fakeTimers();
    const onEvent = vi.fn();
    const engine = new ReplayEngine(events, onEvent, { setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn });
    engine.start();
    engine.pause();
    expect(timers.clearTimeoutFn).toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();

    engine.resume();
    expect(timers.setTimeoutFn).toHaveBeenCalledTimes(2); // original + resume reschedule
  });

  it('stop() clears timers and resets playback position to the start', () => {
    const timers = fakeTimers();
    const onEvent = vi.fn();
    const engine = new ReplayEngine(events, onEvent, { setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn });
    engine.start();
    timers.fire(1);
    engine.stop();
    expect(engine.isPlaying).toBe(false);
    expect(engine.nextIndex).toBe(0);
  });

  it('isPlaying reflects the active playback state', () => {
    const timers = fakeTimers();
    const engine = new ReplayEngine(events, vi.fn(), { setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn });
    expect(engine.isPlaying).toBe(false);
    engine.start();
    expect(engine.isPlaying).toBe(true);
  });

  it('automatically stops playing once the last event has been emitted', () => {
    const timers = fakeTimers();
    const onEvent = vi.fn();
    const engine = new ReplayEngine(events, onEvent, { setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn });
    engine.start();
    timers.fire(1);
    timers.fire(2);
    timers.fire(3);
    expect(onEvent).toHaveBeenCalledTimes(3);
    expect(engine.isPlaying).toBe(false);
    expect(engine.nextIndex).toBe(3);
  });

  it('rejects a non-positive speed', () => {
    const timers = fakeTimers();
    const engine = new ReplayEngine(events, vi.fn(), { setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn });
    expect(() => engine.setSpeed(0)).toThrow();
    expect(() => engine.setSpeed(-5)).toThrow();
  });
});
