import type { DirectBrowseSourceOption } from '@/agents/registry/registryUiBehavior';
import { parseConnectedServicesBindingsByServiceIdFromAgentOptionState } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';

const CODEX_CONNECTED_SERVICE_ID = 'openai-codex';

function isCodexUserHomeOption(option: DirectBrowseSourceOption): boolean {
    return option.source.kind === 'codexHome' && option.source.home === 'user';
}

function matchesCodexConnectedServiceProfile(option: DirectBrowseSourceOption, profileId: string): boolean {
    return option.source.kind === 'codexHome'
        && option.source.home === 'connectedService'
        && option.source.connectedServiceId === CODEX_CONNECTED_SERVICE_ID
        && (option.source.connectedServiceProfileId ?? '') === profileId;
}

function matchesCodexConnectedServiceGroup(option: DirectBrowseSourceOption, groupId: string): boolean {
    return option.source.kind === 'codexHome'
        && option.source.home === 'connectedService'
        && option.source.connectedServiceId === CODEX_CONNECTED_SERVICE_ID
        && (option.source.connectedServiceGroupId ?? '') === groupId;
}

export function resolveCodexLockedBrowseSourceOption(params: Readonly<{
    sourceOptions: readonly DirectBrowseSourceOption[];
    agentOptionState: Record<string, unknown> | null | undefined;
}>): DirectBrowseSourceOption | null {
    const options = params.sourceOptions;
    if (options.length === 0) return null;

    const bindingsByServiceId = parseConnectedServicesBindingsByServiceIdFromAgentOptionState({
        agentOptionState: params.agentOptionState,
    });
    const binding = bindingsByServiceId[CODEX_CONNECTED_SERVICE_ID];
    const connectedGroupId = binding?.source === 'connected' && binding.selection === 'group'
        ? String(binding.groupId ?? '').trim()
        : '';
    const connectedProfileId = binding?.source === 'connected' ? String(binding.profileId ?? '').trim() : '';

    if (connectedGroupId) {
        const exactMatch = options.find((option) => matchesCodexConnectedServiceGroup(option, connectedGroupId));
        if (exactMatch) return exactMatch;

        const presentationSource = connectedProfileId
            ? options.find((option) => matchesCodexConnectedServiceProfile(option, connectedProfileId))
            : options.find((option) => (
                option.source.kind === 'codexHome'
                && option.source.home === 'connectedService'
                && option.source.connectedServiceId === CODEX_CONNECTED_SERVICE_ID
            ));
        return {
            key: `codex:connected-service:${CODEX_CONNECTED_SERVICE_ID}:group:${connectedGroupId}`,
            label: presentationSource?.label ?? connectedGroupId,
            ...(presentationSource?.detail ? { detail: presentationSource.detail } : {}),
            source: {
                kind: 'codexHome',
                home: 'connectedService',
                connectedServiceId: CODEX_CONNECTED_SERVICE_ID,
                connectedServiceGroupId: connectedGroupId,
            },
        };
    }

    if (connectedProfileId) {
        const match = options.find((option) => matchesCodexConnectedServiceProfile(option, connectedProfileId));
        if (match) return match;
    }

    return options.find((option) => isCodexUserHomeOption(option)) ?? options[0] ?? null;
}
