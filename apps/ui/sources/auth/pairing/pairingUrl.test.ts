import { describe, expect, it } from 'vitest';

import { buildPairingClaimDeepLink, buildPairingDeepLink, parsePairingDeepLink } from './pairingUrl';

describe('parsePairingDeepLink', () => {
    const claimId = `claim_${'a'.repeat(43)}`;
    const canonicalClaimLink = `happier:///pair?v=claim-v1&claimId=${claimId}&origin=https%3A%2F%2Frelay.example.test`;

    it('parses canonical pairing deep links', () => {
        expect(
            parsePairingDeepLink(
                'happier:///pair?v=1&pairId=pid123&secret=sec_abc&server=https%3A%2F%2Fstack.example.test',
            ),
        ).toEqual({
            pairId: 'pid123',
            secret: 'sec_abc',
            serverUrl: 'https://stack.example.test',
        });
    });

    it('rejects non-pair links', () => {
        expect(parsePairingDeepLink('happier:///account?abc')).toBeNull();
    });

    it('rejects missing required params', () => {
        expect(parsePairingDeepLink('happier:///pair?v=1&pairId=pid123')).toBeNull();
    });

    it('ignores unsafe server URL schemes', () => {
        expect(
            parsePairingDeepLink('happier:///pair?v=1&pairId=pid123&secret=sec_abc&server=javascript%3Aalert(1)'),
        ).toEqual({
            pairId: 'pid123',
            secret: 'sec_abc',
            serverUrl: null,
        });
    });

    it('preserves legacy scheme, authority, and fragment compatibility', () => {
        expect(parsePairingDeepLink('happier-preview://pair?v=1&pairId=pid123&secret=sec_abc#ignored')).toEqual({
            pairId: 'pid123',
            secret: 'sec_abc',
            serverUrl: null,
        });
    });

    it('parses a claim-v1 link containing only an opaque claim and HTTPS origin', () => {
        expect(parsePairingDeepLink(canonicalClaimLink)).toEqual({ claimId, origin: 'https://relay.example.test' });
    });

    it('fails closed for claim-v1 secrets, duplicate fields, non-HTTPS origins, or legacy ids', () => {
        expect(parsePairingDeepLink(`happier:///pair?v=claim-v1&claimId=${claimId}&origin=http%3A%2F%2Frelay.test`)).toBeNull();
        expect(parsePairingDeepLink(`happier:///pair?v=claim-v1&claimId=${claimId}&claimId=${claimId}&origin=https%3A%2F%2Frelay.test`)).toBeNull();
        expect(parsePairingDeepLink(`happier:///pair?v=claim-v1&claimId=${claimId}&origin=https%3A%2F%2Frelay.test&secret=leak`)).toBeNull();
        expect(parsePairingDeepLink('happier:///pair?v=claim-v1&claimId=pair_legacy&origin=https%3A%2F%2Frelay.test')).toBeNull();
    });

    it('rejects raw fragments and non-canonical HTTPS origins for claim-v1', () => {
        expect(parsePairingDeepLink(`${canonicalClaimLink}#ignored`)).toBeNull();
        expect(
            parsePairingDeepLink(
                `happier:///pair?v=claim-v1&claimId=${claimId}&origin=https%3A%2F%2FRelay.Example.test%2F`,
            ),
        ).toBeNull();
    });

    it('requires the exact configured scheme for claim-v1', () => {
        expect(parsePairingDeepLink(canonicalClaimLink.replace('happier:', 'HAPPIER:'))).toBeNull();
        expect(parsePairingDeepLink(canonicalClaimLink.replace('happier:', 'happier-preview:'))).toBeNull();
    });

    it('rejects claim-v1 authority, host, and path variants', () => {
        const query = canonicalClaimLink.slice(canonicalClaimLink.indexOf('?'));
        expect(parsePairingDeepLink(`happier://pair${query}`)).toBeNull();
        expect(parsePairingDeepLink(`happier://relay.example.test/pair${query}`)).toBeNull();
        expect(parsePairingDeepLink(`happier:///pair/${query}`)).toBeNull();
        expect(parsePairingDeepLink(`happier:////pair${query}`)).toBeNull();
    });

    it('requires exactly ordered claim-v1 query fields', () => {
        expect(
            parsePairingDeepLink(
                `happier:///pair?claimId=${claimId}&v=claim-v1&origin=https%3A%2F%2Frelay.example.test`,
            ),
        ).toBeNull();
        expect(
            parsePairingDeepLink(
                `happier:///pair?v=claim-v1&origin=https%3A%2F%2Frelay.example.test&claimId=${claimId}`,
            ),
        ).toBeNull();
        expect(parsePairingDeepLink(`${canonicalClaimLink}&unknown=1`)).toBeNull();
        expect(parsePairingDeepLink(canonicalClaimLink.replace('v=claim-v1', 'v=claim-v1&v=claim-v1'))).toBeNull();
        expect(parsePairingDeepLink(`${canonicalClaimLink}&origin=https%3A%2F%2Frelay.example.test`)).toBeNull();
    });
});

describe('buildPairingDeepLink', () => {
    it('builds canonical deep links with encoded values', () => {
        expect(
            buildPairingDeepLink({
                pairId: 'pid123',
                secret: 'sec_abc',
                serverUrl: 'https://stack.example.test/path?x=1',
            }),
        ).toBe(
            'happier:///pair?v=1&pairId=pid123&secret=sec_abc&server=https%3A%2F%2Fstack.example.test%2Fpath%3Fx%3D1',
        );
    });

    it('builds claim-v1 without a secret or legacy pair id', () => {
        const claimId = `claim_${'b'.repeat(43)}`;
        const link = buildPairingClaimDeepLink({ claimId, origin: 'https://Relay.Example.test/' });
        expect(link).toBe(
            `happier:///pair?v=claim-v1&claimId=${claimId}&origin=https%3A%2F%2Frelay.example.test`,
        );
        expect(parsePairingDeepLink(link)).toEqual({ claimId, origin: 'https://relay.example.test' });
        const parsed = new URL(link);
        expect(parsed.searchParams.get('v')).toBe('claim-v1');
        expect(parsed.searchParams.get('claimId')).toBe(claimId);
        expect(parsed.searchParams.get('origin')).toBe('https://relay.example.test');
        expect(parsed.searchParams.has('secret')).toBe(false);
        expect(parsed.searchParams.has('pairId')).toBe(false);
    });
});
