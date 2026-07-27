import type { EnhancedMode } from '../loop';
import { readPendingLocalId } from '@happier-dev/protocol';
import type { PendingProviderAction } from '@/agent/runtime/modeMessageQueue';

export type ClaudeRemoteProviderPromptAcceptance = Readonly<{
    maxUserMessageSeq: number | null;
    userMessageLocalIds: readonly string[];
    appliedModelId?: string;
}>;

export type ClaudeRemoteProviderAcceptedPrompt<Mode = EnhancedMode> = Readonly<{
    message: string;
    mode: Mode;
    maxUserMessageSeq?: number | null;
    userMessageLocalIds?: readonly string[] | null;
    providerAcceptancePending?: boolean;
    pendingProviderAction?: PendingProviderAction;
}>;

export type ClaudeRemoteProviderPromptAttribution = Readonly<{
    maxUserMessageSeq: number | null;
    userMessageLocalIds: readonly string[];
    providerAcceptancePending: boolean;
    pendingProviderAction?: PendingProviderAction;
}>;

export function readClaudeRemoteProviderPromptAttribution(
    prompt: ClaudeRemoteProviderAcceptedPrompt,
): ClaudeRemoteProviderPromptAttribution {
    return {
        ...readClaudeRemoteProviderPromptAcceptance(prompt),
        providerAcceptancePending: prompt.providerAcceptancePending === true,
        ...(prompt.pendingProviderAction ? { pendingProviderAction: prompt.pendingProviderAction } : {}),
    };
}

export type ClaudeRemoteProviderPromptAcceptedHandler =
    (accepted: ClaudeRemoteProviderPromptAcceptance) => void | Promise<void>;

export type ClaudeRemoteProviderPromptTransportFailure =
    ClaudeRemoteProviderPromptAcceptance & Readonly<{
        kind: 'rejected_before_effect' | 'effect_may_have_occurred';
    }>;

export type ClaudeRemoteProviderPromptTransportFailureHandler =
    (failure: ClaudeRemoteProviderPromptTransportFailure) => void | Promise<void>;

export function readClaudeRemoteProviderPromptAcceptance(
    prompt: ClaudeRemoteProviderAcceptedPrompt,
): ClaudeRemoteProviderPromptAcceptance {
    const localIds: string[] = [];
    const seenLocalIds = new Set<string>();
    for (const value of prompt.userMessageLocalIds ?? []) {
        const localId = readPendingLocalId(value) ?? '';
        if (!localId || seenLocalIds.has(localId)) continue;
        seenLocalIds.add(localId);
        localIds.push(localId);
    }
    return {
        maxUserMessageSeq: typeof prompt.maxUserMessageSeq === 'number' && Number.isInteger(prompt.maxUserMessageSeq)
            ? prompt.maxUserMessageSeq
            : null,
        userMessageLocalIds: localIds,
        ...(prompt.pendingProviderAction !== 'steer'
            && typeof prompt.mode.model === 'string'
            && prompt.mode.model.trim()
            ? { appliedModelId: prompt.mode.model.trim() }
            : {}),
    };
}

export function confirmClaudeRemoteProviderPromptAccepted(
    handler: ClaudeRemoteProviderPromptAcceptedHandler | null | undefined,
    prompt: ClaudeRemoteProviderAcceptedPrompt,
): void {
    if (!handler) return;
    void Promise.resolve(handler(readClaudeRemoteProviderPromptAcceptance(prompt))).catch(() => {});
}

export function reportClaudeRemoteProviderPromptTransportFailure(
    handler: ClaudeRemoteProviderPromptTransportFailureHandler | null | undefined,
    prompt: ClaudeRemoteProviderAcceptedPrompt,
    kind: ClaudeRemoteProviderPromptTransportFailure['kind'],
): void {
    if (!handler) return;
    void Promise.resolve(handler({
        kind,
        ...readClaudeRemoteProviderPromptAcceptance(prompt),
    })).catch(() => {});
}
