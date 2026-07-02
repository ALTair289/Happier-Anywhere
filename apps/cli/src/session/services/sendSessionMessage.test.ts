import { afterEach, describe, expect, it, vi } from 'vitest';

describe('sendSessionMessage', () => {
    afterEach(() => {
        vi.doUnmock('@/api/session/pendingQueueV2Transport');
        vi.resetModules();
        vi.clearAllMocks();
    });

    type SendWaitRowsOptions = Readonly<{
        limit100RowsByCall?: readonly (readonly unknown[])[];
        sessionSnapshot?: Record<string, unknown>;
    }>;

    async function sendAndWaitForRowsAfterCurrentUser(
        rowsAfterUser: readonly unknown[],
        options: SendWaitRowsOptions = {},
    ) {
        const userMessageRow = {
            id: 'msg-user',
            localId: 'local-user',
            seq: 7,
            createdAt: 100,
            updatedAt: 100,
            content: { t: 'plain' as const, v: { role: 'user' } },
        };
        let limit100CallCount = 0;
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async (request: Readonly<{ limit?: number }>) => {
            if (request.limit === 100) {
                const scriptedRows = options.limit100RowsByCall;
                const selectedRows = scriptedRows && scriptedRows.length > 0
                    ? scriptedRows[Math.min(limit100CallCount, scriptedRows.length - 1)]
                    : rowsAfterUser;
                limit100CallCount += 1;
                return [
                    userMessageRow,
                    ...(selectedRows ?? []).map((value, index) => ({
                        id: `msg-after-${index + 1}`,
                        localId: null,
                        seq: 8 + index,
                        createdAt: 101 + index,
                        updatedAt: 101 + index,
                        content: { t: 'plain' as const, v: value },
                    })),
                ];
            }
            return [userMessageRow];
        });
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => []);
        const waitForTranscriptEncryptedMessageByLocalId = vi.fn(async () => userMessageRow);
        const defaultSessionSnapshot = {
            id: 'sess-1',
            active: true,
            agentState: null,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 99,
            lastRuntimeIssue: null,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
        };
        const fetchSessionById = vi.fn(async () => ({
            ...defaultSessionSnapshot,
            ...(options.sessionSnapshot ?? {}),
        }));
        const callSessionRpc = vi.fn(async () => ({ ok: true }));
        const waitForIdleViaSocket = vi.fn(async () => ({ idle: true as const, observedAt: 456 }));

        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageAfterSeq,
            fetchEncryptedTranscriptPageLatest,
        }));
        vi.doMock('@/api/session/transcriptMessageLookup', () => ({
            waitForTranscriptEncryptedMessageByLocalId,
        }));
        vi.doMock('@/session/transport/http/sessionsHttp', () => ({
            fetchSessionById,
        }));
        vi.doMock('@/session/transport/rpc/sessionRpc', () => ({
            callSessionRpc,
        }));
        vi.doMock('@/session/transport/socket/sessionSocketSendMessage', () => ({
            sendSessionMessageViaSocketCommitted: vi.fn(async () => undefined),
        }));
        vi.doMock('@/session/transport/socket/sessionSocketAgentState', () => ({
            waitForIdleViaSocket,
        }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey' },
                rawSession: {
                    id: 'sess-1',
                    active: true,
                    metadata: '{}',
                    agentState: null,
                    latestTurnStatus: 'completed',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            })),
        }));

        const { sendSessionMessage } = await import('./sendSessionMessage');
        const machineKey = new Uint8Array(32).fill(1);

        const result = await sendSessionMessage({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-1',
            message: 'hello',
            wait: true,
            timeoutMs: 50,
            localId: 'local-user',
        });

        return {
            result,
            fetchEncryptedTranscriptPageAfterSeq,
            waitForIdleViaSocket,
        };
    }

    function rawLifecycle(type: string, issue?: Record<string, unknown>) {
        return {
            role: 'agent',
            content: {
                type: 'acp',
                data: { type, id: 'turn-1', ...(issue ? { issue } : {}) },
            },
        };
    }

    function rawEventLifecycle(type: string) {
        return {
            role: 'event',
            content: {
                type: 'event',
                data: { type, id: 'turn-1' },
            },
        };
    }

    function rawAcpMessage(message: string) {
        return {
            role: 'agent',
            content: {
                type: 'acp',
                provider: 'pi',
                data: { type: 'message', message },
            },
        };
    }

    function rawRuntimeIssueMessage(message: string) {
        return {
            role: 'agent',
            content: {
                type: 'acp',
                provider: 'claude',
                data: { type: 'message', message },
            },
            meta: {
                sentFrom: 'cli',
                source: 'runtime',
                runtimeIssueCode: 'claude_authentication_failed',
                runtimeIssueSource: 'auth_error',
                runtimeIssueProvider: 'claude',
            },
        };
    }

    function rawClaudeOutput(params: Readonly<{
        content: readonly unknown[];
        stopReason?: string;
    }>) {
        return {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    message: {
                        role: 'assistant',
                        content: params.content,
                        ...(params.stopReason ? { stop_reason: params.stopReason } : {}),
                    },
                },
            },
        };
    }

    it('uses transcript scan after materialized send when refreshed projection is idle', async () => {
        const userMessageRow = {
            id: 'msg-user',
            localId: 'local-user',
            seq: 7,
            createdAt: 100,
            updatedAt: 100,
            content: { t: 'plain' as const, v: { role: 'user' } },
        };
        const assistantMessageRow = {
            id: 'msg-agent',
            localId: null,
            seq: 8,
            createdAt: 101,
            updatedAt: 101,
            content: { t: 'plain' as const, v: { role: 'agent', content: { type: 'text', text: 'done' } } },
        };
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn()
            .mockResolvedValueOnce([userMessageRow])
            .mockResolvedValueOnce([userMessageRow])
            .mockResolvedValue([userMessageRow, assistantMessageRow]);
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => []);
        const waitForTranscriptEncryptedMessageByLocalId = vi.fn(async () => ({ seq: 7 }));
        const fetchSessionById = vi.fn(async () => ({
            id: 'sess-1',
            active: true,
            agentState: '{"requests":{"stale":{"createdAt":1}}}',
            latestTurnStatus: 'completed',
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
        }));
        const callSessionRpc = vi.fn(async () => ({ ok: true }));
        const waitForIdleViaSocket = vi.fn(async () => ({ idle: true as const, observedAt: 456 }));

        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageAfterSeq,
            fetchEncryptedTranscriptPageLatest,
        }));
        vi.doMock('@/api/session/transcriptMessageLookup', () => ({
            waitForTranscriptEncryptedMessageByLocalId,
        }));
        vi.doMock('@/session/transport/http/sessionsHttp', () => ({
            fetchSessionById,
        }));
        vi.doMock('@/session/transport/rpc/sessionRpc', () => ({
            callSessionRpc,
        }));
        vi.doMock('@/session/transport/socket/sessionSocketSendMessage', () => ({
            sendSessionMessageViaSocketCommitted: vi.fn(async () => undefined),
        }));
        vi.doMock('@/session/transport/socket/sessionSocketAgentState', () => ({
            waitForIdleViaSocket,
        }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey' },
                rawSession: {
                    id: 'sess-1',
                    active: true,
                    metadata: '{}',
                    agentState: null,
                    latestTurnStatus: 'in_progress',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            })),
        }));

        const { sendSessionMessage } = await import('./sendSessionMessage');
        const machineKey = new Uint8Array(32).fill(1);

        await expect(sendSessionMessage({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-1',
            message: 'hello',
            wait: true,
            timeoutMs: 1_000,
        })).resolves.toEqual(expect.objectContaining({
            ok: true,
            sessionId: 'sess-1',
            waited: true,
        }));

        expect(waitForIdleViaSocket).toHaveBeenCalledWith(expect.objectContaining({
            initialTurnActivity: {
                pendingUserTurns: 1,
                activeTaskInFlight: false,
                turnInFlight: true,
            },
        }));
        expect(waitForIdleViaSocket).not.toHaveBeenCalledWith(expect.objectContaining({
            preferProjectionUpdates: true,
        }));
        expect(fetchEncryptedTranscriptPageAfterSeq).toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageLatest).not.toHaveBeenCalled();
    });

    it('does not report waited success when socket idle has no assistant activity after the current user turn', async () => {
        const userMessageRow = {
            id: 'msg-user',
            localId: 'local-user',
            seq: 7,
            createdAt: 100,
            updatedAt: 100,
            content: { t: 'plain' as const, v: { role: 'user' } },
        };
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => [userMessageRow]);
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => []);
        const waitForTranscriptEncryptedMessageByLocalId = vi.fn(async () => ({ seq: 7 }));
        const fetchSessionById = vi.fn(async () => ({
            id: 'sess-1',
            active: true,
            agentState: null,
            latestTurnStatus: 'completed',
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
        }));
        const callSessionRpc = vi.fn(async () => ({ ok: true }));
        const waitForIdleViaSocket = vi.fn(async () => ({ idle: true as const, observedAt: 456 }));

        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageAfterSeq,
            fetchEncryptedTranscriptPageLatest,
        }));
        vi.doMock('@/api/session/transcriptMessageLookup', () => ({
            waitForTranscriptEncryptedMessageByLocalId,
        }));
        vi.doMock('@/session/transport/http/sessionsHttp', () => ({
            fetchSessionById,
        }));
        vi.doMock('@/session/transport/rpc/sessionRpc', () => ({
            callSessionRpc,
        }));
        vi.doMock('@/session/transport/socket/sessionSocketSendMessage', () => ({
            sendSessionMessageViaSocketCommitted: vi.fn(async () => undefined),
        }));
        vi.doMock('@/session/transport/socket/sessionSocketAgentState', () => ({
            waitForIdleViaSocket,
        }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey' },
                rawSession: {
                    id: 'sess-1',
                    active: true,
                    metadata: '{}',
                    agentState: null,
                    latestTurnStatus: 'completed',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            })),
        }));

        const { sendSessionMessage } = await import('./sendSessionMessage');
        const machineKey = new Uint8Array(32).fill(1);

        await expect(sendSessionMessage({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-1',
            message: 'hello',
            wait: true,
            timeoutMs: 50,
            localId: 'local-user',
        })).resolves.toEqual({
            ok: false,
            code: 'timeout',
        });

        expect(waitForIdleViaSocket).toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).toHaveBeenCalled();
    });

    it('returns wait_failed when the current prompt delivery is blocked before transcript materialization', async () => {
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => []);
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => []);
        const waitForTranscriptEncryptedMessageByLocalId = vi.fn(async (_params: Readonly<{ maxWaitMs: number }>) => null);
        const readBlockedPendingQueueV2DeliveryByLocalIdFromServer = vi.fn(async () => ({
            localId: 'local-user',
            reason: 'runtime_disposed_before_delivery' as const,
        }));
        const fetchSessionById = vi.fn(async () => ({
            id: 'sess-1',
            active: true,
            agentState: null,
            latestTurnStatus: 'completed',
            pendingCount: 1,
            pendingBlockedCount: 1,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
        }));
        const callSessionRpc = vi.fn(async () => ({ ok: true }));
        const waitForIdleViaSocket = vi.fn(async () => ({ idle: true as const, observedAt: 456 }));

        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageAfterSeq,
            fetchEncryptedTranscriptPageLatest,
        }));
        vi.doMock('@/api/session/transcriptMessageLookup', () => ({
            waitForTranscriptEncryptedMessageByLocalId,
        }));
        vi.doMock('@/api/session/pendingQueueV2Transport', () => ({
            materializeNextPendingQueueV2MessageViaHttp: vi.fn(async () => ({
                didMaterialize: false,
                localId: null,
                didWrite: false,
            })),
            readBlockedPendingQueueV2DeliveryByLocalIdFromServer,
        }));
        vi.doMock('@/session/transport/http/sessionsHttp', () => ({
            fetchSessionById,
        }));
        vi.doMock('@/session/transport/rpc/sessionRpc', () => ({
            callSessionRpc,
        }));
        vi.doMock('@/session/transport/socket/sessionSocketSendMessage', () => ({
            sendSessionMessageViaSocketCommitted: vi.fn(async () => undefined),
        }));
        vi.doMock('@/session/transport/socket/sessionSocketAgentState', () => ({
            waitForIdleViaSocket,
        }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey' },
                rawSession: {
                    id: 'sess-1',
                    active: true,
                    metadata: '{}',
                    agentState: null,
                    latestTurnStatus: 'completed',
                    pendingCount: 1,
                    pendingBlockedCount: 1,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            })),
        }));

        const { sendSessionMessage } = await import('./sendSessionMessage');
        const machineKey = new Uint8Array(32).fill(1);

        await expect(sendSessionMessage({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-1',
            message: 'hello',
            wait: true,
            timeoutMs: 10_000,
            localId: 'local-user',
        })).resolves.toEqual({
            ok: false,
            code: 'wait_failed',
            message: expect.stringContaining('runtime_disposed_before_delivery'),
        });

        expect(waitForTranscriptEncryptedMessageByLocalId).toHaveBeenCalledWith(expect.objectContaining({
            maxWaitMs: expect.any(Number),
        }));
        expect(waitForTranscriptEncryptedMessageByLocalId.mock.calls[0]?.[0]?.maxWaitMs).toBeLessThanOrEqual(250);
        expect(readBlockedPendingQueueV2DeliveryByLocalIdFromServer).toHaveBeenCalledWith(expect.objectContaining({
            token: 'token',
            sessionId: 'sess-1',
            localId: 'local-user',
        }));
        expect(waitForIdleViaSocket).not.toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).not.toHaveBeenCalled();
    });

    it('does not report waited success when socket idle only observed a bare ready event after the current user turn', async () => {
        const userMessageRow = {
            id: 'msg-user',
            localId: 'local-user',
            seq: 7,
            createdAt: 100,
            updatedAt: 100,
            content: { t: 'plain' as const, v: { role: 'user' } },
        };
        const bareReadyRow = {
            id: 'msg-ready',
            localId: null,
            seq: 8,
            createdAt: 101,
            updatedAt: 101,
            content: { t: 'plain' as const, v: { role: 'agent', content: { type: 'event', data: { type: 'ready' } } } },
        };
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async (request: Readonly<{ limit?: number }>) => {
            if (request.limit === 100) {
                return [userMessageRow, bareReadyRow];
            }
            return [userMessageRow];
        });
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => []);
        const waitForTranscriptEncryptedMessageByLocalId = vi.fn(async () => ({ seq: 7 }));
        const fetchSessionById = vi.fn(async () => ({
            id: 'sess-1',
            active: true,
            agentState: null,
            latestTurnStatus: 'completed',
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
        }));
        const callSessionRpc = vi.fn(async () => ({ ok: true }));
        const waitForIdleViaSocket = vi.fn(async () => ({ idle: true as const, observedAt: 456 }));

        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageAfterSeq,
            fetchEncryptedTranscriptPageLatest,
        }));
        vi.doMock('@/api/session/transcriptMessageLookup', () => ({
            waitForTranscriptEncryptedMessageByLocalId,
        }));
        vi.doMock('@/session/transport/http/sessionsHttp', () => ({
            fetchSessionById,
        }));
        vi.doMock('@/session/transport/rpc/sessionRpc', () => ({
            callSessionRpc,
        }));
        vi.doMock('@/session/transport/socket/sessionSocketSendMessage', () => ({
            sendSessionMessageViaSocketCommitted: vi.fn(async () => undefined),
        }));
        vi.doMock('@/session/transport/socket/sessionSocketAgentState', () => ({
            waitForIdleViaSocket,
        }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey' },
                rawSession: {
                    id: 'sess-1',
                    active: true,
                    metadata: '{}',
                    agentState: null,
                    latestTurnStatus: 'completed',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            })),
        }));

        const { sendSessionMessage } = await import('./sendSessionMessage');
        const machineKey = new Uint8Array(32).fill(1);

        await expect(sendSessionMessage({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-1',
            message: 'hello',
            wait: true,
            timeoutMs: 50,
            localId: 'local-user',
        })).resolves.toEqual({
            ok: false,
            code: 'timeout',
        });

        expect(waitForIdleViaSocket).toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    });

    it.each([
        ['task_started', rawLifecycle('task_started')],
        [
            'non-terminal assistant output',
            rawClaudeOutput({
                content: [
                    { type: 'text', text: 'I will inspect the file.' },
                    { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
                ],
                stopReason: 'tool_use',
            }),
        ],
    ] as const)('does not report waited success when only %s follows the current user turn', async (_label, row) => {
        const { result, fetchEncryptedTranscriptPageAfterSeq, waitForIdleViaSocket } =
            await sendAndWaitForRowsAfterCurrentUser([row]);

        expect(result).toEqual({
            ok: false,
            code: 'timeout',
        });
        expect(waitForIdleViaSocket).toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    });

    it.each([
        ['turn_failed', rawLifecycle('turn_failed'), 'Current turn failed'],
        ['turn_cancelled', rawLifecycle('turn_cancelled'), 'Current turn cancelled'],
        ['turn_aborted', rawLifecycle('turn_aborted'), 'Current turn aborted'],
    ] as const)('returns wait_failed when structured lifecycle marker %s follows the current user turn', async (_label, row, message) => {
        const { result, fetchEncryptedTranscriptPageAfterSeq, waitForIdleViaSocket } =
            await sendAndWaitForRowsAfterCurrentUser([row]);

        expect(result).toEqual({
            ok: false,
            code: 'wait_failed',
            message,
        });
        expect(waitForIdleViaSocket).toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    });

    it('returns wait_failed with the runtime issue preview from a structured turn_failed marker', async () => {
        const { result, fetchEncryptedTranscriptPageAfterSeq, waitForIdleViaSocket } =
            await sendAndWaitForRowsAfterCurrentUser([
                rawLifecycle('turn_failed', {
                    v: 1,
                    scope: 'primary_session',
                    status: 'failed',
                    code: 'provider_status_error',
                    source: 'provider_status_error',
                    occurredAt: 101,
                    provider: 'pi',
                    sanitizedPreview: 'Pi provider reported assistant_message_end failed without details after prompt acceptance',
                }),
            ]);

        expect(result).toEqual({
            ok: false,
            code: 'wait_failed',
            message: 'Current turn failed: Pi provider reported assistant_message_end failed without details after prompt acceptance',
        });
        expect(waitForIdleViaSocket).toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    });

    it.each([
        ['task_complete', rawLifecycle('task_complete')],
        [
            'terminal assistant output',
            rawClaudeOutput({
                content: [{ type: 'text', text: 'done' }],
                stopReason: 'end_turn',
            }),
        ],
    ] as const)('reports waited success when %s follows the current user turn', async (_label, row) => {
        const { result, fetchEncryptedTranscriptPageAfterSeq, waitForIdleViaSocket } =
            await sendAndWaitForRowsAfterCurrentUser([row]);

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            waited: true,
            sessionId: 'sess-1',
            localId: 'local-user',
        }));
        expect(waitForIdleViaSocket).toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    });

    it('returns wait_failed for a structured current-turn failure even when provider error prose is followed by task_complete', async () => {
        const { result, fetchEncryptedTranscriptPageAfterSeq, waitForIdleViaSocket } =
            await sendAndWaitForRowsAfterCurrentUser(
                [
                    rawAcpMessage('Error: PiRpcCommandResponseTimeoutError: Timed out waiting for Pi RPC response (get_state)'),
                    rawLifecycle('task_complete'),
                ],
                {
                    sessionSnapshot: {
                        latestTurnStatus: 'failed',
                        latestTurnStatusObservedAt: 101,
                        lastRuntimeIssue: {
                            v: 1,
                            scope: 'primary_session',
                            status: 'failed',
                            code: 'provider_turn_failed',
                            source: 'provider_session_error',
                            occurredAt: 101,
                            provider: 'pi',
                            sanitizedPreview: 'Provider session failed',
                        },
                    },
                },
            );

        expect(result).toEqual({
            ok: false,
            code: 'wait_failed',
            message: 'Current turn failed: Provider session failed',
        });
        expect(waitForIdleViaSocket).toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).not.toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    });

    it('returns wait_failed for runtime issue ACP transcript rows', async () => {
        const { result, fetchEncryptedTranscriptPageAfterSeq, waitForIdleViaSocket } =
            await sendAndWaitForRowsAfterCurrentUser([
                rawRuntimeIssueMessage('Failed to authenticate. API Error: 401 Invalid authentication credentials'),
            ]);

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            code: 'wait_failed',
        }));
        expect(waitForIdleViaSocket).toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    });

    it('returns wait_failed for event-role turn_failed rows after Codex exec-client failure prose', async () => {
        const { result, fetchEncryptedTranscriptPageAfterSeq, waitForIdleViaSocket } =
            await sendAndWaitForRowsAfterCurrentUser([
                rawAcpMessage('Error: Plugin exec client process exited'),
                rawEventLifecycle('turn_failed'),
            ]);

        expect(result).toEqual({
            ok: false,
            code: 'wait_failed',
            message: 'Current turn failed',
        });
        expect(waitForIdleViaSocket).toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    });

    it('prefers a later failure row over earlier completion proof while polling assistant outcome', async () => {
        const { result, fetchEncryptedTranscriptPageAfterSeq, waitForIdleViaSocket } =
            await sendAndWaitForRowsAfterCurrentUser([], {
                limit100RowsByCall: [
                    [],
                    [
                        rawLifecycle('task_complete'),
                        rawLifecycle('turn_failed'),
                    ],
                ],
            });

        expect(result).toEqual({
            ok: false,
            code: 'wait_failed',
            message: 'Current turn failed',
        });
        expect(waitForIdleViaSocket).toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    });

    it('does not report waited success when transcript activity is unavailable after local materialization', async () => {
        const userMessageRow = {
            id: 'msg-user',
            localId: 'local-user',
            seq: 7,
            createdAt: 100,
            updatedAt: 100,
            content: { t: 'plain' as const, v: { role: 'user' } },
        };
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async (request: Readonly<{ limit?: number }>) => {
            if (request.limit === 51) {
                return [userMessageRow];
            }
            throw new Error('transcript unavailable');
        });
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => []);
        const waitForTranscriptEncryptedMessageByLocalId = vi.fn(async () => ({ seq: 7 }));
        const fetchSessionById = vi.fn(async () => ({
            id: 'sess-1',
            active: true,
            agentState: '{"requests":{"stale":{"createdAt":1}}}',
            latestTurnStatus: 'completed',
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
        }));
        const callSessionRpc = vi.fn(async () => ({ ok: true }));
        const waitForIdleViaSocket = vi.fn(async (request: Readonly<{
            initialTurnActivity?: Readonly<{ turnInFlight?: boolean }>;
        }>) => {
            if (request.initialTurnActivity?.turnInFlight === false) {
                return { idle: true as const, observedAt: 456 };
            }
            throw new Error('timeout');
        });

        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageAfterSeq,
            fetchEncryptedTranscriptPageLatest,
        }));
        vi.doMock('@/api/session/transcriptMessageLookup', () => ({
            waitForTranscriptEncryptedMessageByLocalId,
        }));
        vi.doMock('@/session/transport/http/sessionsHttp', () => ({
            fetchSessionById,
        }));
        vi.doMock('@/session/transport/rpc/sessionRpc', () => ({
            callSessionRpc,
        }));
        vi.doMock('@/session/transport/socket/sessionSocketSendMessage', () => ({
            sendSessionMessageViaSocketCommitted: vi.fn(async () => undefined),
        }));
        vi.doMock('@/session/transport/socket/sessionSocketAgentState', () => ({
            waitForIdleViaSocket,
        }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey' },
                rawSession: {
                    id: 'sess-1',
                    active: true,
                    metadata: '{}',
                    agentState: null,
                    latestTurnStatus: 'completed',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            })),
        }));

        const { sendSessionMessage } = await import('./sendSessionMessage');
        const machineKey = new Uint8Array(32).fill(1);

        const result = await sendSessionMessage({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-1',
            message: 'hello',
            wait: true,
            timeoutMs: 1_000,
            localId: 'local-user',
        });

        expect(result).toEqual(expect.objectContaining({ ok: false }));
        expect(result).not.toEqual(expect.objectContaining({
            ok: true,
            waited: true,
        }));
        expect(fetchEncryptedTranscriptPageAfterSeq).toHaveBeenCalledWith(expect.objectContaining({
            limit: 20,
        }));
        if (waitForIdleViaSocket.mock.calls.length > 0) {
            expect(waitForIdleViaSocket).toHaveBeenCalledWith(expect.objectContaining({
                initialTurnActivity: expect.objectContaining({
                    turnInFlight: true,
                }),
            }));
        }
    });

    it('uses an explicit localId for runtime RPC delivery when provided', async () => {
        const callSessionRpc = vi.fn(async () => ({ ok: true }));
        const sendSessionMessageViaSocketCommitted = vi.fn(async () => undefined);

        vi.doMock('@/session/transport/rpc/sessionRpc', () => ({
            callSessionRpc,
        }));
        vi.doMock('@/session/transport/socket/sessionSocketSendMessage', () => ({
            sendSessionMessageViaSocketCommitted,
        }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey' },
                rawSession: {
                    id: 'sess-1',
                    active: true,
                    metadata: '{}',
                    agentState: null,
                    latestTurnStatus: 'completed',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            })),
        }));

        const { sendSessionMessage } = await import('./sendSessionMessage');
        const machineKey = new Uint8Array(32).fill(1);

        await expect(sendSessionMessage({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-1',
            message: 'continue',
            localId: 'connected-service-continuation:test',
            wait: false,
            timeoutMs: 1,
        })).resolves.toEqual({
            ok: true,
            sessionId: 'sess-1',
            localId: 'connected-service-continuation:test',
            waited: false,
        });

        expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
            request: expect.objectContaining({
                localId: 'connected-service-continuation:test',
            }),
        }));
        expect(sendSessionMessageViaSocketCommitted).not.toHaveBeenCalled();
    });

    it('invokes onCommittedViaSocket when the message is committed through the pending queue path', async () => {
        const sendSessionMessageViaSocketCommitted = vi.fn(async () => undefined);
        const materializeNextPendingQueueV2MessageViaHttp = vi.fn(async () => ({ didMaterialize: true }));
        const onCommittedViaSocket = vi.fn(async () => undefined);

        vi.doMock('@/session/transport/rpc/sessionRpc', () => ({
            callSessionRpc: vi.fn(async () => ({ ok: true })),
        }));
        vi.doMock('@/session/transport/socket/sessionSocketSendMessage', () => ({
            sendSessionMessageViaSocketCommitted,
        }));
        vi.doMock('@/api/session/pendingQueueV2Transport', () => ({
            materializeNextPendingQueueV2MessageViaHttp,
        }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey' },
                rawSession: {
                    id: 'sess-1',
                    active: false,
                    metadata: '{}',
                    agentState: null,
                    latestTurnStatus: 'completed',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            })),
        }));

        const { sendSessionMessage } = await import('./sendSessionMessage');
        const machineKey = new Uint8Array(32).fill(1);

        await expect(sendSessionMessage({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-1',
            message: 'continue',
            localId: 'connected-service-continuation:test',
            wait: false,
            timeoutMs: 1,
            onCommittedViaSocket,
        })).resolves.toEqual({
            ok: true,
            sessionId: 'sess-1',
            localId: 'connected-service-continuation:test',
            waited: false,
        });

        expect(sendSessionMessageViaSocketCommitted).toHaveBeenCalledTimes(1);
        expect(materializeNextPendingQueueV2MessageViaHttp).toHaveBeenCalledWith({
            token: 'token',
            sessionId: 'sess-1',
        });
        expect(onCommittedViaSocket).toHaveBeenCalledWith({
            sessionId: 'sess-1',
            localId: 'connected-service-continuation:test',
        });
    });

    it('invokes onCommittedViaSocket when runtime RPC falls back to socket-committed delivery', async () => {
        const sendSessionMessageViaSocketCommitted = vi.fn(async () => undefined);
        const materializeNextPendingQueueV2MessageViaHttp = vi.fn(async () => ({ didMaterialize: true }));
        const onCommittedViaSocket = vi.fn(async () => undefined);

        vi.doMock('@/session/transport/rpc/sessionRpc', () => ({
            callSessionRpc: vi.fn(async () => {
                throw new Error('Socket connect timeout');
            }),
        }));
        vi.doMock('@/session/transport/socket/sessionSocketSendMessage', () => ({
            sendSessionMessageViaSocketCommitted,
        }));
        vi.doMock('@/api/session/pendingQueueV2Transport', () => ({
            materializeNextPendingQueueV2MessageViaHttp,
        }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey' },
                rawSession: {
                    id: 'sess-1',
                    active: true,
                    metadata: '{}',
                    agentState: null,
                    latestTurnStatus: 'completed',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            })),
        }));

        const { sendSessionMessage } = await import('./sendSessionMessage');
        const machineKey = new Uint8Array(32).fill(1);

        await expect(sendSessionMessage({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-1',
            message: 'continue',
            localId: 'connected-service-continuation:test',
            wait: false,
            timeoutMs: 1,
            onCommittedViaSocket,
        })).resolves.toEqual({
            ok: true,
            sessionId: 'sess-1',
            localId: 'connected-service-continuation:test',
            waited: false,
        });

        expect(sendSessionMessageViaSocketCommitted).toHaveBeenCalledTimes(1);
        expect(materializeNextPendingQueueV2MessageViaHttp).toHaveBeenCalledWith({
            token: 'token',
            sessionId: 'sess-1',
        });
        expect(onCommittedViaSocket).toHaveBeenCalledWith({
            sessionId: 'sess-1',
            localId: 'connected-service-continuation:test',
        });
    });
});
