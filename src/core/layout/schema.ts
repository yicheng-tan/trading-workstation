import { z } from 'zod';

export const CURRENT_LAYOUT_SCHEMA_VERSION = 1 as const;

export const PANEL_KINDS = ['depthLadder', 'tradeTape', 'candlestick', 'watchlist'] as const;
export type PanelKind = (typeof PANEL_KINDS)[number];

export const rectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});

export const panelSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(PANEL_KINDS),
  symbols: z.array(z.string().min(1)).min(1),
  linkGroup: z.string().nullable(),
  settings: z.record(z.unknown()).default({}),
  position: rectSchema,
});
export type PanelDocument = z.infer<typeof panelSchema>;

export const windowSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['main', 'popout']),
  bounds: rectSchema.optional(),
  screenId: z.string().optional(),
  panelIds: z.array(z.string().min(1)),
  /**
   * Opaque docking-grid state for this window (dockview's `toJSON()` for the
   * main window): exact splits, sizes, tab groups and active tabs. Optional
   * and additive within v1 - without it, restore falls back to auto-tiling
   * the window's `panelIds`.
   */
  arrangement: z.unknown().optional(),
});
export type WindowDocument = z.infer<typeof windowSchema>;

export const layoutDocumentSchemaV1 = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1),
  isDefault: z.boolean().default(false),
  createdAt: z.number(),
  updatedAt: z.number(),
  windows: z.array(windowSchema).min(1),
  panels: z.array(panelSchema),
});
export type LayoutDocument = z.infer<typeof layoutDocumentSchemaV1>;

export const layoutExportEnvelopeSchema = z.object({
  exportVersion: z.literal(1),
  exportedAt: z.number(),
  layout: layoutDocumentSchemaV1,
});
export type LayoutExportEnvelope = z.infer<typeof layoutExportEnvelopeSchema>;

export class UnsupportedLayoutVersionError extends Error {
  constructor(public readonly foundVersion: unknown) {
    super(`Unsupported layout schema version: ${String(foundVersion)}`);
    this.name = 'UnsupportedLayoutVersionError';
  }
}

/**
 * Narrow helper: reads a `schemaVersion` field off an unknown value without
 * throwing, so version-mismatch detection can run before (and independently
 * of) full zod validation.
 */
function readSchemaVersion(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as { schemaVersion?: unknown }).schemaVersion;
}

/** Parses and validates a raw layout document, raising a clear error for unknown future versions. */
export function parseLayoutDocument(raw: unknown): LayoutDocument {
  const foundVersion = readSchemaVersion(raw);
  if (foundVersion !== undefined && foundVersion !== CURRENT_LAYOUT_SCHEMA_VERSION) {
    throw new UnsupportedLayoutVersionError(foundVersion);
  }
  return layoutDocumentSchemaV1.parse(raw);
}

/** Parses and validates a full export envelope (as written by LayoutStore.exportJson). */
export function parseLayoutExportEnvelope(raw: unknown): LayoutExportEnvelope {
  const embeddedLayout =
    typeof raw === 'object' && raw !== null ? (raw as { layout?: unknown }).layout : undefined;
  const foundVersion = readSchemaVersion(embeddedLayout);
  if (foundVersion !== undefined && foundVersion !== CURRENT_LAYOUT_SCHEMA_VERSION) {
    throw new UnsupportedLayoutVersionError(foundVersion);
  }
  return layoutExportEnvelopeSchema.parse(raw);
}
