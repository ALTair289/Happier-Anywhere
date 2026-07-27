import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import {
    buildCodexSyntheticSubagentToolCall,
    buildCodexSyntheticSubagentToolResult,
} from './buildCodexSyntheticSubagentToolMessages';

type SessionLike = Readonly<{
    sendAgentMessage: (
        provider: 'codex',
        body: ACPMessageData,
        opts?: { localId?: string; meta?: Record<string, unknown> },
    ) => void;
    sendAgentMessageCommitted: (
        provider: 'codex',
        body: ACPMessageData,
        opts: { localId: string; meta?: Record<string, unknown> },
    ) => Promise<unknown>;
}>;

type SubagentThreadState = Readonly<{
    rootToolCallSent: boolean;
    rootToolResultSent: boolean;
}>;

type SubagentMetadata = Readonly<{
    threadId: string;
    prompt?: string | null;
    nickname?: string | null;
    role?: string | null;
}>;

export function createCodexSyntheticSubagentTracker(params: Readonly<{
    session: SessionLike;
}>) {
    const stateByThreadId = new Map<string, SubagentThreadState>();

    const ensureStarted = async (
        metadata: SubagentMetadata,
        opts?: Readonly<{ localId: string }>,
    ): Promise<void> => {
        const current = stateByThreadId.get(metadata.threadId);
        if (current?.rootToolCallSent) return;

        const body = buildCodexSyntheticSubagentToolCall(metadata);
        if (opts) {
            await params.session.sendAgentMessageCommitted('codex', body, opts);
        } else {
            params.session.sendAgentMessage('codex', body);
        }
        stateByThreadId.set(metadata.threadId, {
            rootToolCallSent: true,
            rootToolResultSent: current?.rootToolResultSent ?? false,
        });
    };

    const finalize = async (
        metadata: Readonly<{ threadId: string; status: 'completed' | 'interrupted' }>,
        opts?: Readonly<{ localId: string }>,
    ): Promise<void> => {
        const current = stateByThreadId.get(metadata.threadId);
        if (!current?.rootToolCallSent) {
            if (opts) {
                throw new Error(`Exact Codex subagent result is missing its started occurrence: ${metadata.threadId}`);
            }
            await ensureStarted({ threadId: metadata.threadId });
        }
        const latest = stateByThreadId.get(metadata.threadId);
        if (latest?.rootToolResultSent) return;

        const body = buildCodexSyntheticSubagentToolResult(metadata);
        if (opts) {
            await params.session.sendAgentMessageCommitted('codex', body, opts);
        } else {
            params.session.sendAgentMessage('codex', body);
        }
        stateByThreadId.set(metadata.threadId, {
            rootToolCallSent: true,
            rootToolResultSent: true,
        });
    };

    return {
        ensureStarted,
        finalize,

        hasStarted(threadId: string): boolean {
            return stateByThreadId.get(threadId)?.rootToolCallSent === true;
        },
    };
}
