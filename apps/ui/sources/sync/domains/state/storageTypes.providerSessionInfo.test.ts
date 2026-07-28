import { describe, expect, it } from 'vitest';

import { MetadataSchema } from './storageTypes';

describe('MetadataSchema providerSessionInfoV1', () => {
  it('retains valid bounded provider session diagnostics', () => {
    const parsed = MetadataSchema.parse({
      path: '/workspace',
      host: 'machine',
      providerSessionInfoV1: {
        v: 1,
        provider: 'cursor',
        sessionId: 'cursor-session-1',
        observedAt: 100,
        title: null,
        updatedAt: '2026-07-11T10:00:00.000Z',
      },
    });
    expect(parsed.providerSessionInfoV1).toMatchObject({
      provider: 'cursor',
      sessionId: 'cursor-session-1',
      title: null,
    });
  });

  it('drops only malformed provider diagnostics without rejecting session metadata', () => {
    const parsed = MetadataSchema.parse({
      path: '/workspace',
      host: 'machine',
      name: 'Workspace',
      providerSessionInfoV1: {
        v: 1,
        provider: 'cursor',
        sessionId: 'cursor-session-1',
        observedAt: 100,
        title: 'x'.repeat(2_000),
      },
    });
    expect(parsed.name).toBe('Workspace');
    expect(parsed.providerSessionInfoV1).toBeUndefined();
  });
});
