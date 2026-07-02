import type { EnhancedMode } from '../loop';

export type ClaudeRemoteProviderPromptAcceptance = Readonly<{
    maxUserMessageSeq: number | null;
    userMessageLocalIds: readonly string[];
}>;

export type ClaudeRemoteProviderAcceptedPrompt<Mode = EnhancedMode> = Readonly<{
    message: string;
    mode: Mode;
    maxUserMessageSeq?: number | null;
    userMessageLocalIds?: readonly string[] | null;
}>;

export type ClaudeRemoteProviderPromptAcceptedHandler =
    (accepted: ClaudeRemoteProviderPromptAcceptance) => void | Promise<void>;

export function readClaudeRemoteProviderPromptAcceptance(
    prompt: ClaudeRemoteProviderAcceptedPrompt,
): ClaudeRemoteProviderPromptAcceptance {
    const localIds: string[] = [];
    const seenLocalIds = new Set<string>();
    for (const value of prompt.userMessageLocalIds ?? []) {
        const localId = typeof value === 'string' ? value.trim() : '';
        if (!localId || seenLocalIds.has(localId)) continue;
        seenLocalIds.add(localId);
        localIds.push(localId);
    }
    return {
        maxUserMessageSeq: typeof prompt.maxUserMessageSeq === 'number' && Number.isInteger(prompt.maxUserMessageSeq)
            ? prompt.maxUserMessageSeq
            : null,
        userMessageLocalIds: localIds,
    };
}

export function confirmClaudeRemoteProviderPromptAccepted(
    handler: ClaudeRemoteProviderPromptAcceptedHandler | null | undefined,
    prompt: ClaudeRemoteProviderAcceptedPrompt,
): void {
    if (!handler) return;
    void Promise.resolve(handler(readClaudeRemoteProviderPromptAcceptance(prompt))).catch(() => {});
}
