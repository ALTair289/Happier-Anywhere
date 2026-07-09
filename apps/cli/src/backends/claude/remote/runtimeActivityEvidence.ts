import {
    buildClaudeProviderTaskRuntimeActivitySourceId,
    CLAUDE_PROVIDER_TASK_RUNTIME_ACTIVITY_SOURCE_CLASS,
    CLAUDE_RUNTIME_ACTIVITY_PROVIDER_ID,
    createClaudeProviderActivityLedger,
    normalizeClaudeAgentSdkProviderTaskId,
    type ClaudeProviderRuntimeActivityPublisher,
} from '@/backends/claude/providerActivity/createClaudeProviderActivityLedger';

type LoggerLike = Readonly<{
    debug: (message: string, ...args: unknown[]) => void;
}>;

export type ClaudeRuntimeActivityEvidence = {
    providerActivityLedger: ReturnType<typeof createClaudeProviderActivityLedger>;
    liveProviderTaskIds: Set<string>;
    publishedProviderTaskSourceIds?: Set<string>;
    didPublishClaudeRuntimeActivity: boolean;
};

type RuntimeActivityEffectParams = Readonly<{
    evidence: ClaudeRuntimeActivityEvidence;
    logger: LoggerLike;
    logPrefix: string;
    runtimeActivityPublisher?: ClaudeProviderRuntimeActivityPublisher | null;
}>;

export function createClaudeRuntimeActivityEvidence(): ClaudeRuntimeActivityEvidence {
    return {
        providerActivityLedger: createClaudeProviderActivityLedger(),
        liveProviderTaskIds: new Set<string>(),
        publishedProviderTaskSourceIds: new Set<string>(),
        didPublishClaudeRuntimeActivity: false,
    };
}

export function isReplaySdkMessage(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    return record.isReplay === true || record.is_replay === true;
}

export function noteLiveProviderTaskEvidence(
    evidence: ClaudeRuntimeActivityEvidence,
    taskId: unknown,
): string | null {
    const normalizedTaskId = normalizeClaudeAgentSdkProviderTaskId(taskId);
    if (!normalizedTaskId) return null;
    evidence.liveProviderTaskIds.add(normalizedTaskId);
    return normalizedTaskId;
}

function runRuntimeActivityEffect(
    params: RuntimeActivityEffectParams & Readonly<{
        label: string;
        effect: () => Promise<void> | void;
    }>,
): void {
    try {
        void Promise.resolve(params.effect()).catch((error) => {
            params.logger.debug(`${params.logPrefix} runtime activity ${params.label} failed (non-fatal)`, error);
        });
    } catch (error) {
        params.logger.debug(`${params.logPrefix} runtime activity ${params.label} failed (non-fatal)`, error);
    }
}

function getPublishedProviderTaskSourceIds(evidence: ClaudeRuntimeActivityEvidence): Set<string> {
    evidence.publishedProviderTaskSourceIds ??= new Set<string>();
    return evidence.publishedProviderTaskSourceIds;
}

export function setProviderTaskRuntimeActivityActive(
    params: RuntimeActivityEffectParams & Readonly<{ taskId: unknown }>,
): void {
    const sourceId = buildClaudeProviderTaskRuntimeActivitySourceId(params.taskId);
    if (!sourceId || !params.runtimeActivityPublisher) return;
    params.evidence.didPublishClaudeRuntimeActivity = true;
    getPublishedProviderTaskSourceIds(params.evidence).add(sourceId);
    runRuntimeActivityEffect({
        ...params,
        label: 'set-active',
        effect: () => params.runtimeActivityPublisher?.setSourceActive({
            id: sourceId,
            sourceClass: CLAUDE_PROVIDER_TASK_RUNTIME_ACTIVITY_SOURCE_CLASS,
            providerId: CLAUDE_RUNTIME_ACTIVITY_PROVIDER_ID,
        }),
    });
}

export function observeProviderTaskRuntimeActivity(
    params: RuntimeActivityEffectParams & Readonly<{ taskId: unknown }>,
): void {
    const sourceId = buildClaudeProviderTaskRuntimeActivitySourceId(params.taskId);
    if (!sourceId || !params.runtimeActivityPublisher) return;
    params.evidence.didPublishClaudeRuntimeActivity = true;
    const publishedSourceIds = getPublishedProviderTaskSourceIds(params.evidence);
    if (!publishedSourceIds.has(sourceId)) {
        publishedSourceIds.add(sourceId);
        runRuntimeActivityEffect({
            ...params,
            label: 'set-active',
            effect: () => params.runtimeActivityPublisher?.setSourceActive({
                id: sourceId,
                sourceClass: CLAUDE_PROVIDER_TASK_RUNTIME_ACTIVITY_SOURCE_CLASS,
                providerId: CLAUDE_RUNTIME_ACTIVITY_PROVIDER_ID,
            }),
        });
        return;
    }
    runRuntimeActivityEffect({
        ...params,
        label: 'observe-source',
        effect: () => params.runtimeActivityPublisher?.observeSource({
            id: sourceId,
            reason: 'claude_provider_task_progress',
        }),
    });
}

export function clearProviderTaskRuntimeActivity(
    params: RuntimeActivityEffectParams & Readonly<{ taskId: unknown }>,
): void {
    const sourceId = buildClaudeProviderTaskRuntimeActivitySourceId(params.taskId);
    if (!sourceId || !params.runtimeActivityPublisher) return;
    getPublishedProviderTaskSourceIds(params.evidence).delete(sourceId);
    runRuntimeActivityEffect({
        ...params,
        label: 'clear-source',
        effect: () => params.runtimeActivityPublisher?.clearSource(
            sourceId,
            'claude_provider_task_terminal',
        ),
    });
}

export function clearClaudeRuntimeActivity(params: RuntimeActivityEffectParams & Readonly<{
    reason: string;
}>): void {
    if (!params.runtimeActivityPublisher || !params.evidence.didPublishClaudeRuntimeActivity) return;
    runRuntimeActivityEffect({
        ...params,
        label: 'clear-provider',
        effect: () => params.runtimeActivityPublisher?.clearProviderSources(
            CLAUDE_RUNTIME_ACTIVITY_PROVIDER_ID,
            params.reason,
        ),
    });
    getPublishedProviderTaskSourceIds(params.evidence).clear();
    params.evidence.didPublishClaudeRuntimeActivity = false;
}

export async function reconcileClaudeRuntimeActivity(params: RuntimeActivityEffectParams & Readonly<{
    reason: string;
}>): Promise<void> {
    const runtimeActivityPublisher = params.runtimeActivityPublisher;
    if (!runtimeActivityPublisher) return;

    const sources: Array<Readonly<{
        id: string;
        sourceClass: typeof CLAUDE_PROVIDER_TASK_RUNTIME_ACTIVITY_SOURCE_CLASS;
        providerId: typeof CLAUDE_RUNTIME_ACTIVITY_PROVIDER_ID;
    }>> = [];
    for (const blocker of params.evidence.providerActivityLedger.getActiveProviderTaskBlockers()) {
        if (!params.evidence.liveProviderTaskIds.has(blocker.taskId)) continue;
        const sourceId = buildClaudeProviderTaskRuntimeActivitySourceId(blocker.taskId);
        if (!sourceId) continue;
        sources.push({
            id: sourceId,
            sourceClass: CLAUDE_PROVIDER_TASK_RUNTIME_ACTIVITY_SOURCE_CLASS,
            providerId: CLAUDE_RUNTIME_ACTIVITY_PROVIDER_ID,
        });
    }

    try {
        await runtimeActivityPublisher.clearProviderSources(CLAUDE_RUNTIME_ACTIVITY_PROVIDER_ID, params.reason);
        const publishedSourceIds = getPublishedProviderTaskSourceIds(params.evidence);
        publishedSourceIds.clear();
        for (const source of sources) {
            await runtimeActivityPublisher.setSourceActive(source);
            publishedSourceIds.add(source.id);
        }
        params.evidence.didPublishClaudeRuntimeActivity = sources.length > 0;
    } catch (error) {
        params.logger.debug(`${params.logPrefix} runtime activity reconcile failed (non-fatal)`, error);
    }
}
