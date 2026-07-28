import { describe, expect, it } from 'vitest';

import type { NormalizedMessage } from '../typesRaw';
import type { AgentState } from '../domains/state/storageTypes';
import { createReducer, reducer } from './reducer';

function toolRevision(params: Readonly<{
    name: string;
    input: Record<string, unknown>;
    revision: number;
}>): NormalizedMessage {
    return {
        id: 'stable-server-row-id',
        localId: 'stable-tool-local-id',
        seq: 7,
        createdAt: 1_000,
        role: 'agent',
        isSidechain: false,
        content: [{
            type: 'tool-call',
            id: 'opaque-tool-call-id',
            name: params.name,
            input: {
                ...params.input,
                _acp: { snapshotRevision: params.revision },
            },
            description: null,
            uuid: 'stable-tool-body-id',
            parentUUID: null,
        }],
    };
}

describe('transcript reducer stable tool-call revisions', () => {
    it('updates one existing card with the latest authoritative ACP input snapshot', () => {
        const state = createReducer();

        reducer(state, [toolRevision({
            name: 'other',
            input: { path: 'old.ts', staleOnly: true },
            revision: 1,
        })]);
        const messageId = state.toolIdToMessageId.get('opaque-tool-call-id');

        const update = reducer(state, [toolRevision({
            name: 'Edit',
            input: { path: 'new.ts', diff: '@@ -1 +1 @@' },
            revision: 2,
        })]);

        expect(state.messages.size).toBe(1);
        expect(state.toolIdToMessageId.get('opaque-tool-call-id')).toBe(messageId);
        expect(update.messages).toHaveLength(1);
        expect(messageId ? state.messages.get(messageId)?.tool : null).toMatchObject({
            name: 'Edit',
            input: {
                path: 'new.ts',
                diff: '@@ -1 +1 @@',
                _acp: { snapshotRevision: 2 },
            },
        });
        expect(messageId ? state.messages.get(messageId)?.tool?.input : null)
            .not.toHaveProperty('staleOnly');
    });

    it('keeps permission arguments authoritative while advancing ACP revision metadata', () => {
        const state = createReducer();
        const agentState: AgentState = {
            completedRequests: {
                'opaque-tool-call-id': {
                    tool: 'Edit',
                    arguments: { path: 'permission.ts', userApproved: true },
                    createdAt: 900,
                    completedAt: 950,
                    status: 'approved',
                },
            },
        };

        reducer(state, [toolRevision({
            name: 'Edit',
            input: { path: 'provider-old.ts' },
            revision: 1,
        })], agentState);
        const messageId = state.toolIdToMessageId.get('opaque-tool-call-id');

        const update = reducer(state, [toolRevision({
            name: 'Edit',
            input: { path: 'provider-new.ts', diff: '@@ -1 +1 @@' },
            revision: 2,
        })], agentState);

        expect(update.messages).toHaveLength(1);
        expect(messageId ? state.messages.get(messageId)?.tool?.input : null).toMatchObject({
            path: 'permission.ts',
            userApproved: true,
            _acp: { snapshotRevision: 2 },
        });
    });

    it('coalesces immutable legacy duplicate rows by call id without rewriting history', () => {
        const state = createReducer();
        const legacyRows: NormalizedMessage[] = [
            {
                id: 'legacy-row-sparse',
                localId: null,
                seq: 41,
                createdAt: 1_000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'legacy-edit-001',
                    name: 'other',
                    input: { path: 'legacy.txt' },
                    description: null,
                    uuid: 'legacy-body-sparse',
                    parentUUID: null,
                }],
            },
            {
                id: 'legacy-row-enriched',
                localId: null,
                seq: 42,
                createdAt: 1_001,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'legacy-edit-001',
                    name: 'Edit',
                    input: { path: 'legacy.txt', old_string: 'before', new_string: 'after' },
                    description: null,
                    uuid: 'legacy-body-enriched',
                    parentUUID: null,
                }],
            },
            {
                id: 'legacy-row-result',
                localId: null,
                seq: 43,
                createdAt: 1_002,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: 'legacy-edit-001',
                    content: { success: true },
                    is_error: false,
                    uuid: 'legacy-result',
                    parentUUID: null,
                }],
            },
        ];
        const immutableHistory = JSON.stringify(legacyRows);

        reducer(state, legacyRows);

        expect(JSON.stringify(legacyRows)).toBe(immutableHistory);
        expect(state.messages.size).toBe(1);
        const messageId = state.toolIdToMessageId.get('legacy-edit-001');
        expect(messageId ? state.messages.get(messageId)?.tool : null).toMatchObject({
            id: 'legacy-edit-001',
            name: 'Edit',
            input: { path: 'legacy.txt', old_string: 'before', new_string: 'after' },
            state: 'completed',
            result: { success: true },
        });
    });
});
