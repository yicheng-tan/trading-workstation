import { parseLayoutDocument, type LayoutDocument } from '../core/layout/schema';
import type { LayoutStorageAdapter } from '../core/layout/LayoutStore';

/** The one localStorage key every window's LayoutStore reads/writes. */
export const LAYOUT_STORAGE_KEY = 'trading-workstation:layouts';

function probeLocalStorage(storage: Storage | undefined): boolean {
  if (!storage) return false;
  try {
    const probeKey = '__trading-workstation:probe__';
    storage.setItem(probeKey, '1');
    storage.removeItem(probeKey);
    return true;
  } catch {
    // Unavailable (SSR, sandboxed iframe, disabled storage, quota exceeded, etc).
    return false;
  }
}

/**
 * `LayoutStorageAdapter` backed by `window.localStorage`, storing every
 * layout as a single JSON array under `storageKey`. If `localStorage` is
 * unavailable or throws (SSR, privacy-mode sandboxing, disabled storage),
 * silently falls back to an in-memory array for the lifetime of this
 * adapter instance so the rest of the app never has to special-case it -
 * layouts just won't survive a reload in that situation.
 *
 * Any entry in the stored array that fails `parseLayoutDocument` (corrupt
 * JSON shape, or written by a future/incompatible schema version) is
 * dropped rather than thrown, so one bad record can't break every saved
 * layout from loading.
 */
export function createLocalStorageAdapter(storageKey: string = LAYOUT_STORAGE_KEY): LayoutStorageAdapter {
  const storage = typeof window !== 'undefined' ? window.localStorage : undefined;
  const useLocalStorage = probeLocalStorage(storage);
  let memoryFallback: LayoutDocument[] = [];

  return {
    load(): LayoutDocument[] {
      if (!useLocalStorage || !storage) return memoryFallback;
      try {
        const raw = storage.getItem(storageKey);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const docs: LayoutDocument[] = [];
        for (const entry of parsed) {
          try {
            docs.push(parseLayoutDocument(entry));
          } catch {
            // Skip corrupt or unsupported-version entries; don't crash the app on load.
          }
        }
        return docs;
      } catch {
        return memoryFallback;
      }
    },
    persist(docs: LayoutDocument[]): void {
      if (!useLocalStorage || !storage) {
        memoryFallback = docs;
        return;
      }
      try {
        storage.setItem(storageKey, JSON.stringify(docs));
      } catch {
        // Quota exceeded or storage revoked mid-session; keep an in-memory
        // copy so the current session still behaves consistently even
        // though it won't survive a reload.
        memoryFallback = docs;
      }
    },
  };
}

/** Shared default adapter instance used by the app's LayoutStore. */
export const localStorageAdapter: LayoutStorageAdapter = createLocalStorageAdapter();
