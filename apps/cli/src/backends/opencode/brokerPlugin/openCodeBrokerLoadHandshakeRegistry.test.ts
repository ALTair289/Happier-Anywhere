import { afterEach, describe, expect, it } from 'vitest';

import {
  OpenCodeBrokerLoadHandshakeRequestSchema,
  recordOpenCodeBrokerLoadHandshake,
  resetOpenCodeBrokerLoadHandshakesForTests,
  wasOpenCodeBrokerLoadHandshakeObserved,
} from './openCodeBrokerLoadHandshakeRegistry';

const IDENTITY = 'opencode|connected|broker:1|openai-codex:p:';

describe('openCodeBrokerLoadHandshakeRegistry', () => {
  afterEach(() => {
    resetOpenCodeBrokerLoadHandshakesForTests();
  });

  it('records a handshake and reports it observed for the same selection identity', () => {
    expect(wasOpenCodeBrokerLoadHandshakeObserved({ selectionIdentity: IDENTITY, loadNonce: 'spawn-a' }, 1_000)).toBe(false);
    recordOpenCodeBrokerLoadHandshake({ selectionIdentity: IDENTITY, loadNonce: 'spawn-a', providers: ['openai'] }, 1_000);
    expect(wasOpenCodeBrokerLoadHandshakeObserved({ selectionIdentity: IDENTITY, loadNonce: 'spawn-a' }, 1_500)).toBe(true);
  });

  it('requires the broker load nonce to match the current runtime process', () => {
    recordOpenCodeBrokerLoadHandshake({
      selectionIdentity: IDENTITY,
      loadNonce: 'spawn-a',
      providers: ['openai'],
    }, 1_000);

    expect(wasOpenCodeBrokerLoadHandshakeObserved({
      selectionIdentity: IDENTITY,
      loadNonce: 'spawn-a',
    }, 1_500)).toBe(true);
    expect(wasOpenCodeBrokerLoadHandshakeObserved({
      selectionIdentity: IDENTITY,
      loadNonce: 'spawn-b',
    }, 1_500)).toBe(false);
  });

  it('scopes observation to the selection identity', () => {
    recordOpenCodeBrokerLoadHandshake({ selectionIdentity: IDENTITY, loadNonce: 'spawn-a', providers: ['openai'] }, 1_000);
    expect(wasOpenCodeBrokerLoadHandshakeObserved({ selectionIdentity: 'other-identity', loadNonce: 'spawn-a' }, 1_500)).toBe(false);
  });

  it('treats a stale handshake as not observed (bounded freshness)', () => {
    recordOpenCodeBrokerLoadHandshake({ selectionIdentity: IDENTITY, loadNonce: 'spawn-a', providers: ['openai'] }, 1_000);
    // Far in the future, beyond the freshness horizon, the prior handshake no longer counts.
    expect(wasOpenCodeBrokerLoadHandshakeObserved({ selectionIdentity: IDENTITY, loadNonce: 'spawn-a' }, 1_000 + 48 * 60 * 60 * 1000)).toBe(false);
  });

  it('validates the handshake request schema', () => {
    expect(OpenCodeBrokerLoadHandshakeRequestSchema.safeParse({ selectionIdentity: IDENTITY, loadNonce: 'spawn-a', providers: ['openai'] }).success).toBe(true);
    expect(OpenCodeBrokerLoadHandshakeRequestSchema.safeParse({ selectionIdentity: IDENTITY, providers: ['openai'] }).success).toBe(false);
    expect(OpenCodeBrokerLoadHandshakeRequestSchema.safeParse({ selectionIdentity: '', loadNonce: 'spawn-a', providers: ['openai'] }).success).toBe(false);
    expect(OpenCodeBrokerLoadHandshakeRequestSchema.safeParse({ selectionIdentity: IDENTITY, loadNonce: '', providers: ['openai'] }).success).toBe(false);
    expect(OpenCodeBrokerLoadHandshakeRequestSchema.safeParse({ selectionIdentity: IDENTITY, loadNonce: 'spawn-a', providers: ['nope'] }).success).toBe(false);
  });
});
