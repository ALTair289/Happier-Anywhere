import { describe, expect, it } from 'vitest';

import {
  CONNECTED_SERVICE_BROKER_REFRESH_SCOPE_LABEL,
  deriveConnectedServiceBrokerRefreshToken,
  isValidConnectedServiceBrokerRefreshToken,
  CONNECTED_SERVICE_RUN_MATERIALIZE_SCOPE_LABEL,
  deriveConnectedServiceRunMaterializeToken,
  isValidConnectedServiceRunMaterializeToken,
} from './brokerRefreshCapabilityToken';

describe('brokerRefreshCapabilityToken (shared, provider-agnostic)', () => {
  it('derives a deterministic scoped token from the master control token', () => {
    const a = deriveConnectedServiceBrokerRefreshToken('master-control-token');
    const b = deriveConnectedServiceBrokerRefreshToken('master-control-token');
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('is NOT equal to the master control token (least privilege — no broker ever gets the master)', () => {
    const master = 'master-control-token';
    const scoped = deriveConnectedServiceBrokerRefreshToken(master);
    expect(scoped).not.toBe(master);
    expect(scoped).not.toContain(master);
  });

  it('produces different tokens for different master secrets', () => {
    expect(deriveConnectedServiceBrokerRefreshToken('token-a')).not.toBe(
      deriveConnectedServiceBrokerRefreshToken('token-b'),
    );
  });

  it('returns empty for an empty/blank master token (fail-closed)', () => {
    expect(deriveConnectedServiceBrokerRefreshToken('')).toBe('');
    expect(deriveConnectedServiceBrokerRefreshToken('   ')).toBe('');
    expect(deriveConnectedServiceBrokerRefreshToken(null)).toBe('');
    expect(deriveConnectedServiceBrokerRefreshToken(undefined)).toBe('');
  });

  it('validates the scoped token against the master and rejects the master itself', () => {
    const master = 'master-control-token';
    const scoped = deriveConnectedServiceBrokerRefreshToken(master);
    expect(isValidConnectedServiceBrokerRefreshToken(scoped, master)).toBe(true);
    expect(isValidConnectedServiceBrokerRefreshToken(master, master)).toBe(false);
    expect(isValidConnectedServiceBrokerRefreshToken(deriveConnectedServiceBrokerRefreshToken('other'), master)).toBe(false);
  });

  it('fails closed on empty/blank inputs', () => {
    const master = 'master-control-token';
    expect(isValidConnectedServiceBrokerRefreshToken('', master)).toBe(false);
    expect(isValidConnectedServiceBrokerRefreshToken(null, master)).toBe(false);
    expect(isValidConnectedServiceBrokerRefreshToken(deriveConnectedServiceBrokerRefreshToken(master), '')).toBe(false);
  });

  it('pins a versioned, provider-agnostic scope label (the SAME token authorizes every broker)', () => {
    // Provider-agnostic so the OpenCode plugin AND the Pi extension derive the SAME scoped token, and a
    // SINGLE bridge preHandler (`requireBrokerRefreshAuth`) authorizes both. Versioned so a future
    // scope/format change is unambiguous.
    expect(CONNECTED_SERVICE_BROKER_REFRESH_SCOPE_LABEL).toBe('happier:connected-service-broker-refresh:v1');
  });

  it('keeps run-materialize and broker-refresh scopes mutually exclusive (POST-WAVE-REVIEW F2 least privilege)', () => {
    const master = 'master-control-token';
    const brokerToken = deriveConnectedServiceBrokerRefreshToken(master);
    const runToken = deriveConnectedServiceRunMaterializeToken(master);
    expect(runToken).not.toBe(brokerToken);
    // Each validator accepts ONLY its own scope: a leaked run token cannot reach the broker
    // endpoints and a leaked broker token cannot materialize execution-run credentials.
    expect(isValidConnectedServiceRunMaterializeToken(runToken, master)).toBe(true);
    expect(isValidConnectedServiceRunMaterializeToken(brokerToken, master)).toBe(false);
    expect(isValidConnectedServiceBrokerRefreshToken(runToken, master)).toBe(false);
    // Neither validator accepts the master token.
    expect(isValidConnectedServiceRunMaterializeToken(master, master)).toBe(false);
    expect(CONNECTED_SERVICE_RUN_MATERIALIZE_SCOPE_LABEL).toBe('happier:connected-service-run-materialize:v1');
  });
});
