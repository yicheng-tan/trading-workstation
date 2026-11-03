# Layout JSON schema

Canonical source of truth: the zod schemas in [`src/core/layout/schema.ts`](../core/layout/schema.ts)
(`panelSchema`, `windowSchema`, `layoutDocumentSchemaV1`, `layoutExportEnvelopeSchema`).
This file is the human-readable reference for the README and for anyone
hand-editing or reviewing a `.layout.json` export.

## `schemaVersion` / `exportVersion`

Both are literal `1` today (`CURRENT_LAYOUT_SCHEMA_VERSION` in `schema.ts`).
They version two different things:

- `LayoutDocument.schemaVersion` - the shape of a single stored layout.
- `LayoutExportEnvelope.exportVersion` - the shape of the *exported file*
  wrapping a layout (so the envelope and the embedded layout could in
  principle evolve independently, e.g. a v2 envelope that can still carry a
  v1 layout untouched).

**Forward compatibility contract:** when either version field doesn't match
the version this build understands, parsing throws `UnsupportedLayoutVersionError`
(exported from `schema.ts`) - a distinct, catchable error type rather than a
generic zod validation error. This lets callers (`LayoutStore.importJson`,
`localStorageAdapter.load`) distinguish "this record is from an incompatible
future version of the app" (skip/report cleanly) from "this record is just
malformed" (also handled, but a different failure mode worth logging
differently). A future schema bump should add a migration step
(`migrateLayoutDocument(raw, fromVersion)`) ahead of the version-equality
check in `schema.ts`, rather than mutating v1's shape in place - old exports
and localStorage records must keep loading after an upgrade.

## `LayoutDocument` (one saved/loaded layout)

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | `1` | See above. |
| `id` | `string` | Stable identity; regenerated fresh on import so re-importing the same file never collides with the original. |
| `name` | `string` | User-facing, editable via rename. |
| `isDefault` | `boolean` | At most one stored layout has `true` at a time; `LayoutStore.setDefault` enforces this. The default layout's main-window panels open automatically on launch. |
| `createdAt` / `updatedAt` | `number` (epoch ms) | `updatedAt` drives `list()` sort order (most-recently-touched first). |
| `windows` | `WindowDocument[]` | Exactly one with `role: 'main'`; zero or more with `role: 'popout'`. |
| `panels` | `PanelDocument[]` | Every panel referenced by any window's `panelIds`, across every window. |

## `WindowDocument`

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Stable per-window id; a pop-out's id is also the `?popout=<id>` URL param and the `localStorage['trading-workstation:popout:' + id]` key used to hand its panels to the new OS window (see `windowManager.ts`'s header comment and `popoutRegistry.ts` for the full handoff contract). |
| `role` | `'main' \| 'popout'` | `'main'` is the dockview grid in the original window; `'popout'` windows are restored via `window.open`. |
| `bounds` | `{ x, y, width, height }` (optional) | Screen-relative placement for a pop-out (`screenX/screenY` + inner size, as reported by the pop-out itself every 2s). Omitted → cascaded default placement. |
| `screenId` | `string` (optional) | An id from the Window Management API's `getScreenDetails()`, best-effort honoured when re-opening a pop-out on a specific monitor; silently ignored if that API/permission is unavailable. |
| `panelIds` | `string[]` | References into the layout's `panels` array. May be empty (e.g. a main window whose every panel is popped out). |
| `arrangement` | `unknown` (optional) | Opaque docking-grid state: for the main window, dockview's `api.toJSON()` (exact splits, sizes, tab groups, active tabs). Restore applies it with `api.fromJSON()`; if it's absent or can't be applied, the window's `panelIds` are auto-tiled instead. Additive within v1, so older v1 files without it still load. |

## `PanelDocument`

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Unique within the layout. |
| `kind` | `'depthLadder' \| 'tradeTape' \| 'candlestick' \| 'watchlist'` | Maps through `PANEL_COMPONENTS` in `src/panels/registry.tsx`. An unrecognized value fails validation outright (zod `enum`); a recognized-but-not-yet-implemented kind renders a "Panel type not available" placeholder at runtime instead of crashing. |
| `symbols` | `string[]` (min 1) | Primary symbol first; a watchlist panel's full tracked list. |
| `linkGroup` | `string \| null` | Panels sharing a non-null `linkGroup` change symbol together (including across pop-out windows) via `LinkGroupContext`'s `BroadcastChannel`. `null` = unlinked. |
| `settings` | `Record<string, unknown>` | Panel-kind-specific (e.g. depth levels, chart interval). Opaque to the workspace/layout layer. |
| `position` | `{ x, y, width, height }` | Measured on-screen rect (CSS px) of the panel's group within its window's docking area at save time. Informational; the main window's exact grid comes from `arrangement`. |

## `LayoutExportEnvelope` (what `exportJson()` / a `.layout.json` file contains)

```json
{
  "exportVersion": 1,
  "exportedAt": 1730000000000,
  "layout": { "schemaVersion": 1, "...": "a full LayoutDocument" }
}
```

`importJson()` validates the whole envelope, then assigns the embedded
layout a **fresh `id`** (and fresh `createdAt`/`updatedAt`, `isDefault: false`)
before adding it to the store - re-importing the same file twice (or
importing it into a different install) always produces a new, independent
saved layout rather than colliding with or overwriting an existing one by id.
