import { describe, expect, it, vi } from 'vitest';

import {
    createSessionDataKeyHydrationPlan,
    hydrateSessionDataKeys,
    type SessionDataKeyHydrationEncryption,
} from './sessionDataKeyHydration';

function createEncryption(): SessionDataKeyHydrationEncryption & {
    decryptEncryptionKeys: ReturnType<typeof vi.fn>;
} {
    const decryptEncryptionKeys = vi.fn(async (values: readonly string[]) =>
        values.map((value) => new Uint8Array([value.length])),
    );
    return { decryptEncryptionKeys };
}

describe('session data key hydration plan', () => {
    it('opens every encrypted row envelope in a single batch', async () => {
        const encryption = createEncryption();
        const sessionDataKeys = new Map<string, Uint8Array>();
        const sessionDataKeyEnvelopes = new Map<string, string>();
        const plan = createSessionDataKeyHydrationPlan({
            sessions: [
                { id: 'a', encryptionMode: 'e2ee', dataEncryptionKey: 'env-a' },
                { id: 'b', encryptionMode: 'e2ee', dataEncryptionKey: 'env-bb' },
                { id: 'c', encryptionMode: 'plain', dataEncryptionKey: null },
            ],
            sessionDataKeys,
            sessionDataKeyEnvelopes,
        });

        expect(plan.dataKeyDecryptCount).toBe(2);
        expect(plan.plainCount).toBe(1);

        const result = await hydrateSessionDataKeys({
            plan,
            encryption,
            sessionDataKeys,
            sessionDataKeyEnvelopes,
        });

        // One call, not one per row: a single-item batch falls under the native
        // crypto worker's minPayloadBytes and silently takes the JS path.
        expect(encryption.decryptEncryptionKeys).toHaveBeenCalledTimes(1);
        expect(encryption.decryptEncryptionKeys.mock.calls[0]?.[0]).toEqual(['env-a', 'env-bb']);
        expect(Array.from(result.sessionKeys.keys())).toEqual(['a', 'b']);
        expect(result.sessionEncryptionClears).toEqual([]);
    });

    it('reuses a cached key whose wrapped envelope is unchanged instead of reopening it', async () => {
        const encryption = createEncryption();
        const cachedKey = new Uint8Array([9]);
        const sessionDataKeys = new Map<string, Uint8Array>([['cached', cachedKey]]);
        const sessionDataKeyEnvelopes = new Map<string, string>([['cached', 'env-cached']]);
        const plan = createSessionDataKeyHydrationPlan({
            sessions: [{ id: 'cached', encryptionMode: 'e2ee', dataEncryptionKey: 'env-cached' }],
            sessionDataKeys,
            sessionDataKeyEnvelopes,
        });

        expect(plan.cachedDataKeyHits).toBe(1);
        expect(plan.dataKeyDecryptCount).toBe(0);

        const result = await hydrateSessionDataKeys({
            plan,
            encryption,
            sessionDataKeys,
            sessionDataKeyEnvelopes,
        });

        expect(encryption.decryptEncryptionKeys).not.toHaveBeenCalled();
        expect(result.sessionKeys.get('cached')).toBe(cachedKey);
        expect(result.sessionEncryptionClears).toEqual([]);
    });

    it('reopens the envelope when the wrapped key rotated, ignoring the stale cached key', async () => {
        const encryption = createEncryption();
        const sessionDataKeys = new Map<string, Uint8Array>([['rotated', new Uint8Array([9])]]);
        const sessionDataKeyEnvelopes = new Map<string, string>([['rotated', 'env-old']]);
        const plan = createSessionDataKeyHydrationPlan({
            sessions: [{ id: 'rotated', encryptionMode: 'e2ee', dataEncryptionKey: 'env-rotated' }],
            sessionDataKeys,
            sessionDataKeyEnvelopes,
        });

        expect(plan.cachedDataKeyHits).toBe(0);
        expect(plan.dataKeyDecryptCount).toBe(1);

        const result = await hydrateSessionDataKeys({
            plan,
            encryption,
            sessionDataKeys,
            sessionDataKeyEnvelopes,
        });

        expect(encryption.decryptEncryptionKeys.mock.calls[0]?.[0]).toEqual(['env-rotated']);
        expect(result.sessionKeys.get('rotated')).toEqual(new Uint8Array(['env-rotated'.length]));
        expect(sessionDataKeyEnvelopes.get('rotated')).toBe('env-rotated');
    });

    it('clears runtime encryption for an encrypted row the server stopped sending a key for', async () => {
        const encryption = createEncryption();
        const sessionDataKeys = new Map<string, Uint8Array>([['dropped', new Uint8Array([1])]]);
        const sessionDataKeyEnvelopes = new Map<string, string>([['dropped', 'env-old']]);
        const plan = createSessionDataKeyHydrationPlan({
            sessions: [{ id: 'dropped', encryptionMode: 'e2ee', dataEncryptionKey: null }],
            sessionDataKeys,
            sessionDataKeyEnvelopes,
        });

        const result = await hydrateSessionDataKeys({
            plan,
            encryption,
            sessionDataKeys,
            sessionDataKeyEnvelopes,
        });

        expect(result.sessionEncryptionClears).toEqual(['dropped']);
        expect(sessionDataKeys.has('dropped')).toBe(false);
        expect(sessionDataKeyEnvelopes.has('dropped')).toBe(false);
    });
});
