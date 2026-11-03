/**
 * =============================================================================
 * LAYOUT JSON SCHEMA (v1) - summary
 * =============================================================================
 * Full field-by-field reference lives in `src/workspace/LAYOUT_SCHEMA.md`
 * (intended to be linked from the project README). Quick summary for anyone
 * reading this file in isolation:
 *
 *   LayoutDocument (src/core/layout/schema.ts, `layoutDocumentSchemaV1`):
 *     schemaVersion: 1              - literal tag; see "Forward compat" below
 *     id, name                     - identity + display name
 *     isDefault                    - at most one stored layout has this true
 *     createdAt, updatedAt         - epoch ms
 *     windows: WindowDocument[]    - exactly one `role: 'main'`, any number
 *                                    of `role: 'popout'`
 *     panels: PanelDocument[]      - every panel referenced by any window's
 *                                    `panelIds`
 *
 *   WindowDocument: { id, role: 'main' | 'popout', bounds?, screenId?, panelIds[] }
 *   PanelDocument:  { id, kind, symbols[], linkGroup, settings, position }
 *
 *   LayoutExportEnvelope (`layoutExportEnvelopeSchema`), what `exportJson()`
 *   writes to a `.layout.json` file:
 *     { exportVersion: 1, exportedAt: <epoch ms>, layout: LayoutDocument }
 *
 * `schemaVersion: 1` / `exportVersion: 1` mark the CURRENT shape
 * (`CURRENT_LAYOUT_SCHEMA_VERSION` in schema.ts). Forward-compat contract:
 * a file/stored record whose version doesn't match throws
 * `UnsupportedLayoutVersionError` (not a generic parse error) from
 * `parseLayoutDocument` / `parseLayoutExportEnvelope`, so callers (including
 * `LayoutStore.importJson` and `localStorageAdapter.load`) can show/skip it
 * cleanly instead of crashing or silently misinterpreting a future shape. A
 * future schema bump is expected to add a `migrateLayoutDocument(raw, from)`
 * step ahead of this version check rather than editing v1's shape in place.
 * =============================================================================
 */
import type { LayoutDocument, PanelDocument } from '../core/layout/schema';
import type { PanelInstanceConfig } from '../panels/PanelProps';
import { openPopoutWindowsForLayout } from './windowManager';

export interface RestoreLayoutResult {
  /** The main window's panels, ready to hand to `WorkspaceShell`'s dockview grid. */
  mainPanels: PanelInstanceConfig[];
  openedWindows: number;
  blockedWindows: number;
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
 * Applies `layout`: resolves the main window's panel list (for the caller -
 * typically `WorkspaceShell` via a `setPanels` state setter - to render into
 * its dockview grid) and opens every pop-out window in one synchronous pass
 * via `openPopoutWindowsForLayout`.
 *
 * A real restore of a layout with many pop-outs may need a couple of clicks:
 * browsers cap how many `window.open` calls succeed per user gesture, so a
 * heavy layout can come back as "opened: 6, blocked: 2" on the first click.
 * The PRD explicitly allows this ("A few clicks to start the restore is
 * acceptable") - callers should surface `blockedWindows` and offer a
 * "finish restoring" retry button rather than silently dropping those
 * windows; re-invoking `restoreLayout` (or `openPopoutWindowsForLayout`
 * directly) from another click will simply re-open whatever remains closed.
 *
 * This only ever reads `layout`; it does not touch the `LayoutStore` (no
 * `isDefault`/`updatedAt` mutation), so restoring is side-effect-free with
 * respect to storage.
 */
export function restoreLayout(layout: LayoutDocument): RestoreLayoutResult {
  const panelsById = new Map(layout.panels.map((p) => [p.id, p]));
  const mainWindow = layout.windows.find((w) => w.role === 'main');

  const mainPanels: PanelInstanceConfig[] = (mainWindow?.panelIds ?? [])
    .map((id) => panelsById.get(id))
    .filter((p): p is PanelDocument => p !== undefined)
    .map(toPanelInstanceConfig);

  const { opened, blocked } = openPopoutWindowsForLayout(layout);

  return { mainPanels, openedWindows: opened, blockedWindows: blocked };
}
