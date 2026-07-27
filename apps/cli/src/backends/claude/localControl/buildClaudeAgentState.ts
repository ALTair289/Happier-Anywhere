import { createAgentLocalControlState } from '@/agent/localControl/createAgentLocalControlState';
import type { AgentState } from '@/api/types';

type ClaudeControlMode = 'local' | 'remote';

export function buildClaudeAgentState(params: Readonly<{
    currentState: AgentState;
    mode: ClaudeControlMode;
    claudeUnifiedTerminalEnabled: boolean;
    localPermissionBridgeEnabled: boolean;
    userMessageHandlerReady?: boolean;
    /**
     * Lane Q: TUI runtime-control feature decision. When on (with unified terminal), the runtime
     * can apply a steered message's permission/plan mode delta IN-TURN, so the UI may offer
     * "Apply setting & steer now" instead of interrupt-or-queue only.
     */
    tuiRuntimeControlEnabled?: boolean;
}>): AgentState {
    const currentCapabilities =
        params.currentState.capabilities && typeof params.currentState.capabilities === 'object'
            ? params.currentState.capabilities
            : {};
    const capabilities = {
        ...currentCapabilities,
        askUserQuestionAnswersInPermission: true,
        localPermissionBridgeInLocalMode: params.localPermissionBridgeEnabled,
        permissionsInUiWhileLocal: params.localPermissionBridgeEnabled,
        userMessageHandlerReady: params.userMessageHandlerReady === true,
    };

    if (params.claudeUnifiedTerminalEnabled) {
        return {
            ...params.currentState,
            controlledByUser: false,
            localControl: createAgentLocalControlState({
                attached: true,
                topology: 'shared',
                canAttach: true,
                canDetach: false,
                remoteWritable: true,
            }),
            capabilities: {
                ...capabilities,
                inFlightSteer: true,
                inFlightSteerSupported: true,
                inFlightSteerAvailable: true,
                ...(params.tuiRuntimeControlEnabled === true ? { inFlightConfigApplySupported: true } : {}),
            },
        };
    }

    return {
        ...params.currentState,
        controlledByUser: params.mode === 'local',
        localControl: null,
        capabilities,
    };
}
