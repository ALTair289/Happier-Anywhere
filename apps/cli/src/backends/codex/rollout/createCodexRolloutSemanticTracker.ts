import type { CodexRolloutAction } from '../localControl/rolloutMapper';

type NormalizedCodexRolloutAction = Exclude<
    CodexRolloutAction,
    { type: 'collaboration-tool-call' } | { type: 'collaboration-tool-result' }
>;

type PendingSpawn = Readonly<{
    prompt: string | null;
    nickname: string | null;
    role: string | null;
}>;

type SemanticTrackerState = {
    pendingSpawnByCallId: Map<string, PendingSpawn>;
    startedThreadIds: Set<string>;
    completedThreadIds: Set<string>;
};

function consumeInto(
    state: SemanticTrackerState,
    action: CodexRolloutAction,
): NormalizedCodexRolloutAction[] {
    if (action.type === 'collaboration-tool-call') {
        if (action.name === 'spawn_agent') {
            state.pendingSpawnByCallId.set(action.callId, {
                prompt: action.prompt,
                nickname: action.nickname,
                role: action.role,
            });
        }
        return [];
    }

    if (action.type === 'collaboration-tool-result') {
        const pendingSpawn = state.pendingSpawnByCallId.get(action.callId);
        state.pendingSpawnByCallId.delete(action.callId);
        if (!action.threadId) return [];
        if (state.startedThreadIds.has(action.threadId)) return [];

        state.startedThreadIds.add(action.threadId);
        return [{
            type: 'subagent-spawn',
            threadId: action.threadId,
            prompt: pendingSpawn?.prompt ?? null,
            nickname: action.nickname ?? pendingSpawn?.nickname ?? null,
            role: pendingSpawn?.role ?? null,
        }];
    }

    if (action.type === 'subagent-spawn') {
        if (state.startedThreadIds.has(action.threadId)) return [];
        state.startedThreadIds.add(action.threadId);
        return [action];
    }

    if (action.type === 'subagent-complete') {
        if (state.completedThreadIds.has(action.threadId)) return [];
        state.completedThreadIds.add(action.threadId);

        if (!state.startedThreadIds.has(action.threadId)) {
            state.startedThreadIds.add(action.threadId);
            return [
                {
                    type: 'subagent-spawn',
                    threadId: action.threadId,
                    prompt: null,
                    nickname: null,
                    role: null,
                },
                action,
            ];
        }

        return [action];
    }

    return [action];
}

function cloneState(state: SemanticTrackerState): SemanticTrackerState {
    return {
        pendingSpawnByCallId: new Map(state.pendingSpawnByCallId),
        startedThreadIds: new Set(state.startedThreadIds),
        completedThreadIds: new Set(state.completedThreadIds),
    };
}

function commitStateTransition(
    current: SemanticTrackerState,
    before: SemanticTrackerState,
    after: SemanticTrackerState,
): void {
    for (const [callId, pending] of before.pendingSpawnByCallId) {
        if (!after.pendingSpawnByCallId.has(callId) && current.pendingSpawnByCallId.get(callId) === pending) {
            current.pendingSpawnByCallId.delete(callId);
        }
    }
    for (const [callId, pending] of after.pendingSpawnByCallId) {
        if (before.pendingSpawnByCallId.get(callId) !== pending) {
            current.pendingSpawnByCallId.set(callId, pending);
        }
    }
    for (const threadId of after.startedThreadIds) {
        if (!before.startedThreadIds.has(threadId)) {
            current.startedThreadIds.add(threadId);
        }
    }
    for (const threadId of after.completedThreadIds) {
        if (!before.completedThreadIds.has(threadId)) {
            current.completedThreadIds.add(threadId);
        }
    }
}

export function createCodexRolloutSemanticTracker() {
    const state: SemanticTrackerState = {
        pendingSpawnByCallId: new Map<string, PendingSpawn>(),
        startedThreadIds: new Set<string>(),
        completedThreadIds: new Set<string>(),
    };

    return {
        consume(action: CodexRolloutAction): NormalizedCodexRolloutAction[] {
            return consumeInto(state, action);
        },

        async consumeAfterAcknowledgement(
            actions: readonly CodexRolloutAction[],
            acknowledge: (actions: readonly NormalizedCodexRolloutAction[]) => Promise<void>,
        ): Promise<void> {
            const before = cloneState(state);
            const after = cloneState(state);
            const normalized = actions.flatMap((action) => consumeInto(after, action));
            await acknowledge(normalized);
            commitStateTransition(state, before, after);
        },
    };
}
