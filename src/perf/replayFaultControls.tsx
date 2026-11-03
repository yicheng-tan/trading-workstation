import { useState } from 'react';
import { useDataHub } from '../app/DataHubContext';
import type { Symbol as SymbolId } from '../core/types';
import './replayFaultControls.css';

const REPLAY_SPEEDS = [1, 5, 10, 25, 50];

export interface ReplayFaultControlsProps {
  /** Symbol targeted by "Inject Sequence Gap". Defaults to BTCUSDT. */
  faultSymbol?: SymbolId;
}

/**
 * Small stress-testing control panel for the PRD's resilience requirements:
 * drive the hub into replay mode at various speeds (stress scenario is 10x;
 * other multiples are offered for headroom testing) and inject faults
 * (dropped connection / sequence gap) to verify panels surface a visible
 * stale/reconnecting state and recover.
 *
 * These call straight through to `DataHubClient` per the interface
 * contract. The concrete hub implementation may still no-op some of these
 * while it's being built out in parallel - this component only owns its
 * own local "what did I last ask for" status line, and never assumes the
 * hub visibly reacts.
 */
export default function ReplayFaultControls({ faultSymbol = 'BTCUSDT' }: ReplayFaultControlsProps) {
  const hub = useDataHub();
  const [replaySpeed, setReplaySpeed] = useState<number | null>(null);
  const [lastAction, setLastAction] = useState<string | null>(null);

  function safely(label: string, fn: () => void) {
    try {
      fn();
      setLastAction(label);
    } catch (err) {
      setLastAction(`${label} - failed: ${(err as Error).message}`);
    }
  }

  function handleStart(speed: number) {
    safely(`Start replay ${speed}x`, () => hub.setReplayMode(true, speed));
    setReplaySpeed(speed);
  }

  function handleStop() {
    safely('Stop replay', () => hub.setReplayMode(false));
    setReplaySpeed(null);
  }

  function handleDropConnection() {
    safely('Drop connection', () => hub.injectFault('dropConnection'));
  }

  function handleInjectGap() {
    safely(`Inject sequence gap (${faultSymbol})`, () => hub.injectFault('gap', faultSymbol));
  }

  const statusLine = replaySpeed !== null ? `Replay: ${replaySpeed}x running` : 'Replay: stopped';

  return (
    <div className="replay-fault-controls">
      <div className="replay-fault-controls__group">
        <span className="replay-fault-controls__label">Replay</span>
        {REPLAY_SPEEDS.map((speed) => (
          <button
            key={speed}
            type="button"
            className="replay-fault-controls__btn"
            aria-pressed={replaySpeed === speed}
            onClick={() => handleStart(speed)}
          >
            {speed}x
          </button>
        ))}
        <button
          type="button"
          className="replay-fault-controls__btn replay-fault-controls__btn--stop"
          onClick={handleStop}
        >
          Stop Replay
        </button>
      </div>

      <div className="replay-fault-controls__group">
        <span className="replay-fault-controls__label">Faults</span>
        <button
          type="button"
          className="replay-fault-controls__btn replay-fault-controls__btn--warn"
          onClick={handleDropConnection}
        >
          Drop Connection
        </button>
        <button
          type="button"
          className="replay-fault-controls__btn replay-fault-controls__btn--warn"
          onClick={handleInjectGap}
        >
          Inject Sequence Gap
        </button>
      </div>

      <div className="replay-fault-controls__status">{statusLine}</div>
      {lastAction && <div className="replay-fault-controls__last-action">Last: {lastAction}</div>}
    </div>
  );
}
