import { useState } from 'react';
import { DataHubProvider } from './app/DataHubContext';
import { createDataHubClient } from './core/hub/createDataHubClient';
import { PopoutShell } from './app/PopoutShell';
import { WorkspaceShell } from './workspace/WorkspaceShell';
import { readPopoutHandoff } from './workspace/popoutRegistry';
import PerfOverlay from './perf/PerfOverlay';
import ReplayFaultControls from './perf/replayFaultControls';
import './app/appShell.css';

/** `?popout=<id>` marks a pop-out window; see the handoff contract in `src/workspace/windowManager.ts`. */
const popoutId = new URLSearchParams(window.location.search).get('popout');

// One DataHubClient per page (main window or pop-out), each opening its own
// port to the same SharedWorker hub. Owned by the page rather than a React
// effect: StrictMode's mount/unmount/mount cycle would otherwise dispose it
// right after mount, and effect cleanups never run when a window closes -
// `pagehide` does, so the hub gets its `bye` and releases this window's
// subscriptions.
const client = createDataHubClient(popoutId ? 'popout' : 'main');
window.addEventListener('pagehide', () => client.dispose(), { once: true });
// A page restored from the back/forward cache comes back with a disposed client.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) window.location.reload();
});
import.meta.hot?.dispose(() => client.dispose());

export default function App() {
  const [initialPopoutPanels] = useState(() => (popoutId ? readPopoutHandoff(popoutId) : []));

  return (
    <DataHubProvider client={client}>
      {popoutId ? <PopoutShell windowId={popoutId} initialPanels={initialPopoutPanels} /> : <WorkspaceShell />}
      <PerfOverlay />
      {!popoutId && <StressControlsToggle />}
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
