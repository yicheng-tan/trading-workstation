import {
  CURRENT_LAYOUT_SCHEMA_VERSION,
  parseLayoutExportEnvelope,
  type LayoutDocument,
  type LayoutExportEnvelope,
  type WindowDocument,
  type PanelDocument,
} from './schema';

export interface LayoutStorageAdapter {
  load(): LayoutDocument[];
  persist(docs: LayoutDocument[]): void;
}

export interface NewLayoutInput {
  name: string;
  windows: WindowDocument[];
  panels: PanelDocument[];
}

export interface LayoutStoreOptions {
  now?: () => number;
  genId?: () => string;
}

function defaultGenId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  // Fallback id generator for environments without crypto.randomUUID.
  return `layout-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * In-memory + pluggable-persistence CRUD for named layouts: save, rename,
 * delete, list, set-default, and versioned export/import, per the PRD's
 * layout requirements.
 */
export class LayoutStore {
  private readonly adapter: LayoutStorageAdapter;
  private readonly now: () => number;
  private readonly genId: () => string;
  private docs: LayoutDocument[];

  constructor(adapter: LayoutStorageAdapter, opts?: LayoutStoreOptions) {
    this.adapter = adapter;
    this.now = opts?.now ?? (() => Date.now());
    this.genId = opts?.genId ?? defaultGenId;
    this.docs = [...this.adapter.load()];
  }

  private persist(): void {
    this.adapter.persist(this.docs);
  }

  private findOrThrow(id: string): LayoutDocument {
    const doc = this.docs.find((d) => d.id === id);
    if (!doc) {
      throw new Error(`Layout not found: ${id}`);
    }
    return doc;
  }

  list(): LayoutDocument[] {
    return [...this.docs].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): LayoutDocument | null {
    return this.docs.find((d) => d.id === id) ?? null;
  }

  save(input: NewLayoutInput): LayoutDocument {
    const timestamp = this.now();
    const doc: LayoutDocument = {
      schemaVersion: CURRENT_LAYOUT_SCHEMA_VERSION,
      id: this.genId(),
      name: input.name,
      isDefault: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      windows: input.windows,
      panels: input.panels,
    };
    this.docs = [...this.docs, doc];
    this.persist();
    return doc;
  }

  rename(id: string, name: string): LayoutDocument {
    this.findOrThrow(id);
    const timestamp = this.now();
    let updated: LayoutDocument | undefined;
    this.docs = this.docs.map((d) => {
      if (d.id !== id) return d;
      updated = { ...d, name, updatedAt: timestamp };
      return updated;
    });
    this.persist();
    return updated as LayoutDocument;
  }

  delete(id: string): void {
    this.docs = this.docs.filter((d) => d.id !== id);
    this.persist();
  }

  setDefault(id: string): void {
    // Match the *last* doc with this id (walking from the end) rather than
    // doing a blanket `d.id === id` map: ids are expected to be unique in
    // practice (they come from `genId()`), but if a caller's id generator
    // ever produces a repeat, this still lets exactly one stored layout -
    // the most recently added - become the default instead of flipping
    // every same-id entry at once.
    let matchIndex = -1;
    for (let i = this.docs.length - 1; i >= 0; i -= 1) {
      if (this.docs[i].id === id) {
        matchIndex = i;
        break;
      }
    }
    if (matchIndex === -1) {
      throw new Error(`Layout not found: ${id}`);
    }
    this.docs = this.docs.map((d, i) => ({ ...d, isDefault: i === matchIndex }));
    this.persist();
  }

  getDefault(): LayoutDocument | null {
    return this.docs.find((d) => d.isDefault) ?? null;
  }

  exportJson(id: string): string {
    const doc = this.findOrThrow(id);
    const envelope: LayoutExportEnvelope = {
      exportVersion: CURRENT_LAYOUT_SCHEMA_VERSION,
      exportedAt: this.now(),
      layout: doc,
    };
    return JSON.stringify(envelope);
  }

  /** Validates and imports a layout, assigning it a fresh id to avoid collisions. */
  importJson(json: string): LayoutDocument {
    // JSON.parse throws SyntaxError for malformed input, and
    // parseLayoutExportEnvelope throws (UnsupportedLayoutVersionError or a
    // zod error) for structurally invalid / unsupported-version content.
    // Both happen before any mutation below, so the store is left untouched
    // on any failure.
    const raw = JSON.parse(json);
    const envelope = parseLayoutExportEnvelope(raw);
    const timestamp = this.now();
    const imported: LayoutDocument = {
      ...envelope.layout,
      id: this.genId(),
      isDefault: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.docs = [...this.docs, imported];
    this.persist();
    return imported;
  }
}
