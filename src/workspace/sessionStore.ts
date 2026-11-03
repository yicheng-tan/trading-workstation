import { CURRENT_LAYOUT_SCHEMA_VERSION, parseLayoutDocument, type LayoutDocument } from '../core/layout/schema';
import type { NewLayoutInput } from '../core/layout/LayoutStore';

/**
 * Autosaved "last session" for the main window, so a reload or an
 * accidentally closed tab doesn't lose the workspace. Stored as an ordinary
 * v1 `LayoutDocument` (validated with the same `parseLayoutDocument` as saved
 * layouts) under its own key - it is never listed in, or written to, the
 * `LayoutStore`.
 *
 * Only the main window is kept: pop-outs are independent windows that
 * survive a main-window reload on their own, and reopening them on launch
 * would be popup-blocked anyway.
 */
export const SESSION_STORAGE_KEY = 'trading-workstation:session';
const SESSION_ID = 'last-session';

/** Reduces a full workspace capture to a main-window-only session document. */
export function toSessionDocument(input: NewLayoutInput, now: number): LayoutDocument {
  const main = input.windows.find((w) => w.role === 'main');
  const mainIds = new Set(main?.panelIds ?? []);
  return {
    schemaVersion: CURRENT_LAYOUT_SCHEMA_VERSION,
    id: SESSION_ID,
    name: 'Last session',
    isDefault: false,
    createdAt: now,
    updatedAt: now,
    windows: [main ?? { id: 'main', role: 'main', panelIds: [] }],
    panels: input.panels.filter((p) => mainIds.has(p.id)),
  };
}

export function saveSession(input: NewLayoutInput, storage: Storage = window.localStorage, now = Date.now()): void {
  try {
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(toSessionDocument(input, now)));
  } catch {
    // Storage unavailable or full; autosave is best-effort.
  }
}

/** The last autosaved session, or `null` if there is none or it fails validation. */
export function loadSession(storage: Storage = window.localStorage): LayoutDocument | null {
  try {
    const raw = storage.getItem(SESSION_STORAGE_KEY);
    return raw ? parseLayoutDocument(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
