import { describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';

import { createConnectedServiceOauthExchangeKeyPair } from './createConnectedServiceOauthExchangeKeyPair';

describe('createConnectedServiceOauthExchangeKeyPair', () => {
    it('derives the exchange keypair from the platform secure-random bytes without TweetNaCl global PRNG state', () => {
        const secretKey = new Uint8Array(tweetnacl.box.secretKeyLength).fill(7);
        const randomBytes = vi.fn(() => secretKey);

        const keyPair = createConnectedServiceOauthExchangeKeyPair(randomBytes);

        expect(randomBytes).toHaveBeenCalledWith(tweetnacl.box.secretKeyLength);
        expect(keyPair.secretKey).toEqual(secretKey);
        expect(keyPair.publicKey).toEqual(tweetnacl.box.keyPair.fromSecretKey(secretKey).publicKey);
    });

    it('rejects a malformed random-byte result at the owner boundary', () => {
        expect(() => createConnectedServiceOauthExchangeKeyPair(() => new Uint8Array(2)))
            .toThrow('Invalid Connected Services OAuth exchange secret-key length');
    });
});
