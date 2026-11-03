import { describe, it, expect } from 'vitest';
import {
  parseLayoutDocument,
  parseLayoutExportEnvelope,
  UnsupportedLayoutVersionError,
  CURRENT_LAYOUT_SCHEMA_VERSION,
} from './schema';

function validDoc() {
  return {
    schemaVersion: 1,
    id: 'layout-1',
    name: 'My Layout',
    isDefault: false,
    createdAt: 1000,
    updatedAt: 1000,
    windows: [
      { id: 'win-1', role: 'main', panelIds: ['panel-1'] },
    ],
    panels: [
      {
        id: 'panel-1',
        kind: 'depthLadder',
        symbols: ['BTCUSDT'],
        linkGroup: 'A',
        settings: { levels: 20 },
        position: { x: 0, y: 0, width: 400, height: 600 },
      },
    ],
  };
}

describe('layout schema', () => {
  it('accepts a well-formed v1 layout document', () => {
    expect(() => parseLayoutDocument(validDoc())).not.toThrow();
  });

  it('rejects a document missing a required field (name)', () => {
    const doc = validDoc() as any;
    delete doc.name;
    expect(() => parseLayoutDocument(doc)).toThrow();
  });

  it('rejects a panel position with the wrong type', () => {
    const doc = validDoc() as any;
    doc.panels[0].position.width = 'wide';
    expect(() => parseLayoutDocument(doc)).toThrow();
  });

  it('rejects an unknown panel kind', () => {
    const doc = validDoc() as any;
    doc.panels[0].kind = 'heatmap-of-doom';
    expect(() => parseLayoutDocument(doc)).toThrow();
  });

  it('accepts linkGroup as null (unlinked panel)', () => {
    const doc = validDoc() as any;
    doc.panels[0].linkGroup = null;
    expect(() => parseLayoutDocument(doc)).not.toThrow();
  });

  it('rejects a layout with zero windows', () => {
    const doc = validDoc() as any;
    doc.windows = [];
    expect(() => parseLayoutDocument(doc)).toThrow();
  });

  it('raises UnsupportedLayoutVersionError (not a generic parse error) for a future schema version', () => {
    const doc = validDoc() as any;
    doc.schemaVersion = 99;
    expect(() => parseLayoutDocument(doc)).toThrow(UnsupportedLayoutVersionError);
  });

  it('round-trips a valid export envelope', () => {
    const envelope = {
      exportVersion: CURRENT_LAYOUT_SCHEMA_VERSION,
      exportedAt: 123,
      layout: validDoc(),
    };
    const parsed = parseLayoutExportEnvelope(envelope);
    expect(parsed.layout.id).toBe('layout-1');
    expect(parsed.layout.panels).toHaveLength(1);
  });

  it('rejects an export envelope whose embedded layout is invalid', () => {
    const doc = validDoc() as any;
    delete doc.id;
    const envelope = { exportVersion: 1, exportedAt: 1, layout: doc };
    expect(() => parseLayoutExportEnvelope(envelope)).toThrow();
  });
});
