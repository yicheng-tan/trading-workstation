import type { PanelInstanceConfig } from '../panels/PanelProps';
import type { LayoutDocument, PanelDocument } from '../core/layout/schema';

/**
 * ===========================================================================
 * POP-OUT HANDOFF CONTRACT  (read this before wiring `src/main.tsx`)
 * ===========================================================================
 *
 * Architecture: every window - the main window AND every pop-out - is the
 * SAME app bundle loaded at the SAME origin. A pop-out is just a second
 * `window.open()`'d copy of the app that independently opens its own
 * SharedWorker connection to the shared data hub. It needs no bridge back to
 * its opener for data; it only needs to know, on boot, "render just these
 * panels, standalone" instead of the full dockview workspace.
 *
 * This module writes the handoff; `src/main.tsx` (owned by the integrator,
 * NOT this module) must read it. The contract:
 *
 * 1. URL:  `openPopoutWindow` opens `<origin+pathname>?popout=<windowId>`.
 *    On boot, check `new URLSearchParams(location.search).get('popout')`.
 *    If present, this window is a pop-out for that `windowId`.
 *
 * 2. Payload: the panel list for that window is written to
 *    `sessionStorage['popout:' + windowId]` as a JSON-serialized
 *    `PanelInstanceConfig[]` (see `src/panels/PanelProps.ts`), written
 *    synchronously by `openPopoutWindow` BEFORE `window.open` is called, so
 *    it's present as soon as the new window's document starts loading.
 *    Read it with:
 *      `JSON.parse(sessionStorage.getItem('popout:' + windowId) ?? '[]')`
 *    `sessionStorage` is per-tab/per-window in most browsers, but a window
 *    opened via `window.open(url, windowId, features)` with a *named*
 *    target that a browser reuses, or a window that inherits an existing
 *    session, can still see it; reading defensively (defaulting to `[]`
 *    and rendering an empty/"no panels" state) is recommended.
 *
 * 3. Render: when `popout` is present, `main.tsx` should render a MINIMAL
 *    shell - NOT `<WorkspaceShell />` - that:
 *      a. still wraps the panels in `<DataHubProvider client={...}>` (own
 *         SharedWorker connection, same as the main window) and
 *         `<LinkGroupProvider>` (so cross-window symbol linking keeps
 *         working via the shared BroadcastChannel), and
 *      b. maps each `PanelInstanceConfig` through
 *         `PANEL_COMPONENTS[config.kind]` (from `src/panels/registry.tsx`)
 *         exactly like `WorkspaceShell` does, rendering a simple stacked /
 *         single-panel layout (no dockview chrome needed for a pop-out that
 *         holds one or a few panels - though reusing `WorkspaceShell`'s
 *         dockview grid for a multi-panel pop-out is also fine if preferred).
 *      c. shows the "Panel type not available" placeholder for any `kind`
 *         missing from `PANEL_COMPONENTS` (same rule as the main workspace).
 *
 * 4. Title/branding: no special handling required; the pop-out is a normal
 *    page load of the same bundle, so `index.html`'s title/favicon apply
 *    unchanged.
 *
 * Example sketch for `main.tsx` (illustrative only - not written by this
 * module):
 *
 *   const popoutId = new URLSearchParams(location.search).get('popout');
 *   if (popoutId) {
 *     const panels: PanelInstanceConfig[] = JSON.parse(
 *       sessionStorage.getItem('popout:' + popoutId) ?? '[]',
 *     );
 *     render(<PopoutShell panels={panels} />); // integrator-authored, mirrors WorkspaceShell's panel-render loop
 *   } else {
 *     render(<WorkspaceShell />);
 *   }
 * ===========================================================================
 */

const POPOUT_SESSION_PREFIX = 'popout:';

export interface PopoutPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Id of a specific screen (as reported by the Window Management API's
   * `getScreenDetails()`) to prefer when placing this window. Optional:
   * the literal `WindowDocument.screenId` field in a saved layout. Not part
   * of the minimal `{x,y,width,height}` shape the task description sketches
   * for `bounds`, but required to actually honour a saved screen assignment
   * - see "Deviations" in the final report.
   */
  screenId?: string;
}

const DEFAULT_WIDTH = 900;
const DEFAULT_HEIGHT = 700;
const CASCADE_STEP = 40;
let cascadeCounter = 0;

/**
 * Best-effort, best-fit multi-monitor placement via the (Chromium-only,
 * permission-gated) Window Management API. `getScreenDetails()` is async
 * and may show a one-time permission prompt, which is fundamentally
 * incompatible with calling `window.open` synchronously inside the same
 * user gesture (awaiting it here would risk the browser's popup blocker
 * treating the eventual `window.open` as not gesture-initiated, defeating
 * `openPopoutWindowsForLayout`'s "single synchronous pass" requirement).
 *
 * So: we cache whatever `ScreenDetails` we've resolved from a *previous*
 * call (near-instant to read on subsequent calls once permission has been
 * granted once), and kick off resolution for next time in the background.
 * First call in a session falls back to default/cascaded placement; every
 * call after an initial grant gets accurate per-screen placement.
 */
interface CachedScreenInfo {
  id: string;
  availLeft: number;
  availTop: number;
  availWidth: number;
  availHeight: number;
}
let cachedScreens: CachedScreenInfo[] | null = null;
let screenDetailsRequestInFlight = false;

function requestScreenDetailsInBackground(): void {
  if (screenDetailsRequestInFlight) return;
  if (typeof window === 'undefined' || !('getScreenDetails' in window)) return;
  screenDetailsRequestInFlight = true;
  try {
    const getScreenDetails = (window as unknown as { getScreenDetails: () => Promise<unknown> }).getScreenDetails;
    Promise.resolve(getScreenDetails.call(window))
      .then((details) => {
        const screens = (details as { screens?: unknown[] }).screens;
        if (!Array.isArray(screens)) return;
        cachedScreens = screens.map((s, i) => {
          const screen = s as Record<string, unknown>;
          return {
            id: String(screen.id ?? i),
            availLeft: Number(screen.availLeft ?? 0),
            availTop: Number(screen.availTop ?? 0),
            availWidth: Number(screen.availWidth ?? screen.width ?? DEFAULT_WIDTH),
            availHeight: Number(screen.availHeight ?? screen.height ?? DEFAULT_HEIGHT),
          };
        });
      })
      .catch(() => {
        // Unsupported at runtime, permission denied, or the user dismissed
        // the prompt - silently keep default/cascaded placement.
      })
      .finally(() => {
        screenDetailsRequestInFlight = false;
      });
  } catch {
    // A non-conformant implementation that throws synchronously - ignore.
    screenDetailsRequestInFlight = false;
  }
}

function resolvePlacement(bounds?: PopoutPlacement): { left: number; top: number; width: number; height: number } {
  requestScreenDetailsInBackground();

  const width = bounds?.width ?? DEFAULT_WIDTH;
  const height = bounds?.height ?? DEFAULT_HEIGHT;

  if (bounds?.screenId && cachedScreens) {
    const screen = cachedScreens.find((s) => s.id === bounds.screenId);
    if (screen) {
      return {
        left: Math.round(screen.availLeft + (bounds.x ?? 0)),
        top: Math.round(screen.availTop + (bounds.y ?? 0)),
        width: Math.round(width),
        height: Math.round(height),
      };
    }
  }

  if (bounds) {
    return { left: Math.round(bounds.x), top: Math.round(bounds.y), width: Math.round(width), height: Math.round(height) };
  }

  // No stored bounds at all: cascade new windows so they don't stack exactly
  // on top of one another.
  const offset = 80 + (cascadeCounter++ % 10) * CASCADE_STEP;
  return { left: offset, top: offset, width, height };
}

function featuresString(placement: { left: number; top: number; width: number; height: number }): string {
  return [
    'popup=yes',
    `width=${placement.width}`,
    `height=${placement.height}`,
    `left=${placement.left}`,
    `top=${placement.top}`,
  ].join(',');
}

/**
 * Opens a standalone pop-out window for `panels`, handing them off via
 * `sessionStorage` per the contract documented above. Returns the `Window`
 * handle, or `null` if the browser's popup blocker refused the call (the
 * caller decides how to surface that - see `openPopoutWindowsForLayout`).
 */
export function openPopoutWindow(
  windowId: string,
  panels: PanelInstanceConfig[],
  bounds?: PopoutPlacement,
): Window | null {
  try {
    sessionStorage.setItem(POPOUT_SESSION_PREFIX + windowId, JSON.stringify(panels));
  } catch {
    // sessionStorage unavailable (sandboxed/private mode) - the pop-out will
    // boot with no panels per the contract's defensive read; best-effort only.
  }

  const placement = resolvePlacement(bounds);
  const url = `${window.location.pathname}?popout=${encodeURIComponent(windowId)}`;

  let win: Window | null = null;
  try {
    win = window.open(url, windowId, featuresString(placement));
  } catch {
    win = null;
  }

  // If a screen assignment was requested, try one more best-effort live
  // correction once `getScreenDetails()` resolves. This can land slightly
  // after the window already opened at the fallback position; that's an
  // acceptable trade-off for keeping the `window.open` call itself
  // synchronous (see `resolvePlacement` above).
  if (win && bounds?.screenId) {
    attemptDeferredReposition(win, bounds.screenId, bounds.x ?? 0, bounds.y ?? 0, bounds.width, bounds.height);
  }

  return win;
}

/** Best-effort post-open screen correction; every failure mode is swallowed. */
function attemptDeferredReposition(
  win: Window,
  screenId: string,
  offsetX: number,
  offsetY: number,
  width?: number,
  height?: number,
): void {
  if (typeof window === 'undefined' || !('getScreenDetails' in window)) return;
  try {
    const getScreenDetails = (window as unknown as { getScreenDetails: () => Promise<unknown> }).getScreenDetails;
    Promise.resolve(getScreenDetails.call(window))
      .then((details) => {
        const screens = (details as { screens?: Array<Record<string, unknown>> }).screens;
        const match = screens?.find((s) => String(s.id) === screenId);
        if (!match || win.closed) return;
        const left = Math.round(Number(match.availLeft ?? 0) + offsetX);
        const top = Math.round(Number(match.availTop ?? 0) + offsetY);
        win.moveTo(left, top);
        if (width && height) win.resizeTo(Math.round(width), Math.round(height));
      })
      .catch(() => {
        // Silently fall back to the already-applied default placement.
      });
  } catch {
    // Ignore - window stays at its fallback position.
  }
}

function toPanelInstanceConfig(panel: PanelDocument): PanelInstanceConfig {
  return {
    id: panel.id,
    kind: panel.kind,
    symbols: panel.symbols,
    linkGroup: panel.linkGroup,
    settings: panel.settings,
  };
}

/**
 * Opens every `popout`-role window in `layout` in a single synchronous pass
 * (no `await` between `window.open` calls), so the whole batch stays inside
 * one user-gesture click per the browser's pop-up policy - most browsers
 * allow *some* number of synchronous `window.open` calls per gesture, but
 * not an unbounded number, and never across an `await`/microtask boundary
 * reliably. Returns how many succeeded vs were blocked so the caller (see
 * `restoreLayout`) can tell the user "N of M windows opened, click again to
 * open the rest" - acceptable per the PRD ("a few clicks to start the
 * restore is acceptable").
 */
export function openPopoutWindowsForLayout(layout: LayoutDocument): { opened: number; blocked: number } {
  const panelsById = new Map(layout.panels.map((p) => [p.id, p]));
  let opened = 0;
  let blocked = 0;

  for (const win of layout.windows) {
    if (win.role !== 'popout') continue;

    const panels = win.panelIds
      .map((id) => panelsById.get(id))
      .filter((p): p is PanelDocument => p !== undefined)
      .map(toPanelInstanceConfig);

    if (panels.length === 0) continue;

    const bounds: PopoutPlacement | undefined = win.bounds
      ? { ...win.bounds, screenId: win.screenId }
      : win.screenId
        ? { x: 0, y: 0, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, screenId: win.screenId }
        : undefined;

    const handle = openPopoutWindow(win.id, panels, bounds);
    if (handle) {
      opened += 1;
    } else {
      blocked += 1;
    }
  }

  return { opened, blocked };
}
