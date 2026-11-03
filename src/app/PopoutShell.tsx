import { useEffect, useRef, useState } from 'react';
import { LinkGroupProvider } from '../workspace/LinkGroupContext';
import { createPopoutReporter, type PanelRect, type PopoutReporter } from '../workspace/popoutRegistry';
import { PANEL_COMPONENTS, PANEL_TITLES } from '../panels/registry';
import { linkGroupColor } from '../panels/usePanelLink';
import type { PanelInstanceConfig } from '../panels/PanelProps';
import './popoutShell.css';

/**
 * Standalone shell for a pop-out window (handoff contract: top of
 * `src/workspace/windowManager.ts`). Renders the handed-off panels in a
 * simple grid, reports them (plus window bounds) to the main window so saved
 * layouts capture this window, and can hand them back to the main window.
 * The `DataHubProvider` comes from `App.tsx`.
 */
function PanelUnavailable({ kind }: { kind: string }) {
  return (
    <div className="popout-panel-unavailable">
      <strong>Panel type not available</strong>
      <span>“{kind}” has not been registered in PANEL_COMPONENTS.</span>
    </div>
  );
}

export function PopoutShell({ windowId, initialPanels }: { windowId: string; initialPanels: PanelInstanceConfig[] }) {
  const [panels, setPanels] = useState(initialPanels);
  const reporterRef = useRef<PopoutReporter | null>(null);
  const panelElsRef = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    const reporter = createPopoutReporter(windowId);
    reporterRef.current = reporter;
    return () => {
      reporter.dispose();
      reporterRef.current = null;
    };
  }, [windowId]);

  useEffect(() => {
    const rects: Record<string, PanelRect> = {};
    for (const [id, el] of panelElsRef.current) {
      const r = el.getBoundingClientRect();
      rects[id] = { x: r.left, y: r.top, width: r.width, height: r.height };
    }
    reporterRef.current?.report(panels, rects);
  }, [panels]);

  useEffect(() => {
    document.title = panels.map((p) => `${PANEL_TITLES[p.kind]} ${p.kind === 'watchlist' ? '' : (p.symbols[0] ?? '')}`.trim()).join(' · ') || 'Pop-out';
  }, [panels]);

  function updateSymbol(panelId: string, symbol: string) {
    setPanels((prev) => prev.map((p) => (p.id === panelId ? { ...p, symbols: [symbol, ...p.symbols.slice(1)] } : p)));
  }

  function updateSymbols(panelId: string, symbols: string[]) {
    if (symbols.length === 0) return;
    setPanels((prev) => prev.map((p) => (p.id === panelId ? { ...p, symbols } : p)));
  }

  function updateSettings(panelId: string, settings: Record<string, unknown>) {
    // Same promotion as WorkspaceShell.updatePanelSettings.
    const linkGroup = (settings as { linkGroup?: string | null }).linkGroup;
    setPanels((prev) =>
      prev.map((p) =>
        p.id === panelId
          ? { ...p, settings: { ...p.settings, ...settings }, ...(linkGroup !== undefined ? { linkGroup } : {}) }
          : p,
      ),
    );
  }

  return (
    <LinkGroupProvider>
      <div className="popout-root">
        <header className="popout-toolbar">
          <span className="popout-toolbar__source">Market data: Binance Spot public API</span>
          <button
            type="button"
            className="popout-toolbar__btn"
            onClick={() => reporterRef.current?.returnToMain(panels)}
            disabled={panels.length === 0}
            title="Move these panels back into the main window"
          >
            ⇙ Return to main window
          </button>
        </header>
        <div className="popout-shell" role="main">
          {panels.length === 0 ? (
            <div className="popout-shell__empty">No panels were handed off to this window.</div>
          ) : (
            panels.map((config) => {
              const Component = PANEL_COMPONENTS[config.kind];
              const groupColor = linkGroupColor(config.linkGroup);
              return (
                <div
                  className="popout-shell__panel"
                  key={config.id}
                  aria-label={PANEL_TITLES[config.kind]}
                  style={groupColor ? { borderTop: `3px solid ${groupColor}` } : undefined}
                  ref={(el) => {
                    if (el) panelElsRef.current.set(config.id, el);
                    else panelElsRef.current.delete(config.id);
                  }}
                >
                  {Component ? (
                    <Component
                      config={config}
                      onSymbolChange={(symbol) => updateSymbol(config.id, symbol)}
                      onSymbolsChange={(symbols) => updateSymbols(config.id, symbols)}
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
      </div>
    </LinkGroupProvider>
  );
}
