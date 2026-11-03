import { describe, it, expect, beforeEach } from 'vitest';
import { SESSION_STORAGE_KEY, loadSession, saveSession, toSessionDocument } from './sessionStore';
import type { NewLayoutInput } from '../core/layout/LayoutStore';

const position = { x: 0, y: 0, width: 400, height: 300 };

const input: NewLayoutInput = {
  name: 'Untitled layout',
  windows: [
    { id: 'main', role: 'main', panelIds: ['p1'], arrangement: { grid: 'opaque' } },
    { id: 'popout-1', role: 'popout', panelIds: ['p2'], bounds: { x: 10, y: 10, width: 800, height: 600 } },
  ],
  panels: [
    { id: 'p1', kind: 'depthLadder', symbols: ['BTCUSDT'], linkGroup: 'A', settings: {}, position },
    { id: 'p2', kind: 'tradeTape', symbols: ['ETHUSDT'], linkGroup: null, settings: {}, position },
  ],
};

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (i) => Array.from(data.keys())[i] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

describe('sessionStore', () => {
  let localStorage: Storage;
  beforeEach(() => {
    localStorage = memoryStorage();
  });

  it('keeps only the main window and its panels', () => {
    const doc = toSessionDocument(input, 5);
    expect(doc.windows).toEqual([input.windows[0]]);
    expect(doc.panels.map((p) => p.id)).toEqual(['p1']);
    expect(doc.updatedAt).toBe(5);
  });

  it('round-trips through storage, including the dockview arrangement', () => {
    saveSession(input, localStorage, 42);
    const loaded = loadSession(localStorage);
    expect(loaded?.panels[0]).toMatchObject({ id: 'p1', symbols: ['BTCUSDT'], linkGroup: 'A' });
    expect(loaded?.windows[0].arrangement).toEqual({ grid: 'opaque' });
  });

  it('returns null when nothing is stored', () => {
    expect(loadSession(localStorage)).toBeNull();
  });

  it('returns null instead of throwing for corrupt or future-version data', () => {
    localStorage.setItem(SESSION_STORAGE_KEY, '{not json');
    expect(loadSession(localStorage)).toBeNull();
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ ...toSessionDocument(input, 1), schemaVersion: 2 }));
    expect(loadSession(localStorage)).toBeNull();
  });

  it('still produces a valid document for an empty workspace', () => {
    saveSession({ name: 'x', windows: [{ id: 'main', role: 'main', panelIds: [] }], panels: [] }, localStorage, 1);
    expect(loadSession(localStorage)?.panels).toEqual([]);
  });
});
