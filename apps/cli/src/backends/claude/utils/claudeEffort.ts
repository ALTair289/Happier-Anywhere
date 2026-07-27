import { providers as agentProviders } from '@happier-dev/agents';

export type ClaudeEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const CLAUDE_EFFORT_LEVEL_PRIORITY: readonly ClaudeEffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function normalizeClaudeEffortLevel(raw: unknown): ClaudeEffortLevel | null {
    const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!value) return null;
    if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max') return value;
    return null;
}

function resolveClaudeEffortLevelsForKnownAliasOrModel(modelIdRaw: unknown): readonly ClaudeEffortLevel[] {
    const modelId = typeof modelIdRaw === 'string' ? modelIdRaw.trim().toLowerCase() : '';
    if (!modelId) return [];

    const direct = agentProviders.claude.resolveClaudeEffortLevelsForModelId(modelId) as readonly ClaudeEffortLevel[];
    if (direct.length > 0) return direct;

    if (modelId === 'fable' || modelId.includes('fable-5')) {
        return agentProviders.claude.resolveClaudeEffortLevelsForModelId('claude-fable-5') as readonly ClaudeEffortLevel[];
    }
    if (modelId.includes('opus-5')) {
        return agentProviders.claude.resolveClaudeEffortLevelsForModelId('claude-opus-5') as readonly ClaudeEffortLevel[];
    }
    if (modelId === 'opus') {
        return agentProviders.claude.resolveClaudeEffortLevelsForModelId(agentProviders.claude.CURRENT_FLAGSHIP_CLAUDE_MODEL_ID) as readonly ClaudeEffortLevel[];
    }
    if (modelId.includes('opus-4-8')) {
        return agentProviders.claude.resolveClaudeEffortLevelsForModelId('claude-opus-4-8') as readonly ClaudeEffortLevel[];
    }
    if (modelId.includes('opus-4-7')) {
        return agentProviders.claude.resolveClaudeEffortLevelsForModelId('claude-opus-4-7') as readonly ClaudeEffortLevel[];
    }
    if (modelId.includes('opus-4-6')) {
        return agentProviders.claude.resolveClaudeEffortLevelsForModelId('claude-opus-4-6') as readonly ClaudeEffortLevel[];
    }
    if (modelId === 'sonnet' || modelId.includes('sonnet-4-6')) {
        return agentProviders.claude.resolveClaudeEffortLevelsForModelId('claude-sonnet-4-6') as readonly ClaudeEffortLevel[];
    }
    if (modelId.includes('opus-4-5')) {
        return agentProviders.claude.resolveClaudeEffortLevelsForModelId('claude-opus-4-5') as readonly ClaudeEffortLevel[];
    }
    return [];
}

function resolveClaudeDefaultEffortForKnownAliasOrModel(modelIdRaw: unknown): ClaudeEffortLevel | null {
    const modelId = typeof modelIdRaw === 'string' ? modelIdRaw.trim().toLowerCase() : '';
    if (!modelId) return null;

    const direct = agentProviders.claude.resolveClaudeDefaultEffortLevelForModelId(modelId) as ClaudeEffortLevel | null;
    if (direct) return direct;

    if (modelId === 'fable' || modelId.includes('fable-5')) {
        return agentProviders.claude.resolveClaudeDefaultEffortLevelForModelId('claude-fable-5') as ClaudeEffortLevel | null;
    }
    if (modelId.includes('opus-5')) {
        return agentProviders.claude.resolveClaudeDefaultEffortLevelForModelId('claude-opus-5') as ClaudeEffortLevel | null;
    }
    if (modelId === 'opus') {
        return agentProviders.claude.resolveClaudeDefaultEffortLevelForModelId(agentProviders.claude.CURRENT_FLAGSHIP_CLAUDE_MODEL_ID) as ClaudeEffortLevel | null;
    }
    if (modelId.includes('opus-4-8')) {
        return agentProviders.claude.resolveClaudeDefaultEffortLevelForModelId('claude-opus-4-8') as ClaudeEffortLevel | null;
    }
    if (modelId.includes('opus-4-7')) {
        return agentProviders.claude.resolveClaudeDefaultEffortLevelForModelId('claude-opus-4-7') as ClaudeEffortLevel | null;
    }
    if (modelId.includes('opus-4-6')) {
        return agentProviders.claude.resolveClaudeDefaultEffortLevelForModelId('claude-opus-4-6') as ClaudeEffortLevel | null;
    }
    if (modelId === 'sonnet' || modelId.includes('sonnet-4-6')) {
        return agentProviders.claude.resolveClaudeDefaultEffortLevelForModelId('claude-sonnet-4-6') as ClaudeEffortLevel | null;
    }
    if (modelId.includes('opus-4-5')) {
        return agentProviders.claude.resolveClaudeDefaultEffortLevelForModelId('claude-opus-4-5') as ClaudeEffortLevel | null;
    }
    return null;
}

function resolveBestSupportedClaudeEffort(
    effort: ClaudeEffortLevel,
    supportedLevels: readonly ClaudeEffortLevel[],
): ClaudeEffortLevel | null {
    const requestedIndex = CLAUDE_EFFORT_LEVEL_PRIORITY.indexOf(effort);
    if (requestedIndex < 0) return null;

    for (let i = requestedIndex; i >= 0; i -= 1) {
        const candidate = CLAUDE_EFFORT_LEVEL_PRIORITY[i];
        if (supportedLevels.includes(candidate)) return candidate;
    }
    return null;
}

export function resolveClaudeEffortForModel(params: Readonly<{
    modelId: unknown;
    effort: unknown;
}>): ClaudeEffortLevel | null {
    const effort = normalizeClaudeEffortLevel(params.effort);
    if (!effort) return null;
    const supportedLevels = resolveClaudeEffortLevelsForKnownAliasOrModel(params.modelId);
    if (supportedLevels.length === 0) return null;

    const normalized = resolveBestSupportedClaudeEffort(effort, supportedLevels);
    if (!normalized) return null;
    const defaultEffort = resolveClaudeDefaultEffortForKnownAliasOrModel(params.modelId);

    return normalized === defaultEffort ? null : normalized;
}

export function buildClaudeEffortCliArgs(params: Readonly<{
    modelId: unknown;
    effort: unknown;
}>): string[] {
    const resolved = resolveClaudeEffortForModel(params);
    return resolved ? ['--effort', resolved] : [];
}

/** Alias-aware default effort for a Claude model id (tolerates `[1m]` variants). */
export function resolveClaudeDefaultEffortForModel(modelIdRaw: unknown): ClaudeEffortLevel | null {
    return resolveClaudeDefaultEffortForKnownAliasOrModel(modelIdRaw);
}

function normalizeUltracodeRequest(raw: unknown): boolean {
    if (raw === true) return true;
    return typeof raw === 'string' && raw.trim().toLowerCase() === 'true';
}

/**
 * Resolve the effective ultracode setting for a spawn/launch.
 *
 * Ultracode is a session-only Claude Code SETTING (forces xhigh + Dynamic Workflows) —
 * it is NOT an effort level and must never ride `--effort`/the SDK `effort` option.
 * It is honored only on xhigh-capable models (alias- and `[1m]`-tolerant).
 */
export function resolveClaudeUltracodeForModel(params: Readonly<{
    modelId: unknown;
    ultracode: unknown;
}>): boolean {
    if (!normalizeUltracodeRequest(params.ultracode)) return false;
    return resolveClaudeEffortLevelsForKnownAliasOrModel(params.modelId).includes('xhigh');
}

/** The `--settings` JSON overlay value that turns ultracode on for a spawned Claude CLI. */
export function buildClaudeUltracodeSettingsJson(): string {
    return JSON.stringify({ ultracode: true });
}
