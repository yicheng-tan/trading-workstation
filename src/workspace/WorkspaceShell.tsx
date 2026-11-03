import React, { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createDockview,
  themeLight,
  type AddPanelOptions,
  type DockviewApi,
  type DockviewComponentOptions,
  type GroupPanelPartInitParameters,
  type IContentRenderer,
  type ITabRenderer,
  type TabPartInitParameters,
  type WatermarkRendererInitParameters,
} from 'dockview';
import 'dockview/dist/styles/dockview.css';

import { PANEL_COMPONENTS, PANEL_TITLES, DEFAULT_WATCHLIST_SYMBOLS } from '../panels/registry';
import type { PanelInstanceConfig } from '../panels/PanelProps';
import type { PanelKind, PanelDocument, LayoutDocument } from '../core/layout/schema';
import type { NewLayoutInput } from '../core/layout/LayoutStore';
import { LayoutStore } from '../core/layout/LayoutStore';
import { localStorageAdapter } from './localStorageAdapter';
import { restoreLayout } from './restoreLayout';
import { openPopoutWindow, openPopoutWindowsForLayout } from './windowManager';
import { LinkGroupProvider } from './LinkGroupContext';
import { LayoutPanel } from './LayoutPanel';
import './workspace.css';

const PANEL_KINDS = Object.keys(PANEL_TITLES) as PanelKind[];
const MAX_PANELS_PER_ROW = 4;

function genPanelId(): string {
  return `panel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toPanelDocument(config: PanelInstanceConfig, live?: { width: number; height: number }): PanelDocument {
  return {
    id: config.id,
    kind: config.kind,
    symbols: config.symbols,
    linkGroup: config.linkGroup,
    settings: config.settings,
    position: {
      x: 0,
      y: 0,
      width: live?.width && live.width > 0 ? live.width : 400,
      height: live?.height && live.height > 0 ? live.height : 300,
    },
  };
}

// ---------------------------------------------------------------------------
// Imperative <-> React bridge for dockview-core
// ---------------------------------------------------------------------------
// The installed `dockview` package (8.8.3) is a thin, zero-dependency
// re-export of `dockview-core` only - it does NOT ship the `DockviewReact`
// component some older/other dockview distributions provide (verified by
// reading `node_modules/dockview/dist/cjs/index.d.ts`, which is just
// `export * from 'dockview-core'`, and confirming `dockview-core` itself has
// no React bindings). So this file drives dockview-core's imperative
// `createDockview(element, options)` API directly and bridges each panel's
// content/tab into React itself via `react-dom/client`'s `createRoot`. See
// the final report's "Deviations" section for more detail.

interface PanelRenderParams {
  config: PanelInstanceConfig;
}

/** Mutable "latest callbacks" bag so dockview's long-lived factory closures
 * (created once, in the mount effect) always call into the current render's
 * handlers without needing to recreate the DockviewApi every render. */
interface WorkspaceHandlers {
  popOutPanel(panelId: string): void;
  notifyPanelClosed(panelId: string): void;
  updatePanelSymbol(panelId: string, symbol: string): void;
  updatePanelSettings(panelId: string, settings: Record<string, unknown>): void;
}

function PanelUnavailable({ kind }: { kind: string }) {
  return (
    <div className="ws-panel-unavailable">
      <strong>Panel type not available</strong>
      <span>“{kind}” has not been registered in PANEL_COMPONENTS yet.</span>
    </div>
  );
}

function createPanelContentRenderer(handlersRef: React.RefObject<WorkspaceHandlers>): IContentRenderer {
  const element = document.createElement('div');
  element.className = 'ws-panel-content';
  let root: Root | null = null;
  let panelId = '';

  function render(config: PanelInstanceConfig) {
    if (!root) return;
    const Component = PANEL_COMPONENTS[config.kind];
    if (!Component) {
      root.render(<PanelUnavailable kind={config.kind} />);
      return;
    }
    root.render(
      <Component
        config={config}
        onSymbolChange={(symbol) => handlersRef.current?.updatePanelSymbol(panelId, symbol)}
        onSettingsChange={(settings) => handlersRef.current?.updatePanelSettings(panelId, settings)}
      />,
    );
  }

  return {
    element,
    init(parameters: GroupPanelPartInitParameters) {
      panelId = parameters.api.id;
      root = createRoot(element);
      render((parameters.params as PanelRenderParams).config);
    },
    dispose() {
      root?.unmount();
      root = null;
    },
  };
}

function createPanelTabRenderer(handlersRef: React.RefObject<WorkspaceHandlers>): ITabRenderer {
  const element = document.createElement('div');
  element.className = 'ws-tab';
  let root: Root | null = null;
  let panelId = '';
  let closeFn: (() => void) | null = null;

  function render(title: string) {
    if (!root) return;
    root.render(
      <span className="ws-tab__row">
        <span className="ws-tab__title" title={title}>
          {title}
        </span>
        <button
          type="button"
          className="ws-tab__btn"
          title="Pop out to a new window"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            handlersRef.current?.popOutPanel(panelId);
          }}
        >
          ⇗
        </button>
        <button
          type="button"
          className="ws-tab__btn ws-tab__btn--close"
          title="Close panel"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            closeFn?.();
          }}
        >
          ✕
        </button>
      </span>,
    );
  }

  return {
    element,
    init(parameters: TabPartInitParameters) {
      panelId = parameters.api.id;
      closeFn = () => parameters.api.close();
      root = createRoot(element);
      render(parameters.title ?? PANEL_TITLES[(parameters.params as PanelRenderParams)?.config?.kind] ?? 'Panel');
    },
    dispose() {
      root?.unmount();
      root = null;
    },
  };
}

function createEmptyWatermark() {
  const element = document.createElement('div');
  element.className = 'ws-watermark';
  let root: Root | null = null;
  return {
    element,
    init(_parameters: WatermarkRendererInitParameters) {
      root = createRoot(element);
      root.render(
        <div className="ws-watermark__inner">
          <p>No panels yet.</p>
          <p className="ws-watermark__hint">Use “+ Add panel” above to open your first panel.</p>
        </div>,
      );
    },
    dispose() {
      root?.unmount();
      root = null;
    },
  };
}

/** Tracks where the next auto-tiled panel should attach, for a simple grid-ish default layout. */
interface TilingState {
  rowAnchorId: string | undefined;
  lastPanelId: string | undefined;
  countInRow: number;
}

function placementFor(tiling: TilingState): AddPanelOptions['position'] | undefined {
  if (!tiling.lastPanelId) return undefined;
  if (tiling.countInRow >= MAX_PANELS_PER_ROW && tiling.rowAnchorId) {
    return { direction: 'below', referencePanel: tiling.rowAnchorId };
  }
  return { direction: 'right', referencePanel: tiling.lastPanelId };
}

function advanceTiling(tiling: TilingState, newPanelId: string): void {
  if (!tiling.lastPanelId) {
    tiling.rowAnchorId = newPanelId;
    tiling.countInRow = 1;
  } else if (tiling.countInRow >= MAX_PANELS_PER_ROW) {
    tiling.rowAnchorId = newPanelId;
    tiling.countInRow = 1;
  } else {
    tiling.countInRow += 1;
  }
  tiling.lastPanelId = newPanelId;
}

function addDockviewPanel(api: DockviewApi, config: PanelInstanceConfig, tiling: TilingState): void {
  const position = placementFor(tiling);
  const options: AddPanelOptions<PanelRenderParams> = {
    id: config.id,
    title: PANEL_TITLES[config.kind] ?? config.kind,
    component: 'panel',
    tabComponent: 'panelTab',
    params: { config },
    ...(position ? { floating: false, position } : {}),
  };
  api.addPanel(options);
  advanceTiling(tiling, config.id);
}

// ---------------------------------------------------------------------------
// WorkspaceShell
// ---------------------------------------------------------------------------

export interface WorkspaceShellProps {
  /** Panels to seed the main window's grid with (e.g. when the caller already
   * resolved a layout before mounting). Defaults to empty. */
  initialPanels?: PanelInstanceConfig[];
}

export function WorkspaceShell({ initialPanels }: WorkspaceShellProps = {}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<DockviewApi | null>(null);
  const tilingRef = useRef<TilingState>({ rowAnchorId: undefined, lastPanelId: undefined, countInRow: 0 });
  const handlersRef = useRef<WorkspaceHandlers>(null as unknown as WorkspaceHandlers);
  const panelsStateRef = useRef<PanelInstanceConfig[]>(initialPanels ?? []);

  const storeRef = useRef<LayoutStore>(new LayoutStore(localStorageAdapter));

  const [panels, setPanels] = useState<PanelInstanceConfig[]>(initialPanels ?? []);
  const [newKind, setNewKind] = useState<PanelKind>(PANEL_KINDS[0] ?? 'watchlist');
  const [newSymbol, setNewSymbol] = useState<string>(DEFAULT_WATCHLIST_SYMBOLS[0] ?? 'BTCUSDT');
  const [layoutPanelOpen, setLayoutPanelOpen] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<{ layout: LayoutDocument; blocked: number } | null>(null);

  panelsStateRef.current = panels;

  // "Latest callbacks" assigned every render so the long-lived dockview
  // factory closures (created once below) always see current handlers.
  handlersRef.current = {
    popOutPanel(panelId) {
      const config = panelsStateRef.current.find((p) => p.id === panelId);
      if (!config) return;
      apiRef.current?.getPanel(panelId)?.api.close();
      setPanels((prev) => prev.filter((p) => p.id !== panelId));
      openPopoutWindow(`popout-${panelId}`, [config]);
    },
    notifyPanelClosed(panelId) {
      setPanels((prev) => prev.filter((p) => p.id !== panelId));
    },
    updatePanelSymbol(panelId, symbol) {
      setPanels((prev) =>
        prev.map((p) => (p.id === panelId ? { ...p, symbols: [symbol, ...p.symbols.slice(1)] } : p)),
      );
    },
    updatePanelSettings(panelId, settings) {
      // `usePanelLink` persists link-group changes through this callback as
      // `settings.linkGroup` (see its header comment - `PanelProps` has no
      // dedicated callback for it). Promote that back onto the panel's
      // top-level `linkGroup` field so it round-trips through "save as
      // layout" correctly instead of only affecting the live session.
      const linkGroup = (settings as { linkGroup?: string | null }).linkGroup;
      setPanels((prev) =>
        prev.map((p) => (p.id === panelId ? { ...p, settings, ...(linkGroup !== undefined ? { linkGroup } : {}) } : p)),
      );
    },
  };

  // Create the dockview instance once on mount.
  useEffect(() => {
    if (!containerRef.current) return;

    const options: DockviewComponentOptions = {
      theme: themeLight,
      className: 'ws-dockview',
      noPanelsOverlay: 'watermark',
      createComponent: () => createPanelContentRenderer(handlersRef),
      createTabComponent: () => createPanelTabRenderer(handlersRef),
      createWatermarkComponent: () => createEmptyWatermark(),
    };

    const api = createDockview(containerRef.current, options);
    apiRef.current = api;

    const removeSub = api.onDidRemovePanel((panel) => {
      handlersRef.current?.notifyPanelClosed(panel.id);
    });

    for (const config of panelsStateRef.current) {
      addDockviewPanel(api, config, tilingRef.current);
    }

    return () => {
      removeSub.dispose();
      api.dispose();
      apiRef.current = null;
    };
    // Intentionally run once: dockview's own imperative API is the source of
    // truth after mount; `panels` state is reconciled into it below instead
    // of recreating the whole component every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconcile `panels` state -> dockview's live panel set (add/remove diff).
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;

    const nextIds = new Set(panels.map((p) => p.id));
    for (const panel of api.panels) {
      if (!nextIds.has(panel.id)) {
        api.removePanel(panel);
      }
    }

    const remaining = api.panels;
    tilingRef.current = {
      rowAnchorId: remaining[0]?.id,
      lastPanelId: remaining[remaining.length - 1]?.id,
      countInRow: remaining.length > 0 ? ((remaining.length - 1) % MAX_PANELS_PER_ROW) + 1 : 0,
    };

    const currentIds = new Set(api.panels.map((p) => p.id));
    for (const config of panels) {
      if (!currentIds.has(config.id)) {
        addDockviewPanel(api, config, tilingRef.current);
      }
    }
  }, [panels]);

  // Auto-open the default layout's main panels on launch. Pop-out windows in
  // that layout are opened in the same pass, but a page-load has no user
  // gesture, so most browsers will block them; we surface the block count
  // and let the user finish with one explicit click (PRD: "a few clicks to
  // start the restore is acceptable").
  useEffect(() => {
    if (initialPanels && initialPanels.length > 0) return; // caller already seeded panels explicitly.
    const defaultLayout = storeRef.current.getDefault();
    if (!defaultLayout) return;
    applyRestoredLayout(defaultLayout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyRestoredLayout(layout: LayoutDocument) {
    const result = restoreLayout(layout);
    setPanels(result.mainPanels);
    setPendingRestore(result.blockedWindows > 0 ? { layout, blocked: result.blockedWindows } : null);
    setLayoutPanelOpen(false);
  }

  function handleFinishPopouts() {
    if (!pendingRestore) return;
    const { opened, blocked } = openPopoutWindowsForLayout(pendingRestore.layout);
    void opened;
    setPendingRestore(blocked > 0 ? { layout: pendingRestore.layout, blocked } : null);
  }

  function handleAddPanel() {
    const kind = newKind;
    const trimmedSymbol = newSymbol.trim().toUpperCase();
    const symbols = kind === 'watchlist' ? [...DEFAULT_WATCHLIST_SYMBOLS] : [trimmedSymbol || DEFAULT_WATCHLIST_SYMBOLS[0]];
    const config: PanelInstanceConfig = {
      id: genPanelId(),
      kind,
      symbols,
      linkGroup: null,
      settings: {},
    };
    setPanels((prev) => [...prev, config]);
  }

  function buildCurrentLayoutInput(): NewLayoutInput {
    const api = apiRef.current;
    const panelDocs = panels.map((config) => {
      const live = api?.getPanel(config.id);
      return toPanelDocument(
        config,
        live ? { width: live.api.width, height: live.api.height } : undefined,
      );
    });
    return {
      name: 'Untitled layout',
      windows: [{ id: 'main', role: 'main', panelIds: panelDocs.map((p) => p.id) }],
      panels: panelDocs,
    };
  }

  const kindOptions = useMemo(
    () => PANEL_KINDS.map((kind) => ({ kind, title: PANEL_TITLES[kind] })),
    [],
  );

  return (
    <LinkGroupProvider>
      <div className="ws-root">
        <header className="ws-toolbar">
          <div className="ws-toolbar__group">
            <select
              className="ws-toolbar__select"
              value={newKind}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => setNewKind(e.target.value as PanelKind)}
              aria-label="Panel type"
            >
              {kindOptions.map(({ kind, title }) => (
                <option key={kind} value={kind}>
                  {title}
                  {!PANEL_COMPONENTS[kind] ? ' (unavailable)' : ''}
                </option>
              ))}
            </select>
            <input
              className="ws-toolbar__input"
              value={newSymbol}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setNewSymbol(e.target.value)}
              placeholder="Symbol, e.g. BTCUSDT"
              aria-label="Initial symbol"
              disabled={newKind === 'watchlist'}
            />
            <button type="button" className="ws-toolbar__btn ws-toolbar__btn--primary" onClick={handleAddPanel}>
              + Add panel
            </button>
          </div>

          <div className="ws-toolbar__spacer" />

          {pendingRestore && (
            <button type="button" className="ws-toolbar__banner" onClick={handleFinishPopouts}>
              {pendingRestore.blocked} pop-out window{pendingRestore.blocked === 1 ? '' : 's'} blocked by the
              browser — click to open
            </button>
          )}

          <button type="button" className="ws-toolbar__btn" onClick={() => setLayoutPanelOpen((v) => !v)}>
            Layouts
          </button>
        </header>

        <div className="ws-body">
          <div ref={containerRef} className="ws-dockview-container" />
          {layoutPanelOpen && (
            <LayoutPanel
              store={storeRef.current}
              getCurrentLayoutInput={buildCurrentLayoutInput}
              onRestoreLayout={applyRestoredLayout}
              onClose={() => setLayoutPanelOpen(false)}
            />
          )}
        </div>
      </div>
    </LinkGroupProvider>
  );
}
