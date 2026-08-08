function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Reads real effective-model evidence from a main-chain Claude assistant row.
 * Provider error rows use synthetic envelopes, and sidechains may run another model.
 */
export function readClaudeMainChainAssistantModelId(value: unknown): string | null {
    const message = readRecord(value);
    if (message?.type !== 'assistant') return null;
    if (message.isSidechain === true || readString(message.parent_tool_use_id)) return null;
    if (message.isApiErrorMessage === true || readString(message.error)) return null;

    const modelId = readString(readRecord(message.message)?.model);
    if (!modelId || modelId.includes('<')) return null;
    return modelId;
}
