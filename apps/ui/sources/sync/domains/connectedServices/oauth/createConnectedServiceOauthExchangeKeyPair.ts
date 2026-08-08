import tweetnacl from 'tweetnacl';

import { getRandomBytes } from '@/platform/cryptoRandom';

type SecureRandomBytes = (length: number) => Uint8Array;

/**
 * Creates the short-lived recipient keypair used by Connected Services OAuth exchanges.
 *
 * TweetNaCl's ambient PRNG is not configured by Hermes. Keep randomness owned by the existing
 * Expo-backed platform adapter, then use TweetNaCl only for deterministic public-key derivation.
 */
export function createConnectedServiceOauthExchangeKeyPair(
    randomBytes: SecureRandomBytes = getRandomBytes,
): tweetnacl.BoxKeyPair {
    const secretKey = randomBytes(tweetnacl.box.secretKeyLength);
    if (secretKey.length !== tweetnacl.box.secretKeyLength) {
        throw new Error('Invalid Connected Services OAuth exchange secret-key length');
    }
    return tweetnacl.box.keyPair.fromSecretKey(secretKey);
}
