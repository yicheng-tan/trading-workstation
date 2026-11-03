import { describe, it, expect, beforeEach } from 'vitest';
import { LayoutStore, type LayoutStorageAdapter } from './LayoutStore';
import type { LayoutDocument } from './schema';

function memoryAdapter(): LayoutStorageAdapter & { data: LayoutDocument[] } {
  let data: LayoutDocument[] = [];
  return {
    get data() {
      return data;
    },
    load: () => data,
    persist: (docs) => {
      data = docs;
    },
  };
}

const sampleInput = {
  name: 'Scalping Setup',
  windows: [{ id: 'w1', role: 'main' as const, panelIds: ['p1'] }],
  panels: [
    {
      id: 'p1',
      kind: 'depthLadder' as const,
      symbols: ['BTCUSDT'],
      linkGroup: null,
      settings: {},
      position: { x: 0, y: 0, width: 400, height: 500 },
    },
  ],
};

describe('LayoutStore', () => {
  let adapter: ReturnType<typeof memoryAdapter>;
  let t: number;
  let store: LayoutStore;

  beforeEach(() => {
    adapter = memoryAdapter();
    t = 1000;
    store = new LayoutStore(adapter, { now: () => t, genId: () => `id-${t}` });
  });

  it('save() creates a layout with generated id/timestamps and persists it', () => {
    const doc = store.save(sampleInput);
    expect(doc.id).toBeTruthy();
    expect(doc.createdAt).toBe(1000);
    expect(doc.updatedAt).toBe(1000);
    expect(adapter.data).toHaveLength(1);
  });

  it('list() returns layouts sorted by updatedAt descending', () => {
    store.save({ ...sampleInput, name: 'First' });
    t = 2000;
    store.save({ ...sampleInput, name: 'Second' });
    const names = store.list().map((l) => l.name);
    expect(names).toEqual(['Second', 'First']);
  });

  it('rename() updates the name and bumps updatedAt while keeping the id stable', () => {
    const doc = store.save(sampleInput);
    t = 5000;
    const renamed = store.rename(doc.id, 'New Name');
    expect(renamed.id).toBe(doc.id);
    expect(renamed.name).toBe('New Name');
    expect(renamed.updatedAt).toBe(5000);
  });

  it('delete() removes the layout from list() and storage', () => {
    const doc = store.save(sampleInput);
    store.delete(doc.id);
    expect(store.list()).toHaveLength(0);
    expect(adapter.data).toHaveLength(0);
  });

  it('setDefault() marks exactly one layout as default at a time', () => {
    const a = store.save({ ...sampleInput, name: 'A' });
    t = 2000; // distinct timestamp -> distinct id, since genId here is clock-derived
    const b = store.save({ ...sampleInput, name: 'B' });
    store.setDefault(a.id);
    expect(store.getDefault()?.id).toBe(a.id);
    store.setDefault(b.id);
    expect(store.getDefault()?.id).toBe(b.id);
    expect(store.get(a.id)?.isDefault).toBe(false);
  });

  it('clears default status when the default layout is deleted', () => {
    const a = store.save(sampleInput);
    store.setDefault(a.id);
    store.delete(a.id);
    expect(store.getDefault()).toBeNull();
  });

  it('get() returns null for a nonexistent id', () => {
    expect(store.get('does-not-exist')).toBeNull();
  });

  it('exportJson() produces a versioned envelope containing the layout content', () => {
    const doc = store.save(sampleInput);
    const json = store.exportJson(doc.id);
    const parsed = JSON.parse(json);
    expect(parsed.exportVersion).toBe(1);
    expect(parsed.layout.name).toBe('Scalping Setup');
    expect(parsed.layout.panels).toHaveLength(1);
  });

  it('importJson() adds a new layout with a fresh id, preserving content', () => {
    const doc = store.save(sampleInput);
    const json = store.exportJson(doc.id);
    t = 9000;
    const imported = store.importJson(json);
    expect(imported.id).not.toBe(doc.id);
    expect(imported.name).toBe('Scalping Setup');
    expect(store.list()).toHaveLength(2);
  });

  it('importJson() throws on malformed JSON and does not mutate the store', () => {
    expect(() => store.importJson('{ not valid json')).toThrow();
    expect(store.list()).toHaveLength(0);
  });

  it('importJson() throws on an unsupported future schema version and does not mutate the store', () => {
    const bogus = JSON.stringify({
      exportVersion: 1,
      exportedAt: 1,
      layout: { ...sampleInput, schemaVersion: 99, id: 'x', createdAt: 1, updatedAt: 1, isDefault: false },
    });
    expect(() => store.importJson(bogus)).toThrow();
    expect(store.list()).toHaveLength(0);
  });
});
