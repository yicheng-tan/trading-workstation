import type { LayoutDocument, WindowDocument, PanelDocument } from './schema';

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

/**
 * In-memory + pluggable-persistence CRUD for named layouts: save, rename,
 * delete, list, set-default, and versioned export/import, per the PRD's
 * layout requirements.
 */
export class LayoutStore {
  constructor(_adapter: LayoutStorageAdapter, _opts?: LayoutStoreOptions) {
    throw new Error('not implemented');
  }

  list(): LayoutDocument[] {
    throw new Error('not implemented');
  }

  get(_id: string): LayoutDocument | null {
    throw new Error('not implemented');
  }

  save(_input: NewLayoutInput): LayoutDocument {
    throw new Error('not implemented');
  }

  rename(_id: string, _name: string): LayoutDocument {
    throw new Error('not implemented');
  }

  delete(_id: string): void {
    throw new Error('not implemented');
  }

  setDefault(_id: string): void {
    throw new Error('not implemented');
  }

  getDefault(): LayoutDocument | null {
    throw new Error('not implemented');
  }

  exportJson(_id: string): string {
    throw new Error('not implemented');
  }

  /** Validates and imports a layout, assigning it a fresh id to avoid collisions. */
  importJson(_json: string): LayoutDocument {
    throw new Error('not implemented');
  }
}
