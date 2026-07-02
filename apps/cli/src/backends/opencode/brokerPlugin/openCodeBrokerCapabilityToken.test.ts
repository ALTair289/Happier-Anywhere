import { describe, expect, it } from 'vitest';

import {
  CONNECTED_SERVICE_BROKER_REFRESH_SCOPE_LABEL,
  CONNECTED_SERVICE_BROKER_REFRESH_TOKEN_ENV,
  deriveConnectedServiceBrokerRefreshToken,
} from '@/daemon/connectedServices/broker/brokerRefreshCapabilityToken';

import {
  OPEN_CODE_BROKER_REFRESH_SCOPE_LABEL,
  OPEN_CODE_BROKER_REFRESH_TOKEN_ENV,
  deriveOpenCodeBrokerRefreshToken,
  isValidOpenCodeBrokerRefreshToken,
} from './openCodeBrokerCapabilityToken';

describe('openCodeBrokerCapabilityToken', () => {
  it('derives a deterministic scoped token from the master control token', () => {
    const a = deriveOpenCodeBrokerRefreshToken('master-control-token');
    const b = deriveOpenCodeBrokerRefreshToken('master-control-token');
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('is NOT equal to the master control token (least privilege — the broker never gets the master)', () => {
    const master = 'master-control-token';
    const scoped = deriveOpenCodeBrokerRefreshToken(master);
    expect(scoped).not.toBe(master);
    expect(scoped).not.toContain(master);
  });

  it('produces different tokens for different master secrets', () => {
    expect(deriveOpenCodeBrokerRefreshToken('token-a')).not.toBe(deriveOpenCodeBrokerRefreshToken('token-b'));
  });

  it('returns empty for an empty/blank master token (fail-closed)', () => {
    expect(deriveOpenCodeBrokerRefreshToken('')).toBe('');
    expect(deriveOpenCodeBrokerRefreshToken('   ')).toBe('');
    expect(deriveOpenCodeBrokerRefreshToken(null)).toBe('');
    expect(deriveOpenCodeBrokerRefreshToken(undefined)).toBe('');
  });

  it('validates the scoped token against the master and rejects the master itself', () => {
    const master = 'master-control-token';
    const scoped = deriveOpenCodeBrokerRefreshToken(master);
    expect(isValidOpenCodeBrokerRefreshToken(scoped, master)).toBe(true);
    // The master token must NOT pass the scoped check (it authorizes broad endpoints, not this one).
    expect(isValidOpenCodeBrokerRefreshToken(master, master)).toBe(false);
    // A scoped token for a different master must not pass.
    expect(isValidOpenCodeBrokerRefreshToken(deriveOpenCodeBrokerRefreshToken('other'), master)).toBe(false);
  });

  it('fails closed on empty/blank inputs', () => {
    const master = 'master-control-token';
    expect(isValidOpenCodeBrokerRefreshToken('', master)).toBe(false);
    expect(isValidOpenCodeBrokerRefreshToken(null, master)).toBe(false);
    expect(isValidOpenCodeBrokerRefreshToken(deriveOpenCodeBrokerRefreshToken(master), '')).toBe(false);
  });

  it('is a thin alias over the SHARED provider-agnostic core (dedup — same token authorizes every broker)', () => {
    // The OpenCode-local names now re-export the shared, provider-agnostic core so the OpenCode plugin,
    // the Pi extension, and the SINGLE daemon bridge preHandler derive/verify the IDENTICAL scoped token.
    expect(OPEN_CODE_BROKER_REFRESH_SCOPE_LABEL).toBe(CONNECTED_SERVICE_BROKER_REFRESH_SCOPE_LABEL);
    expect(OPEN_CODE_BROKER_REFRESH_TOKEN_ENV).toBe(CONNECTED_SERVICE_BROKER_REFRESH_TOKEN_ENV);
    expect(deriveOpenCodeBrokerRefreshToken('master')).toBe(deriveConnectedServiceBrokerRefreshToken('master'));
  });
});
