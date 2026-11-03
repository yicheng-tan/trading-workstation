import { Fragment, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  createDockview,
  themeLight,
  type AddPanelOptions,
  type DockviewApi,
  type DockviewComponentOptions,
  type GroupPanelPartInitParameters,
  type IContentRenderer,
  type ITabRenderer,
  type SerializedDockview,
  type TabPartInitParameters,
} from 'dockview';
import 'dockview/dist/styles/dockview.css';

import { PANEL_COMPONENTS, PANEL_TITLES, DEFAULT_WATCHLIST_SYMBOLS } from '../panels/registry';
import type { PanelInstanceConfig } from '../panels/PanelProps';
import type { PanelKind, PanelDocument, LayoutDocument, WindowDocument } from '../core/layout/schema';
import type { NewLayoutInput } from '../core/layout/LayoutStore';
import { LayoutStore } from '../core/layout/LayoutStore';
import { localStorageAdapter } from './localStorageAdapter';
import { restoreLayout } from './restoreLayout';
import { openPopoutWindow, openPopoutWindowsForLayout } from './windowManager';
import { createPopoutTracker, type PanelRect, type PopoutTracker } from './popoutRegistry';
import { LinkGroupProvider } from './LinkGroupContext';
import { LayoutPanel } from './LayoutPanel';
import './workspace.css';

const PANEL_KINDS = Object.keys(PANEL_TITLES) as PanelKind[];
const MAX_PANELS_PER_ROW = 4;
const DEFAULT_PANEL_RECT: PanelRect = { x: 0, y: 0, width: 400, height: 300 };

function genPanelId(): string {
  return `panel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toPanelDocument(config: PanelInstanceConfig, rect: PanelRect | undefined): PanelDocument {
  const r = rect && rect.width > 0 && rect.height > 0 ? rect : DEFAULT_PANEL_RECT;
  return {
    id: config.id,
    kind: config.kind,
    symbols: config.symbols,
    linkGroup: config.linkGroup,
    settings: config.settings,
    position: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
  };
}

function tabTitle(config: PanelInstanceConfig): string {
  const title = PANEL_TITLES[config.kind] ?? config.kind;
  return config.kind === 'watchlist' ? title : `${title} · ${config.symbols[0] ?? ''}`;
}

// ---------------------------------------------------------------------------
// dockview-core <-> React bridge
// ---------------------------------------------------------------------------
// The installed `dockview` package (8.8.3) re-exports `dockview-core` only and
// has no React bindings, so dockview owns the DOM elements and React renders
// into them through portals from this component's own tree. Portals (rather
// than a separate `createRoot` per panel) keep every panel inside the app's
// context providers (data hub, link groups) and re-render them whenever their
// config changes.

type SlotKind = 'content' | 'tab';
type Slots = Record<string, Partial<Record<SlotKind, HTMLElement>>>;

/** "Latest callbacks" bag so dockview's long-lived renderer factories (created once) call current handlers. */
interface WorkspaceHandlers {
  attachSlot(panelId: string, kind: SlotKind, element: HTMLElement): void;
  detachSlot(panelId: string, kind: SlotKind, element: HTMLElement): void;
  notifyPanelClosed(panelId: string): void;
}

function createSlotRenderer(
  handlersRef: React.RefObject<WorkspaceHandlers | null>,
  kind: SlotKind,
): IContentRenderer & ITabRenderer {
  const element = document.createElement('div');
  element.className = kind === 'content' ? 'ws-panel-content' : 'ws-tab';
  let panelId = '';
  return {
    element,
    init(parameters: GroupPanelPartInitParameters | TabPartInitParameters) {
      panelId = parameters.api.id;
      handlersRef.current?.attachSlot(panelId, kind, element);
    },
    dispose() {
      handlersRef.current?.detachSlot(panelId, kind, element);
    },
  };
}

function createEmptyWatermark() {
  const element = document.createElement('div');
  element.className = 'ws-watermark';
  const inner = document.createElement('div');
  inner.className = 'ws-watermark__inner';
  const p1 = document.createElement('p');
  p1.textContent = 'No panels yet.';
  const p2 = document.createElement('p');
  p2.className = 'ws-watermark__hint';
  p2.textContent = 'Use “+ Add panel” above to open your first panel.';
  inner.append(p1, p2);
  element.append(inner);
  return { element, init() {}, dispose() {} };
}

function PanelUnavailable({ kind }: { kind: string }) {
  return (
    <div className="ws-panel-unavailable">
      <strong>Panel type not available</strong>
      <span>“{kind}” has not been registered in PANEL_COMPONENTS yet.</span>
    </div>
  );
}

function PanelTab({ title, onPopOut, onClose }: { title: string; onPopOut: () => void; onClose: () => void }) {
  return (
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
          onPopOut();
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
          onClose();
        }}
      >
        ✕
      </button>
    </span>
  );
}

/** Tracks where the next auto-tiled panel should attach, for a simple grid-ish default layout. */
interface TilingState {
  lastPanelId: string | undefined;
  countInRow: number;
}

function placementFor(tiling: TilingState): AddPanelOptions['position'] | undefined {
  if (!tiling.lastPanelId) return undefined;
  // A new row goes below the whole grid; relative to a panel it would only
  // split that panel's column.
  if (tiling.countInRow >= MAX_PANELS_PER_ROW) return { direction: 'below' };
  return { direction: 'right', referencePanel: tiling.lastPanelId };
}

function advanceTiling(tiling: TilingState, newPanelId: string): void {
  if (!tiling.lastPanelId || tiling.countInRow >= MAX_PANELS_PER_ROW) {
    tiling.countInRow = 1;
  } else {
    tiling.countInRow += 1;
  }
  tiling.lastPanelId = newPanelId;
}

function addDockviewPanel(api: DockviewApi, config: PanelInstanceConfig, tiling: TilingState): void {
  const position = placementFor(tiling);
  api.addPanel({
    id: config.id,
    title: tabTitle(config),
    component: 'panel',
    tabComponent: 'panelTab',
    ...(position ? { floating: false, position } : {}),
  });
  advanceTiling(tiling, config.id);
}

// ---------------------------------------------------------------------------
// WorkspaceShell
// ---------------------------------------------------------------------------

export interface WorkspaceShellProps {
  /** Panels to seed the main window's grid with. Defaults to the default layout, if any. */
  initialPanels?: PanelInstanceConfig[];
}

export function WorkspaceShell({ initialPanels }: WorkspaceShellProps = {}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<DockviewApi | null>(null);
  const tilingRef = useRef<TilingState>({ lastPanelId: undefined, countInRow: 0 });
  const handlersRef = useRef<WorkspaceHandlers | null>(null);
  const panelsStateRef = useRef<PanelInstanceConfig[]>(initialPanels ?? []);
  const trackerRef = useRef<PopoutTracker | null>(null);

  const storeRef = useRef<LayoutStore>(new LayoutStore(localStorageAdapter));

  const [panels, setPanels] = useState<PanelInstanceConfig[]>(initialPanels ?? []);
  const [slots, setSlots] = useState<Slots>({});
  const [newKind, setNewKind] = useState<PanelKind>(PANEL_KINDS[0] ?? 'watchlist');
  const [newSymbol, setNewSymbol] = useState<string>(DEFAULT_WATCHLIST_SYMBOLS[0] ?? 'BTCUSDT');
  const [layoutPanelOpen, setLayoutPanelOpen] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<{ layout: LayoutDocument; blocked: number } | null>(null);

  panelsStateRef.current = panels;

  handlersRef.current = {
    attachSlot(panelId, kind, element) {
      setSlots((prev) => ({ ...prev, [panelId]: { ...prev[panelId], [kind]: element } }));
    },
    detachSlot(panelId, kind, element) {
      setSlots((prev) => {
        if (prev[panelId]?.[kind] !== element) return prev;
        const { [kind]: _removed, ...rest } = prev[panelId];
        const next = { ...prev };
        if (Object.keys(rest).length === 0) delete next[panelId];
        else next[panelId] = rest;
        return next;
      });
    },
    notifyPanelClosed(panelId) {
      setPanels((prev) => prev.filter((p) => p.id !== panelId));
    },
  };

  function popOutPanel(panelId: string) {
    const config = panelsStateRef.current.find((p) => p.id === panelId);
    if (!config) return;
    // Open first: window.open must run synchronously inside the click gesture.
    const win = openPopoutWindow(`popout-${panelId}`, [config]);
    if (!win) return; // blocked - keep the panel docked rather than losing it.
    apiRef.current?.getPanel(panelId)?.api.close();
  }

  function closePanel(panelId: string) {
    apiRef.current?.getPanel(panelId)?.api.close();
  }

  function updatePanelSymbol(panelId: string, symbol: string) {
    setPanels((prev) =>
      prev.map((p) => (p.id === panelId ? { ...p, symbols: [symbol, ...p.symbols.slice(1)] } : p)),
    );
  }

  function updatePanelSettings(panelId: string, settings: Record<string, unknown>) {
    // `usePanelLink` persists link-group changes as `settings.linkGroup`
    // (`PanelProps` has no dedicated callback); promote it onto the panel's
    // top-level `linkGroup` so it round-trips through saved layouts.
    const linkGroup = (settings as { linkGroup?: string | null }).linkGroup;
    setPanels((prev) =>
      prev.map((p) =>
        p.id === panelId
          ? { ...p, settings: { ...p.settings, ...settings }, ...(linkGroup !== undefined ? { linkGroup } : {}) }
          : p,
      ),
    );
  }

  // Create the dockview instance once on mount.
  useEffect(() => {
    if (!containerRef.current) return;

    const options: DockviewComponentOptions = {
      theme: themeLight,
      className: 'ws-dockview',
      noPanelsOverlay: 'watermark',
      createComponent: () => createSlotRenderer(handlersRef, 'content'),
      createTabComponent: () => createSlotRenderer(handlersRef, 'tab'),
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
    // Intentionally run once: dockview's imperative API is the source of
    // truth for arrangement after mount; `panels` is reconciled into it below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track open pop-outs so saves capture them and "return to main" works.
  useEffect(() => {
    const tracker = createPopoutTracker({
      onReturnToMain(returned) {
        setPanels((prev) => [...prev, ...returned.filter((r) => !prev.some((p) => p.id === r.id))]);
      },
    });
    trackerRef.current = tracker;
    return () => {
      tracker.dispose();
      trackerRef.current = null;
    };
  }, []);

  // Reconcile `panels` state -> dockview's live panel set (add/remove diff + tab titles).
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;

    const nextIds = new Set(panels.map((p) => p.id));
    for (const panel of [...api.panels]) {
      if (!nextIds.has(panel.id)) api.removePanel(panel);
    }

    const remaining = api.panels;
    tilingRef.current = {
      lastPanelId: remaining[remaining.length - 1]?.id,
      countInRow: remaining.length > 0 ? ((remaining.length - 1) % MAX_PANELS_PER_ROW) + 1 : 0,
    };

    for (const config of panels) {
      const existing = api.getPanel(config.id);
      if (!existing) {
        addDockviewPanel(api, config, tilingRef.current);
      } else if (existing.title !== tabTitle(config)) {
        existing.api.setTitle(tabTitle(config));
      }
    }
  }, [panels]);

  // Auto-open the default layout on launch. Pop-outs need a user gesture, so
  // most browsers block them here; the toolbar banner finishes with one click
  // (PRD: "a few clicks to start the restore is acceptable").
  useEffect(() => {
    if (initialPanels && initialPanels.length > 0) return;
    const defaultLayout = storeRef.current.getDefault();
    if (!defaultLayout) return;
    applyRestoredLayout(defaultLayout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyRestoredLayout(layout: LayoutDocument) {
    const incomingPopouts = new Set(layout.windows.filter((w) => w.role === 'popout').map((w) => w.id));
    const tracker = trackerRef.current;
    if (tracker) tracker.close(tracker.list().map((w) => w.windowId).filter((id) => !incomingPopouts.has(id)));

    const result = restoreLayout(layout);
    const api = apiRef.current;
    const arrangement = layout.windows.find((w) => w.role === 'main')?.arrangement;
    if (api && arrangement) {
      try {
        api.fromJSON(arrangement as SerializedDockview);
      } catch (err) {
        console.warn('[WorkspaceShell] saved arrangement could not be applied; auto-tiling instead.', err);
        api.clear();
      }
    }
    setPanels(result.mainPanels);
    setPendingRestore(result.blockedWindows > 0 ? { layout, blocked: result.blockedWindows } : null);
    setLayoutPanelOpen(false);
  }

  function handleFinishPopouts() {
    if (!pendingRestore) return;
    const { blocked } = openPopoutWindowsForLayout(pendingRestore.layout);
    setPendingRestore(blocked > 0 ? { layout: pendingRestore.layout, blocked } : null);
  }

  function handleAddPanel() {
    const kind = newKind;
    const trimmedSymbol = newSymbol.trim().toUpperCase();
    const symbols = kind === 'watchlist' ? [...DEFAULT_WATCHLIST_SYMBOLS] : [trimmedSymbol || DEFAULT_WATCHLIST_SYMBOLS[0]];
    setPanels((prev) => [...prev, { id: genPanelId(), kind, symbols, linkGroup: null, settings: {} }]);
  }

  function mainPanelRect(panelId: string): PanelRect | undefined {
    const container = containerRef.current;
    const groupEl = apiRef.current?.getPanel(panelId)?.group?.element;
    if (!container || !groupEl) return undefined;
    const c = container.getBoundingClientRect();
    const r = groupEl.getBoundingClientRect();
    return { x: r.left - c.left, y: r.top - c.top, width: r.width, height: r.height };
  }

  function buildCurrentLayoutInput(): NewLayoutInput {
    const mainDocs = panels.map((config) => toPanelDocument(config, mainPanelRect(config.id)));
    const windows: WindowDocument[] = [
      {
        id: 'main',
        role: 'main',
        panelIds: mainDocs.map((p) => p.id),
        arrangement: apiRef.current?.toJSON(),
      },
    ];
    const popoutDocs: PanelDocument[] = [];
    for (const popout of trackerRef.current?.list() ?? []) {
      if (popout.panels.length === 0) continue;
      const docs = popout.panels.map((config) => toPanelDocument(config, popout.panelRects[config.id]));
      popoutDocs.push(...docs);
      windows.push({
        id: popout.windowId,
        role: 'popout',
        bounds: popout.bounds,
        panelIds: docs.map((d) => d.id),
      });
    }
    return { name: 'Untitled layout', windows, panels: [...mainDocs, ...popoutDocs] };
  }

  const kindOptions = useMemo(() => PANEL_KINDS.map((kind) => ({ kind, title: PANEL_TITLES[kind] })), []);

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

      {panels.map((config) => {
        const slot = slots[config.id];
        if (!slot) return null;
        const Component = PANEL_COMPONENTS[config.kind];
        return (
          <Fragment key={config.id}>
            {slot.content &&
              createPortal(
                Component ? (
                  <Component
                    config={config}
                    onSymbolChange={(symbol) => updatePanelSymbol(config.id, symbol)}
                    onSettingsChange={(settings) => updatePanelSettings(config.id, settings)}
                  />
                ) : (
                  <PanelUnavailable kind={config.kind} />
                ),
                slot.content,
              )}
            {slot.tab &&
              createPortal(
                <PanelTab
                  title={tabTitle(config)}
                  onPopOut={() => popOutPanel(config.id)}
                  onClose={() => closePanel(config.id)}
                />,
                slot.tab,
              )}
          </Fragment>
        );
      })}
    </LinkGroupProvider>
  );
}
