import { useState } from 'react';
import { LinkGroupProvider } from '../workspace/LinkGroupContext';
import { PANEL_COMPONENTS, PANEL_TITLES } from '../panels/registry';
import type { PanelInstanceConfig } from '../panels/PanelProps';
import './popoutShell.css';

/**
 * Minimal standalone shell for a pop-out window, per the handoff contract
 * documented at the top of `src/workspace/windowManager.ts`. Renders just
 * the panels handed off via `sessionStorage`, wrapped in the same
 * `LinkGroupProvider` the main window uses (cross-window symbol linking
 * rides the shared BroadcastChannel underneath, not this component) - this
 * window's `DataHubProvider` is supplied by `App.tsx`, one level up, since
 * it's identical between the main window and every pop-out.
 */
function PanelUnavailable({ kind }: { kind: string }) {
  return (
    <div className="popout-panel-unavailable">
      <strong>Panel type not available</strong>
      <span>“{kind}” has not been registered in PANEL_COMPONENTS.</span>
    </div>
  );
}

export function PopoutShell({ initialPanels }: { initialPanels: PanelInstanceConfig[] }) {
  const [panels, setPanels] = useState(initialPanels);

  function updateSymbol(panelId: string, symbol: string) {
    setPanels((prev) => prev.map((p) => (p.id === panelId ? { ...p, symbols: [symbol, ...p.symbols.slice(1)] } : p)));
  }

  function updateSettings(panelId: string, settings: Record<string, unknown>) {
    // See the matching comment in WorkspaceShell.updatePanelSettings: promote
    // a link-group change back onto the top-level config for consistency,
    // even though pop-out windows aren't currently captured by "save layout".
    const linkGroup = (settings as { linkGroup?: string | null }).linkGroup;
    setPanels((prev) =>
      prev.map((p) => (p.id === panelId ? { ...p, settings, ...(linkGroup !== undefined ? { linkGroup } : {}) } : p)),
    );
  }

  return (
    <LinkGroupProvider>
      <div className="popout-shell" role="main">
        {panels.length === 0 ? (
          <div className="popout-shell__empty">No panels were handed off to this window.</div>
        ) : (
          panels.map((config) => {
            const Component = PANEL_COMPONENTS[config.kind];
            return (
              <div className="popout-shell__panel" key={config.id} aria-label={PANEL_TITLES[config.kind]}>
                {Component ? (
                  <Component
                    config={config}
                    onSymbolChange={(symbol) => updateSymbol(config.id, symbol)}
                    onSettingsChange={(settings) => updateSettings(config.id, settings)}
                  />
                ) : (
                  <PanelUnavailable kind={config.kind} />
                )}
              </div>
            );
          })
        )}
      </div>
    </LinkGroupProvider>
  );
}
