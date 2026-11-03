import { useEffect, useMemo, useState } from 'react';
import { DataHubProvider } from './app/DataHubContext';
import { createDataHubClient } from './core/hub/createDataHubClient';
import type { DataHubClient } from './core/hub/DataHubClient';
import { PopoutShell } from './app/PopoutShell';
import { WorkspaceShell } from './workspace/WorkspaceShell';
import PerfOverlay from './perf/PerfOverlay';
import ReplayFaultControls from './perf/replayFaultControls';
import type { PanelInstanceConfig } from './panels/PanelProps';
import './app/appShell.css';

const POPOUT_SESSION_PREFIX = 'popout:';

/** Reads the `?popout=<id>` handoff per the contract documented in `src/workspace/windowManager.ts`. */
function readPopoutHandoff(): { popoutId: string; panels: PanelInstanceConfig[] } | null {
  const popoutId = new URLSearchParams(window.location.search).get('popout');
  if (!popoutId) return null;
  let panels: PanelInstanceConfig[] = [];
  try {
    panels = JSON.parse(sessionStorage.getItem(POPOUT_SESSION_PREFIX + popoutId) ?? '[]');
  } catch {
    panels = [];
  }
  return { popoutId, panels };
}

export default function App() {
  const popout = useMemo(readPopoutHandoff, []);
  const windowRole = popout ? 'popout' : 'main';

  // One DataHubClient per window (main or pop-out) - each opens its own
  // SharedWorker port to the SAME shared hub, per the architecture decided
  // up front. Created once per mount, disposed on unmount (page unload).
  const [client] = useState<DataHubClient>(() => createDataHubClient(windowRole));
  useEffect(() => () => client.dispose(), [client]);

  return (
    <DataHubProvider client={client}>
      {popout ? <PopoutShell initialPanels={popout.panels} /> : <WorkspaceShell />}
      <PerfOverlay />
      {!popout && <StressControlsToggle />}
    </DataHubProvider>
  );
}

/** The replay/fault stress-testing controls drive the shared hub for every
 * window at once, so they only need to live in the main window; tucked
 * behind a toggle so they don't clutter the default view. */
function StressControlsToggle() {
  const [open, setOpen] = useState(false);
  return (
    <div className="stress-controls-toggle">
      <button type="button" className="stress-controls-toggle__btn" onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide stress controls' : 'Stress testing'}
      </button>
      {open && <ReplayFaultControls />}
    </div>
  );
}
