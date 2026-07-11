import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';

type ParseableSchema = Readonly<{
  parse(value: unknown): unknown;
  safeParse(value: unknown): { success: boolean };
}>;

function isParseableSchema(value: unknown): value is ParseableSchema {
  if (value === null || typeof value !== 'object') return false;
  return typeof Reflect.get(value, 'parse') === 'function' && typeof Reflect.get(value, 'safeParse') === 'function';
}

function readSchema(name: string): ParseableSchema {
  const value = Reflect.get(protocol, name);
  expect(value).toBeDefined();
  expect(isParseableSchema(value)).toBe(true);
  if (!isParseableSchema(value)) {
    throw new Error(`Expected ${name} to be a parseable schema export`);
  }
  return value;
}

const validMediaItem = {
  id: 'media_1',
  role: 'output',
  category: 'generated',
  mediaKind: 'image',
  mimeType: 'image/png',
  name: 'generated-image.png',
  path: '.happier/uploads/generated/msg_1/media_1.png',
  sizeBytes: 42,
  sha256: 'a'.repeat(64),
  width: 1024,
  height: 768,
  createdAtMs: 1710000000000,
  origin: {
    source: 'provider-generated',
    agentId: 'codex',
    toolCallId: 'call_1',
    generationId: 'gen_1',
    providerEventId: 'event_1',
    providerFileId: 'file_1',
  },
} as const;

describe('session media v1 schemas', () => {
  it('accepts persisted generated image metadata with provider origin identifiers', () => {
    const schema = readSchema('SessionMediaItemV1Schema');

    const parsed = schema.parse(validMediaItem);

    expect(parsed).toEqual(validMediaItem);
  });

  it('accepts bounded generated descriptions and portable reference-image metadata', () => {
    const schema = readSchema('SessionMediaItemV1Schema');
    const item = {
      ...validMediaItem,
      description: 'Architecture diagram',
      references: [{
        mediaKind: 'image',
        path: 'references/source.png',
        mimeType: 'image/png',
        sizeBytes: 42,
      }],
    };

    expect(schema.parse(item)).toEqual(item);
    expect(schema.safeParse({
      ...item,
      references: [{ ...item.references[0], path: '/private/source.png' }],
    }).success).toBe(false);
    expect(schema.safeParse({
      ...item,
      references: [{ ...item.references[0], path: `references/${'a'.repeat(16_384)}.png` }],
    }).success).toBe(false);
  });

  it('accepts the exact session_media.v1 meta envelope shape', () => {
    const schema = readSchema('SessionMediaMessageMetaEnvelopeV1Schema');

    const parsed = schema.parse({
      kind: 'session_media.v1',
      payload: {
        media: [validMediaItem],
      },
    });

    expect(parsed).toEqual({
      kind: 'session_media.v1',
      payload: {
        media: [validMediaItem],
      },
    });
  });

  it('rejects empty media envelopes', () => {
    const schema = readSchema('SessionMediaMessageMetaEnvelopeV1Schema');

    expect(schema.safeParse({ kind: 'session_media.v1', payload: { media: [] } }).success).toBe(false);
  });

  it('bounds the number of media items in one durable envelope', () => {
    const schema = readSchema('SessionMediaMessageMetaEnvelopeV1Schema');

    expect(schema.safeParse({
      kind: 'session_media.v1',
      payload: { media: Array.from({ length: 257 }, (_, index) => ({ ...validMediaItem, id: `media_${index}` })) },
    }).success).toBe(false);
  });

  it('rejects transient bytes and unsafe persisted paths', () => {
    const schema = readSchema('SessionMediaItemV1Schema');
    const invalidItems = [
      { ...validMediaItem, data: 'iVBORw0KGgo=' },
      { ...validMediaItem, path: 'file:///tmp/generated.png' },
      { ...validMediaItem, path: '/tmp/provider/generated.png' },
      { ...validMediaItem, path: 'C:\\Users\\alice\\AppData\\Local\\provider\\generated.png' },
      { ...validMediaItem, path: 'https://provider.example/tmp/generated.png' },
      { ...validMediaItem, path: 'data:image/png;base64,iVBORw0KGgo=' },
      { ...validMediaItem, path: '.happier/uploads/generated/../secret.png' },
      { ...validMediaItem, path: '.happier\\uploads\\generated\\msg_1\\media_1.png' },
    ];

    for (const item of invalidItems) {
      expect(schema.safeParse(item).success).toBe(false);
    }
  });

  it('rejects unsupported enum values and missing required media fields', () => {
    const schema = readSchema('SessionMediaItemV1Schema');
    const invalidItems = [
      { ...validMediaItem, role: 'assistant' },
      { ...validMediaItem, category: 'preview' },
      { ...validMediaItem, mediaKind: 'audio' },
      { ...validMediaItem, mimeType: 'application/octet-stream' },
      { ...validMediaItem, name: '' },
      { ...validMediaItem, path: '' },
      { ...validMediaItem, sizeBytes: 0 },
    ];

    for (const item of invalidItems) {
      expect(schema.safeParse(item).success).toBe(false);
    }
  });

  it('rejects backendId in persisted origin metadata', () => {
    const schema = readSchema('SessionMediaItemV1Schema');

    expect(
      schema.safeParse({
        ...validMediaItem,
        origin: {
          ...validMediaItem.origin,
          backendId: 'codex',
        },
      }).success,
    ).toBe(false);
  });

  it('bounds durable media names and provider correlation identifiers', () => {
    const schema = readSchema('SessionMediaItemV1Schema');
    const oversizedName = 'x'.repeat(513);
    const oversizedOriginId = 'x'.repeat(16_385);

    expect(schema.safeParse({ ...validMediaItem, id: oversizedName }).success).toBe(false);
    expect(schema.safeParse({ ...validMediaItem, name: oversizedName }).success).toBe(false);
    for (const field of ['agentId', 'toolCallId', 'generationId', 'providerEventId', 'providerFileId'] as const) {
      expect(schema.safeParse({
        ...validMediaItem,
        origin: { ...validMediaItem.origin, [field]: oversizedOriginId },
      }).success).toBe(false);
    }
  });
});
