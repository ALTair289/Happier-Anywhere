import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Encryption } from '@/sync/encryption/encryption';
import { settingsParse } from '@/sync/domains/settings/settings';
import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';

import { deletePendingMessageV2, enqueuePendingMessageV2 } from './pendingQueueV2';
import { buildSession, createPendingQueueEncryption, resetPendingQueueState } from './pendingQueueV2.testHelpers';

describe('pendingQueueV2 optimistic thinking', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        resetPendingQueueState();
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('keeps optimistic thinking and marks the pending row accepted after successful enqueue', async () => {
        const sessionId = 's_test';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 7 });

        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();

        const result = await enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            request: async () => new Response(null, { status: 200 }),
        });

        expect(result).toEqual({
            localId: expect.any(String),
            accepted: true,
        });
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).not.toBeNull();
        expect(storage.getState().sessionPending[sessionId]?.messages[0]?.deliveryStatus).toBe('accepted');
    });

    it('marks encrypted pending enqueue payloads as user messages', async () => {
        const sessionId = 's_test_encrypted_message_role';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 7 });

        const bodies: unknown[] = [];
        await enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            request: async (_path, init) => {
                bodies.push(JSON.parse(String(init?.body ?? 'null')));
                return new Response(null, { status: 200 });
            },
        });

        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toEqual(expect.objectContaining({
            ciphertext: expect.any(String),
            messageRole: 'user',
        }));
    });

    it('keeps a newly enqueued pending row in queued delivery state until the server accepts it', async () => {
        const sessionId = 's_test_delivery_state';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 7 });

        let acceptRequest!: () => void;
        const requestGate = new Promise<void>((resolve) => {
            acceptRequest = resolve;
        });

        const promise = enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            request: async () => {
                await requestGate;
                return new Response(null, { status: 200 });
            },
        });

        expect(storage.getState().sessionPending[sessionId]?.messages[0]?.deliveryStatus).toBe('queued');

        acceptRequest();
        await promise;

        expect(storage.getState().sessionPending[sessionId]?.messages[0]?.deliveryStatus).toBe('accepted');
    });

    it('notifies when the local pending row is projected before the server accepts it', async () => {
        const sessionId = 's_test_local_projection_callback';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 7 });
        const projections: Array<{ localId: string; status: unknown }> = [];

        let acceptRequest!: () => void;
        const requestGate = new Promise<void>((resolve) => {
            acceptRequest = resolve;
        });

        const promise = enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            request: async () => {
                await requestGate;
                return new Response(null, { status: 200 });
            },
            onLocalPendingProjectionCreated: ({ localId }) => {
                projections.push({
                    localId,
                    status: storage.getState().sessionPending[sessionId]?.messages[0]?.deliveryStatus,
                });
            },
        });

        expect(projections).toEqual([{
            localId: expect.any(String),
            status: 'queued',
        }]);

        acceptRequest();
        await promise;

        expect(projections).toHaveLength(1);
        expect(storage.getState().sessionPending[sessionId]?.messages[0]?.deliveryStatus).toBe('accepted');
    });

    it('does not recreate a deleted local pending row when the in-flight enqueue later resolves', async () => {
        const sessionId = 's_test_delete_during_enqueue';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 13 });

        let postStarted!: () => void;
        const postStartedGate = new Promise<void>((resolve) => {
            postStarted = resolve;
        });
        let releaseRequest!: () => void;
        const requestGate = new Promise<void>((resolve) => {
            releaseRequest = resolve;
        });
        const requestCalls: Array<{ path: string; method: string | undefined }> = [];
        const request = async (path: string, init?: RequestInit) => {
            requestCalls.push({ path, method: init?.method });
            if (init?.method === 'POST') {
                postStarted();
                await requestGate;
            }
            return new Response(null, { status: 200 });
        };

        const enqueuePromise = enqueuePendingMessageV2({
            sessionId,
            text: 'delete me',
            encryption,
            request,
        });

        const localId = storage.getState().sessionPending[sessionId]?.messages[0]?.localId;
        expect(localId).toEqual(expect.any(String));

        await postStartedGate;

        await deletePendingMessageV2({
            sessionId,
            pendingId: localId!,
            request,
        });

        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);

        releaseRequest();
        await expect(enqueuePromise).resolves.toEqual({
            localId,
            accepted: true,
        });

        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
        expect(requestCalls).toEqual([
            { path: `/v2/sessions/${sessionId}/pending`, method: 'POST' },
            { path: `/v2/sessions/${sessionId}/pending/${localId}`, method: 'DELETE' },
        ]);
    });

    it('keeps queued pending messages in call order even when earlier encryption resolves later', async () => {
        const sessionId = 's_test_enqueue_order';
        storage.getState().applySessions([buildSession({ sessionId })]);

        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = () => resolve();
        });

        const requestCiphertexts: string[] = [];
        const encryption = {
            getSessionEncryption: () =>
                ({
                    encryptRawRecord: async (rawRecord: any) => {
                        const text = rawRecord?.content?.text;
                        if (text === 'first') {
                            await firstGate;
                        }
                        return `cipher-${String(text)}`;
                    },
                }) as unknown as ReturnType<Encryption['getSessionEncryption']>,
        } as unknown as Encryption;

        const request = async (_path: string, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body ?? 'null')) as any;
            requestCiphertexts.push(String(body?.ciphertext ?? ''));
            return new Response(null, { status: 200 });
        };

        const promiseFirst = enqueuePendingMessageV2({
            sessionId,
            text: 'first',
            encryption,
            request,
        });
        const promiseSecond = enqueuePendingMessageV2({
            sessionId,
            text: 'second',
            encryption,
            request,
        });

        releaseFirst();

        await Promise.all([promiseFirst, promiseSecond]);

        const pending = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(pending.map((m) => m.text)).toEqual(['first', 'second']);
        expect(requestCiphertexts).toEqual(['cipher-first', 'cipher-second']);
    });

    it('clears optimistic thinking when encryption fails', async () => {
        const sessionId = 's_test_encrypt_fail';
        storage.getState().applySessions([buildSession({ sessionId })]);

        const encryption = {
            getSessionEncryption: () =>
                ({
                    encryptRawRecord: async () => {
                        throw new Error('encrypt-failed');
                    },
                }) as unknown as ReturnType<Encryption['getSessionEncryption']>,
        } as unknown as Encryption;

        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();

        const promise = enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            request: async () => new Response(null, { status: 200 }),
        }).catch(() => null);

        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).not.toBeNull();

        await promise;

        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
    });

    it('includes provider-specific message meta extras for queued sends', async () => {
        const sessionId = 's_test_provider_meta';
        storage.getState().applySessions([
            {
                ...buildSession({ sessionId }),
                metadata: { path: '/tmp', host: 'h', flavor: 'claude' } as Session['metadata'],
            },
        ]);
        storage.setState(
            {
                ...storage.getState(),
                settings: settingsParse({
                    claudeRemoteAgentSdkEnabled: true,
                    claudeRemoteSettingSourcesV2: ['project'],
                }),
            },
            true,
        );

        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 7 });

        await enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            request: async () => new Response(null, { status: 200 }),
        });

        const pending = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(pending.length).toBe(1);
        const metadata = pending[0]?.rawRecord?.meta as Record<string, unknown> | undefined;
        expect(metadata?.claudeRemoteAgentSdkEnabled).toBe(true);
        expect(metadata?.claudeRemoteSettingSources).toBe('project');
        expect(metadata?.claudeRemoteSettingSourcesV2).toEqual(['project']);
    });

    it('includes metaOverrides (e.g. meta.happier) for queued sends', async () => {
        const sessionId = 's_test_meta_overrides';
        storage.getState().applySessions([buildSession({ sessionId })]);

        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 7 });

        await enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            metaOverrides: {
                happier: {
                    kind: 'review_comments.v1',
                    payload: { sessionId, comments: [] },
                },
            },
            request: async () => new Response(null, { status: 200 }),
        });

        const pending = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(pending.length).toBe(1);
        const metadata = pending[0]?.rawRecord?.meta as Record<string, unknown> | undefined;
        expect((metadata as any)?.happier?.kind).toBe('review_comments.v1');
    });

    it('removes queued pending message and clears optimistic thinking when enqueue request fails', async () => {
        const sessionId = 's_test_request_fail';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 8 });

        await expect(
            enqueuePendingMessageV2({
                sessionId,
                text: 'hello',
                encryption,
                request: async () => new Response(null, { status: 500 }),
            }),
        ).rejects.toThrow('Failed to enqueue pending message (500)');

        const pendingState = storage.getState().sessionPending[sessionId];
        expect(pendingState?.messages ?? []).toEqual([]);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
    });

    it.each([401, 403] as const)('surfaces enqueue auth status %s as not_authenticated', async (status) => {
        const sessionId = `s_test_request_auth_${status}`;
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 8 });

        await expect(
            enqueuePendingMessageV2({
                sessionId,
                text: 'hello',
                encryption,
                request: async () => new Response(null, { status }),
            }),
        ).rejects.toMatchObject({
            name: 'HappyError',
            canTryAgain: false,
            kind: 'auth',
            code: 'not_authenticated',
            status,
        });

        const pendingState = storage.getState().sessionPending[sessionId];
        expect(pendingState?.messages ?? []).toEqual([]);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
    });

    it('sends plaintext pending payloads when session encryptionMode is plain', async () => {
        const sessionId = 's_test_plain_send';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 8 });

        const bodies: unknown[] = [];
        await enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            request: async (_path, init) => {
                bodies.push(JSON.parse(String(init?.body ?? 'null')));
                return new Response(null, { status: 200 });
            },
        });

        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toEqual(
            expect.objectContaining({
                localId: expect.any(String),
                content: expect.objectContaining({ t: 'plain', v: expect.any(Object) }),
                messageRole: 'user',
            }),
        );
        expect(bodies[0]).not.toEqual(expect.objectContaining({ ciphertext: expect.anything() }));
    });

    it('does not require a session encryption key when session encryptionMode is plain', async () => {
        const sessionId = 's_test_plain_send_no_key';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);

        const bodies: unknown[] = [];
        const encryptionWithoutSessionKey = {
            getSessionEncryption: () => null,
        } as unknown as Encryption;
        await enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption: encryptionWithoutSessionKey,
            request: async (_path, init) => {
                bodies.push(JSON.parse(String(init?.body ?? 'null')));
                return new Response(null, { status: 200 });
            },
        });

        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toEqual(
            expect.objectContaining({
                localId: expect.any(String),
                content: expect.objectContaining({ t: 'plain', v: expect.any(Object) }),
                messageRole: 'user',
            }),
        );
        expect(bodies[0]).not.toEqual(expect.objectContaining({ ciphertext: expect.anything() }));
    });
});
