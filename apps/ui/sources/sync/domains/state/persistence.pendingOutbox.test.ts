import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, string>());

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return store.get(key);
        }

        set(key: string, value: string) {
            store.set(key, value);
        }

        delete(key: string) {
            store.delete(key);
        }

        getAllKeys() {
            return [...store.keys()];
        }

        clearAll() {
            store.clear();
        }
    }

    return { MMKV };
});

import {
    listPendingOutboxSessionIds,
    loadPendingOutbox,
    loadPendingOutboxForSession,
    markPendingOutboxMessageCancelRequested,
    removePendingOutboxMessage,
    savePendingOutboxMessage,
} from './pendingOutboxPersistence';
import { scopedSessionLocalStateKey } from './sessionLocalStateKeys';

const scope = { serverId: 'server-a', accountId: 'account-a' } as const;

function plainRequest(localId: string): { v: 1; body: string } {
    return {
        v: 1,
        body: JSON.stringify({ localId, content: { t: 'plain', v: {} }, messageRole: 'user' }),
    };
}

describe('pending outbox persistence', () => {
    beforeEach(() => {
        store.clear();
    });

    it('round-trips a persisted outbox message keyed by session and localId', () => {
        savePendingOutboxMessage({
            sessionId: 's1',
            localId: 'local-1',
            createdAt: 100,
            text: 'hello',
            displayText: 'hello!',
            rawRecord: { role: 'user', content: { type: 'text', text: 'hello' } },
            request: plainRequest('local-1'),
        }, scope);

        expect(loadPendingOutboxForSession('s1', scope)).toEqual([
            {
                sessionId: 's1',
                localId: 'local-1',
                createdAt: 100,
                text: 'hello',
                displayText: 'hello!',
                rawRecord: { role: 'user', content: { type: 'text', text: 'hello' } },
                operation: 'enqueue',
                request: plainRequest('local-1'),
            },
        ]);
    });

    it('enumerates only the session ids with durable custody in the requested server-account scope', () => {
        const otherScope = { serverId: scope.serverId, accountId: 'account-b' } as const;
        savePendingOutboxMessage({
            sessionId: 'session-b',
            localId: 'local-b',
            createdAt: 101,
            text: 'second',
            rawRecord: { role: 'user' },
            request: plainRequest('local-b'),
        }, scope);
        savePendingOutboxMessage({
            sessionId: 'session-a',
            localId: 'local-a',
            createdAt: 100,
            text: 'first',
            rawRecord: { role: 'user' },
            request: plainRequest('local-a'),
        }, scope);
        savePendingOutboxMessage({
            sessionId: 'other-account-session',
            localId: 'other-local',
            createdAt: 102,
            text: 'other account',
            rawRecord: { role: 'user' },
            request: plainRequest('other-local'),
        }, otherScope);

        expect(listPendingOutboxSessionIds(scope)).toEqual(['session-a', 'session-b']);
        expect(listPendingOutboxSessionIds(otherScope)).toEqual(['other-account-session']);
    });

    it('durably changes an ambiguous enqueue into a cancellation without replacing its request envelope', () => {
        const original = savePendingOutboxMessage({
            sessionId: 's1',
            localId: 'cancel-me',
            createdAt: 100,
            text: 'hello',
            rawRecord: { role: 'user', content: { type: 'text', text: 'hello' } },
            request: plainRequest('cancel-me'),
        }, scope);

        expect(markPendingOutboxMessageCancelRequested('s1', 'cancel-me', scope)).toEqual({
            ...original,
            operation: 'cancel',
        });
        expect(loadPendingOutboxForSession('s1', scope)).toEqual([
            expect.objectContaining({
                localId: 'cancel-me',
                operation: 'cancel',
                request: original.request,
            }),
        ]);
    });

    it('keeps the first immutable request envelope for a localId rather than replacing it', () => {
        savePendingOutboxMessage({ sessionId: 's1', localId: 'a', createdAt: 1, text: 'v1', rawRecord: { role: 'user' }, request: plainRequest('a') }, scope);
        savePendingOutboxMessage({ sessionId: 's1', localId: 'a', createdAt: 2, text: 'v2', rawRecord: { role: 'user' }, request: plainRequest('a') }, scope);
        const rows = loadPendingOutboxForSession('s1', scope);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.text).toBe('v1');
    });

    it('clears a confirmed message and deletes the key when empty', () => {
        savePendingOutboxMessage({ sessionId: 's1', localId: 'a', createdAt: 1, text: 'x', rawRecord: { role: 'user' }, request: plainRequest('a') }, scope);
        removePendingOutboxMessage('s1', 'a', scope);
        expect(loadPendingOutboxForSession('s1', scope)).toEqual([]);
        expect(loadPendingOutbox(scope)).toEqual({});
    });

    it('quarantines identifiable non-executable persisted rows while dropping rows without a stable identity', () => {
        store.set(scopedSessionLocalStateKey('session-pending-outbox-v1', scope), JSON.stringify({
            s1: [
                { localId: 'ok', createdAt: 1, text: 'good', rawRecord: { role: 'user' }, request: plainRequest('ok') },
                { localId: 'unknown-operation', createdAt: 1, text: 'must not replay', rawRecord: { role: 'user' }, operation: 'replace', request: plainRequest('unknown-operation') },
                {
                    localId: 'invalid-envelope', createdAt: 1, text: 'must not replay', rawRecord: { role: 'user' },
                    request: {
                        v: 1,
                        body: JSON.stringify({ localId: 'invalid-envelope', content: {}, messageRole: 'user' }),
                    },
                },
                { localId: '', createdAt: 1, text: 'no id', rawRecord: { role: 'user' }, request: plainRequest('') },
                { localId: 'no-raw', createdAt: 1, text: 'missing raw', request: plainRequest('no-raw') },
                {
                    localId: 'invalid-created-at', createdAt: 'yesterday', text: 'created-at fallback',
                    rawRecord: { role: 'user' }, request: plainRequest('invalid-created-at'),
                },
                {
                    localId: 'invalid-text', createdAt: 7, operation: 'cancel',
                    rawRecord: { role: 'user' }, request: plainRequest('invalid-text'),
                },
                {
                    localId: 'missing-request', createdAt: 8, text: 'missing request',
                    rawRecord: { role: 'user' },
                },
            ],
        }));
        expect(loadPendingOutboxForSession('s1', scope)).toEqual([
            expect.objectContaining({ localId: 'ok', operation: 'enqueue' }),
            expect.objectContaining({
                localId: 'unknown-operation',
                operation: 'quarantined',
                pendingOutboxQuarantineReason: 'unsupported_persisted_operation',
            }),
            expect.objectContaining({
                localId: 'invalid-envelope',
                operation: 'quarantined',
                pendingOutboxQuarantineReason: 'invalid_persisted_envelope',
            }),
            expect.objectContaining({
                localId: 'no-raw',
                operation: 'enqueue',
                rawRecord: undefined,
            }),
            expect.objectContaining({
                localId: 'invalid-created-at',
                createdAt: 0,
                text: 'created-at fallback',
                operation: 'enqueue',
            }),
            expect.objectContaining({
                localId: 'invalid-text',
                createdAt: 7,
                text: '',
                operation: 'cancel',
            }),
            expect.objectContaining({
                localId: 'missing-request',
                request: { v: 1, body: '' },
                operation: 'quarantined',
                pendingOutboxQuarantineReason: 'invalid_persisted_envelope',
            }),
        ]);

        savePendingOutboxMessage({
            sessionId: 's1', localId: 'later-write', createdAt: 2, text: 'later',
            rawRecord: { role: 'user' }, request: plainRequest('later-write'),
        }, scope);
        expect(loadPendingOutboxForSession('s1', scope)).toEqual(expect.arrayContaining([
            expect.objectContaining({
                localId: 'unknown-operation',
                operation: 'quarantined',
                pendingOutboxQuarantineReason: 'unsupported_persisted_operation',
            }),
            expect.objectContaining({
                localId: 'no-raw',
                operation: 'enqueue',
                rawRecord: undefined,
            }),
            expect.objectContaining({
                localId: 'invalid-created-at',
                createdAt: 0,
                operation: 'enqueue',
            }),
            expect.objectContaining({ localId: 'later-write', operation: 'enqueue' }),
        ]));
    });

    it.each([
        ['object without an envelope tag', { content: {} }],
        ['nested encrypted content', { content: { t: 'encrypted', c: 'nested-ciphertext' } }],
        ['top-level ciphertext plus malformed content', { ciphertext: 'top-level-ciphertext', content: {} }],
    ] as const)('rejects a new outbox row with %s', (_case, invalidContent) => {
        expect(() => savePendingOutboxMessage({
            sessionId: 's1',
            localId: 'invalid-envelope',
            createdAt: 1,
            text: 'must not persist',
            rawRecord: { role: 'user' },
            request: {
                v: 1,
                body: JSON.stringify({ localId: 'invalid-envelope', ...invalidContent, messageRole: 'user' }),
            },
        }, scope)).toThrow('Pending outbox request envelope is invalid');
        expect(loadPendingOutboxForSession('s1', scope)).toEqual([]);
    });

    it('fails closed for persisted dot path IDs on save and load', () => {
        expect(() => savePendingOutboxMessage({
            sessionId: 's1',
            localId: '.',
            createdAt: 1,
            text: 'unsafe',
            rawRecord: { role: 'user' },
            request: plainRequest('.'),
        }, scope)).toThrow('Pending message ID cannot be a dot path segment');

        store.set(scopedSessionLocalStateKey('session-pending-outbox-v1', scope), JSON.stringify({
            s1: [{
                localId: '..',
                createdAt: 1,
                text: 'unsafe',
                rawRecord: { role: 'user' },
                request: plainRequest('..'),
            }],
        }));
        expect(loadPendingOutboxForSession('s1', scope)).toEqual([
            expect.objectContaining({
                localId: '..',
                operation: 'quarantined',
                pendingOutboxQuarantineReason: 'invalid_persisted_local_id',
            }),
        ]);

        savePendingOutboxMessage({
            sessionId: 's1', localId: 'safe', createdAt: 2, text: 'safe',
            rawRecord: { role: 'user' }, request: plainRequest('safe'),
        }, scope);
        expect(loadPendingOutboxForSession('s1', scope)).toEqual(expect.arrayContaining([
            expect.objectContaining({
                localId: '..',
                operation: 'quarantined',
                pendingOutboxQuarantineReason: 'invalid_persisted_local_id',
            }),
            expect.objectContaining({ localId: 'safe', operation: 'enqueue' }),
        ]));
    });

});
