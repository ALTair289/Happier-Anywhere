import type { EnhancedMode } from '@/backends/claude/loop';

export type NormalizedClaudeRemoteModeKind = 'unifiedTerminal' | 'agentSdk' | 'legacy';

export type NormalizedClaudeRemoteMode = Readonly<{
    kind: NormalizedClaudeRemoteModeKind;
}>;

export function normalizeClaudeRemoteMode(mode: Pick<EnhancedMode, 'claudeRemoteAgentSdkEnabled' | 'claudeUnifiedTerminalEnabled'>): NormalizedClaudeRemoteMode {
    if (mode.claudeUnifiedTerminalEnabled === true) {
        return { kind: 'unifiedTerminal' };
    }
    if (mode.claudeRemoteAgentSdkEnabled === false) {
        return { kind: 'legacy' };
    }
    return { kind: 'agentSdk' };
}

/**
 * Runtime-family selection is a provider-session lifecycle decision. Account settings on later
 * queued prompts may change other live/restart-required options, but they must not replace the
 * runtime already serving the session. A new launcher invocation makes a new selection.
 */
export function pinClaudeRemoteModeToActiveRuntime(
    mode: EnhancedMode,
    activeRuntimeKind: NormalizedClaudeRemoteModeKind,
): EnhancedMode {
    if (activeRuntimeKind === 'unifiedTerminal') {
        return mode.claudeUnifiedTerminalEnabled === true
            ? mode
            : { ...mode, claudeUnifiedTerminalEnabled: true };
    }
    if (activeRuntimeKind === 'legacy') {
        return mode.claudeUnifiedTerminalEnabled !== true && mode.claudeRemoteAgentSdkEnabled === false
            ? mode
            : {
                ...mode,
                claudeUnifiedTerminalEnabled: false,
                claudeRemoteAgentSdkEnabled: false,
            };
    }
    return mode.claudeUnifiedTerminalEnabled !== true && mode.claudeRemoteAgentSdkEnabled !== false
        ? mode
        : {
            ...mode,
            claudeUnifiedTerminalEnabled: false,
            claudeRemoteAgentSdkEnabled: true,
        };
}
