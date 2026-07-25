import { describe, expect, it } from 'vitest';

import { ProviderSessionInfoV1Schema } from './providerSessionInfoV1';

describe('ProviderSessionInfoV1Schema', () => {
  it('accepts bounded provider session metadata including explicit clears', () => {
    expect(ProviderSessionInfoV1Schema.parse({
      v: 1,
      provider: 'cursor',
      sessionId: 'cursor-session-1',
      observedAt: 123,
      title: null,
      updatedAt: null,
    })).toEqual({
      v: 1,
      provider: 'cursor',
      sessionId: 'cursor-session-1',
      observedAt: 123,
      title: null,
      updatedAt: null,
    });
  });

  it('rejects unbounded or malformed retained fields', () => {
    expect(ProviderSessionInfoV1Schema.safeParse({
      v: 1,
      provider: 'x'.repeat(129),
      sessionId: 'session',
      observedAt: 1,
    }).success).toBe(false);
    expect(ProviderSessionInfoV1Schema.safeParse({
      v: 1,
      provider: 'cursor',
      sessionId: 'session',
      observedAt: 1,
      title: 'x'.repeat(1_025),
    }).success).toBe(false);
    expect(ProviderSessionInfoV1Schema.safeParse({
      v: 1,
      provider: 'cursor',
      sessionId: 'session',
      observedAt: 1,
      updatedAt: 'not-an-iso-timestamp',
    }).success).toBe(false);
  });
});
