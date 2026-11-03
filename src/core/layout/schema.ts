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
  panelIds: z.array(z.string().min(1)).min(1),
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

/** Parses and validates a raw layout document, raising a clear error for unknown future versions. */
export function parseLayoutDocument(_raw: unknown): LayoutDocument {
  throw new Error('not implemented');
}

/** Parses and validates a full export envelope (as written by LayoutStore.exportJson). */
export function parseLayoutExportEnvelope(_raw: unknown): LayoutExportEnvelope {
  throw new Error('not implemented');
}
