import { describe, expect, it } from 'vitest';

import {
  PAIRING_CLAIM_V1_MAX_TTL_MS,
  PairingClaimConsumeRequestV1Schema,
  PairingClaimStartRequestV1Schema,
  PairingClaimStartResponseV1Schema,
  normalizePairingClaimOriginV1,
} from './pairingClaimV1';

describe('pairing claim v1 protocol', () => {
  it('normalizes only credential-free HTTPS origins', () => {
    expect(normalizePairingClaimOriginV1('https://Relay.Example.test/')).toBe('https://relay.example.test');
    expect(normalizePairingClaimOriginV1('http://relay.example.test')).toBeNull();
    expect(normalizePairingClaimOriginV1('https://user:pass@relay.example.test')).toBeNull();
    expect(normalizePairingClaimOriginV1('https://relay.example.test/path')).toBeNull();
    expect(normalizePairingClaimOriginV1('https://relay.example.test?token=x')).toBeNull();
    expect(normalizePairingClaimOriginV1('https://relay.example.test#fragment')).toBeNull();
  });

  it('defines strict start and consume wire contracts', () => {
    expect(PairingClaimStartRequestV1Schema.parse({ origin: 'https://Relay.Example.test/' })).toEqual({
      origin: 'https://relay.example.test',
    });
    expect(PairingClaimStartResponseV1Schema.parse({
      protocol: 'claim-v1',
      claimId: `claim_${'a'.repeat(43)}`,
      origin: 'https://relay.example.test',
      expiresAt: '2026-08-09T12:00:00.000Z',
    }).protocol).toBe('claim-v1');
    expect(PairingClaimConsumeRequestV1Schema.parse({
      claimId: `claim_${'a'.repeat(43)}`,
      origin: 'https://relay.example.test',
      publicKey: 'public-key',
      deviceLabel: 'Phone',
    }).origin).toBe('https://relay.example.test');

    expect(() => PairingClaimStartRequestV1Schema.parse({
      origin: 'https://relay.example.test',
      secret: 'must-not-be-accepted',
    })).toThrow();
    expect(() => PairingClaimConsumeRequestV1Schema.parse({
      claimId: 'pair_legacy',
      origin: 'https://relay.example.test',
      publicKey: 'public-key',
    })).toThrow();
  });

  it('caps the claim lifetime at ten minutes', () => {
    expect(PAIRING_CLAIM_V1_MAX_TTL_MS).toBe(600_000);
  });
});
