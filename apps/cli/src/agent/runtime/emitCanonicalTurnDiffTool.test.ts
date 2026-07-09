import { afterEach, describe, expect, it } from 'vitest';

import type { TurnChangeSet } from '@happier-dev/protocol';

import { emitCanonicalTurnDiffTool } from './emitCanonicalTurnDiffTool';

describe('emitCanonicalTurnDiffTool', () => {
    afterEach(() => {
        delete process.env.HAPPIER_TURN_DIFF_FILE_BUDGET_BYTES;
        delete process.env.HAPPIER_TURN_DIFF_TURN_BUDGET_BYTES;
    });

    it('emits one canonical Diff tool call/result pair with turn metadata', () => {
        const calls: Array<{ toolName: string; input: unknown; callId?: string }> = [];
        const results: Array<{ callId: string; output: unknown }> = [];

        const turnChangeSet: TurnChangeSet = {
            sessionId: 'session_1',
            turnId: 'turn_1',
            seqRange: { startSeqInclusive: 1, endSeqInclusive: 4 },
            status: 'completed',
            provider: 'codex',
            derivedAt: 1_700_000_000_000,
            files: [{
                filePath: 'src/app.ts',
                changeKind: 'modified',
                oldText: 'a\n',
                newText: 'b\n',
                source: 'provider_native',
                confidence: 'exact',
                provider: 'codex',
            }],
        };

        emitCanonicalTurnDiffTool({
            turnChangeSet,
            protocol: 'codex',
            rawToolName: 'CodexDiff',
            sendToolCall: (params) => {
                calls.push(params);
                return 'call_1';
            },
            sendToolResult: (params) => {
                results.push(params);
            },
        });

        expect(calls).toEqual([
            expect.objectContaining({
                toolName: 'Diff',
                input: expect.objectContaining({
                    files: [
                        expect.objectContaining({
                            file_path: 'src/app.ts',
                            oldText: 'a\n',
                            newText: 'b\n',
                        }),
                    ],
                    _happier: expect.objectContaining({
                        provider: 'codex',
                        rawToolName: 'CodexDiff',
                        canonicalToolName: 'Diff',
                        workspaceMutationSignal: 'turn-change-set',
                        sessionChangeScope: 'turn',
                        turnId: 'turn_1',
                        sessionId: 'session_1',
                        confidence: 'exact',
                        source: 'provider_native',
                    }),
                }),
                callId: expect.any(String),
            }),
        ]);
        expect(results).toEqual([{ callId: 'call_1', output: { status: 'completed' } }]);
    });

    it('derives the canonical call id from the bounded emitted input', () => {
        process.env.HAPPIER_TURN_DIFF_FILE_BUDGET_BYTES = '512';
        process.env.HAPPIER_TURN_DIFF_TURN_BUDGET_BYTES = '512';

        const emittedCallIds: string[] = [];
        const emit = (oldText: string, newText: string): void => {
            const turnChangeSet: TurnChangeSet = {
                sessionId: 'session_1',
                turnId: 'turn_1',
                seqRange: { startSeqInclusive: 1, endSeqInclusive: 4 },
                status: 'completed',
                provider: 'claude',
                derivedAt: 1_700_000_000_000,
                files: [{
                    filePath: 'src/huge.ts',
                    changeKind: 'modified',
                    oldText,
                    newText,
                    source: 'provider_tool',
                    confidence: 'exact',
                    provider: 'claude',
                }],
            };

            emitCanonicalTurnDiffTool({
                turnChangeSet,
                protocol: 'claude',
                rawToolName: 'ClaudeTurnDiff',
                sendToolCall: (params) => {
                    emittedCallIds.push(params.callId ?? '');
                    return params.callId ?? 'missing-call-id';
                },
                sendToolResult: () => {},
            });
        };

        emit('a'.repeat(10_000), 'b'.repeat(10_000));
        emit('c'.repeat(10_000), 'd'.repeat(10_000));

        expect(emittedCallIds).toHaveLength(2);
        expect(emittedCallIds[0]).toMatch(/^turn-diff-[0-9a-f]{32}$/);
        expect(emittedCallIds[1]).toBe(emittedCallIds[0]);
    });
});
