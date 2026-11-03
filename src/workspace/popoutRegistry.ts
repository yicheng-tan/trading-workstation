import type { PanelInstanceConfig } from '../panels/PanelProps';

/**
 * Cross-window pop-out bookkeeping over a same-origin BroadcastChannel,
 * independent of the data hub. Pop-outs report their live panels and
 * on-screen bounds; the main window keeps the latest report per window so
 * "save layout" can capture every window, and can ask pop-outs to close or
 * hand their panels back.
 */

const CHANNEL_NAME = 'trading-workstation-popouts';
const HANDOFF_PREFIX = 'trading-workstation:popout:';
const HEARTBEAT_MS = 2000;

export interface PopoutBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PanelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PopoutWindowState {
  windowId: string;
  panels: PanelInstanceConfig[];
  /** Panel rects inside the pop-out, keyed by panel id. */
  panelRects: Record<string, PanelRect>;
  bounds: PopoutBounds;
}

type RegistryMsg =
  | { type: 'state'; state: PopoutWindowState }
  | { type: 'closed'; windowId: string }
  | { type: 'returnToMain'; windowId: string; panels: PanelInstanceConfig[] }
  | { type: 'requestState' }
  | { type: 'close'; windowIds: string[] };

// ---------------------------------------------------------------------------
// Handoff storage. localStorage (shared by every same-origin window) rather
// than sessionStorage: a named window that's re-targeted by a later
// `window.open` keeps its own sessionStorage copy, and a pop-out reload must
// come back with its latest panels, not the ones it was opened with.
// ---------------------------------------------------------------------------

export function writePopoutHandoff(windowId: string, panels: PanelInstanceConfig[]): void {
  try {
    localStorage.setItem(HANDOFF_PREFIX + windowId, JSON.stringify(panels));
  } catch {
    // Storage unavailable - the pop-out boots empty (see readPopoutHandoff).
  }
}

export function readPopoutHandoff(windowId: string): PanelInstanceConfig[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(HANDOFF_PREFIX + windowId) ?? '[]');
    return Array.isArray(parsed) ? (parsed as PanelInstanceConfig[]) : [];
  } catch {
    return [];
  }
}

export function clearPopoutHandoff(windowId: string): void {
  try {
    localStorage.removeItem(HANDOFF_PREFIX + windowId);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Main-window side
// ---------------------------------------------------------------------------

export interface PopoutTracker {
  /** Latest reported state of every currently-open pop-out. */
  list(): PopoutWindowState[];
  /** Ask the given pop-outs to close themselves. */
  close(windowIds: string[]): void;
  dispose(): void;
}

export function createPopoutTracker(handlers: {
  onReturnToMain(panels: PanelInstanceConfig[]): void;
  onChange?(): void;
}): PopoutTracker {
  const channel = new BroadcastChannel(CHANNEL_NAME);
  const windows = new Map<string, PopoutWindowState>();

  channel.onmessage = (ev: MessageEvent<RegistryMsg>) => {
    const msg = ev.data;
    switch (msg.type) {
      case 'state':
        windows.set(msg.state.windowId, msg.state);
        handlers.onChange?.();
        break;
      case 'closed':
        windows.delete(msg.windowId);
        handlers.onChange?.();
        break;
      case 'returnToMain':
        windows.delete(msg.windowId);
        handlers.onReturnToMain(msg.panels);
        handlers.onChange?.();
        break;
      default:
        break;
    }
  };
  // Pop-outs that were already open before this window (re)loaded announce themselves.
  channel.postMessage({ type: 'requestState' } satisfies RegistryMsg);

  return {
    list: () => Array.from(windows.values()),
    close(windowIds) {
      if (windowIds.length === 0) return;
      for (const id of windowIds) windows.delete(id);
      channel.postMessage({ type: 'close', windowIds } satisfies RegistryMsg);
    },
    dispose() {
      channel.close();
      windows.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Pop-out side
// ---------------------------------------------------------------------------

export interface PopoutReporter {
  /** Call whenever the pop-out's panels change; also persists them for reloads. */
  report(panels: PanelInstanceConfig[], panelRects: Record<string, PanelRect>): void;
  /** Hand every panel back to the main window and close this window. */
  returnToMain(panels: PanelInstanceConfig[]): void;
  dispose(): void;
}

export function createPopoutReporter(windowId: string): PopoutReporter {
  const channel = new BroadcastChannel(CHANNEL_NAME);
  let latest: { panels: PanelInstanceConfig[]; panelRects: Record<string, PanelRect> } = { panels: [], panelRects: {} };

  const currentState = (): PopoutWindowState => ({
    windowId,
    panels: latest.panels,
    panelRects: latest.panelRects,
    // `left`/`top` in window.open features are outer coordinates while
    // `width`/`height` are the content size - mirror that so a restore
    // doesn't grow the window by the browser chrome every round trip.
    bounds: { x: window.screenX, y: window.screenY, width: window.innerWidth, height: window.innerHeight },
  });
  const post = (msg: RegistryMsg) => channel.postMessage(msg);
  const announce = () => post({ type: 'state', state: currentState() });

  channel.onmessage = (ev: MessageEvent<RegistryMsg>) => {
    const msg = ev.data;
    if (msg.type === 'requestState') announce();
    if (msg.type === 'close' && msg.windowIds.includes(windowId)) window.close();
  };

  // Bounds have no change event; a slow heartbeat keeps the main window's copy fresh.
  const heartbeat = window.setInterval(announce, HEARTBEAT_MS);
  const onPageHide = () => post({ type: 'closed', windowId });
  window.addEventListener('pagehide', onPageHide);

  return {
    report(panels, panelRects) {
      latest = { panels, panelRects };
      writePopoutHandoff(windowId, panels);
      announce();
    },
    returnToMain(panels) {
      window.removeEventListener('pagehide', onPageHide);
      clearPopoutHandoff(windowId);
      post({ type: 'returnToMain', windowId, panels });
      window.close();
    },
    dispose() {
      window.clearInterval(heartbeat);
      window.removeEventListener('pagehide', onPageHide);
      channel.close();
    },
  };
}
