import React, { useRef, useState } from 'react';
import type { LayoutStore, NewLayoutInput } from '../core/layout/LayoutStore';
import type { LayoutDocument } from '../core/layout/schema';
import './workspace.css';

export interface LayoutPanelProps {
  store: LayoutStore;
  /** Captures the live workspace (main window panels/positions) as save-ready input; `name` is a placeholder the save flow overwrites. */
  getCurrentLayoutInput: () => NewLayoutInput;
  /** Applies a chosen layout back into the workspace (and opens its pop-out windows). */
  onRestoreLayout: (layout: LayoutDocument) => void;
  onClose?: () => void;
}

function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'layout';
}

function formatUpdatedAt(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

export function LayoutPanel({ store, getCurrentLayoutInput, onRestoreLayout, onClose }: LayoutPanelProps) {
  const [layouts, setLayouts] = useState<LayoutDocument[]>(() => store.list());
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function refresh() {
    setLayouts(store.list());
  }

  function handleSaveAsNew() {
    const name = window.prompt('Name this layout:', '');
    if (!name || !name.trim()) return;
    setError(null);
    const input = getCurrentLayoutInput();
    try {
      store.save({ ...input, name: name.trim() });
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save layout.');
    }
  }

  function handleLoad(doc: LayoutDocument) {
    const fresh = store.get(doc.id);
    if (!fresh) {
      setError('That layout no longer exists.');
      refresh();
      return;
    }
    onRestoreLayout(fresh);
  }

  function handleRename(doc: LayoutDocument) {
    const name = window.prompt('Rename layout:', doc.name);
    if (!name || !name.trim() || name.trim() === doc.name) return;
    setError(null);
    try {
      store.rename(doc.id, name.trim());
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to rename layout.');
    }
  }

  function handleDelete(doc: LayoutDocument) {
    if (!window.confirm(`Delete layout “${doc.name}”? This cannot be undone.`)) return;
    setError(null);
    try {
      store.delete(doc.id);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete layout.');
    }
  }

  function handleSetDefault(doc: LayoutDocument) {
    setError(null);
    try {
      store.setDefault(doc.id);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to set default layout.');
    }
  }

  function handleExport(doc: LayoutDocument) {
    setError(null);
    try {
      const json = store.exportJson(doc.id);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${slugify(doc.name)}.layout.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to export layout.');
    }
  }

  function handleImportFile(file: File) {
    setError(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = typeof reader.result === 'string' ? reader.result : '';
        store.importJson(text);
        refresh();
      } catch (e) {
        setError(
          e instanceof Error
            ? `Import failed: ${e.message}`
            : 'Import failed: the file is not a valid layout export.',
        );
      }
    };
    reader.onerror = () => setError('Could not read the selected file.');
    reader.readAsText(file);
  }

  return (
    <aside className="layout-panel" role="complementary" aria-label="Saved layouts">
      <header className="layout-panel__header">
        <h2 className="layout-panel__title">Layouts</h2>
        {onClose && (
          <button type="button" className="layout-panel__close" onClick={onClose} aria-label="Close layouts panel">
            ✕
          </button>
        )}
      </header>

      <div className="layout-panel__actions">
        <button type="button" className="ws-toolbar__btn ws-toolbar__btn--primary" onClick={handleSaveAsNew}>
          Save current as new layout
        </button>
        <button type="button" className="ws-toolbar__btn" onClick={() => fileInputRef.current?.click()}>
          Import…
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="layout-panel__file-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleImportFile(file);
            e.target.value = '';
          }}
        />
      </div>

      {error && (
        <p className="layout-panel__error" role="alert">
          {error}
        </p>
      )}

      <ul className="layout-panel__list">
        {layouts.length === 0 && <li className="layout-panel__empty">No saved layouts yet.</li>}
        {layouts.map((doc) => (
          <li key={doc.id} className="layout-panel__item">
            <div className="layout-panel__item-main">
              <span className="layout-panel__name">{doc.name}</span>
              {doc.isDefault && <span className="layout-panel__badge">Default</span>}
              <span className="layout-panel__meta">Updated {formatUpdatedAt(doc.updatedAt)}</span>
            </div>
            <div className="layout-panel__item-actions">
              <button type="button" onClick={() => handleLoad(doc)}>
                Load
              </button>
              <button type="button" onClick={() => handleRename(doc)}>
                Rename
              </button>
              <button type="button" onClick={() => handleSetDefault(doc)} disabled={doc.isDefault}>
                Set default
              </button>
              <button type="button" onClick={() => handleExport(doc)}>
                Export
              </button>
              <button type="button" className="layout-panel__btn--danger" onClick={() => handleDelete(doc)}>
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}
