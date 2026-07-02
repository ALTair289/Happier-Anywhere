import {
    buildCodexAgentRuntimeDescriptor,
    normalizeCodexBackendMode,
} from '@happier-dev/agents';
import type { AgentRuntimeDescriptorV1, DirectSessionsSource } from '@happier-dev/protocol';
import { readCanonicalAgentRuntimeDescriptorV1ForProvider } from '@happier-dev/protocol';

import type { AgentSessionHandoffProviderPatch } from '@/agents/registry/registryUiBehavior';

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function normalizeTrimmedString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
}

function resolveCodexRuntimeSourceAffinity(
    targetDirectSource: DirectSessionsSource | Record<string, unknown>,
): Readonly<{
    home?: 'user' | 'connectedService';
    connectedServiceId?: string;
    connectedServiceProfileId?: string;
    connectedServiceGroupId?: string;
    homePath?: string;
}> {
    const directSourceRecord = asRecord(targetDirectSource);
    if (directSourceRecord?.kind !== 'codexHome') {
        return {};
    }

    return directSourceRecord.home === 'connectedService'
        ? {
            home: 'connectedService',
            connectedServiceId: normalizeTrimmedString(directSourceRecord.connectedServiceId) ?? undefined,
            connectedServiceProfileId: normalizeTrimmedString(directSourceRecord.connectedServiceProfileId) ?? undefined,
            connectedServiceGroupId: normalizeTrimmedString(directSourceRecord.connectedServiceGroupId) ?? undefined,
            homePath: normalizeTrimmedString(directSourceRecord.homePath) ?? undefined,
        }
        : {
            home: 'user',
            homePath: normalizeTrimmedString(directSourceRecord.homePath) ?? undefined,
        };
}

export function buildCodexSessionHandoffProviderPatch(input: Readonly<{
    metadata: Record<string, unknown>;
    targetRemoteSessionId: string;
    targetDirectSource: DirectSessionsSource | Record<string, unknown>;
    targetRuntimeDescriptor?: AgentRuntimeDescriptorV1;
}>): AgentSessionHandoffProviderPatch {
    const importedRuntimeDescriptor = readCanonicalAgentRuntimeDescriptorV1ForProvider(input.targetRuntimeDescriptor, 'codex');
    const backendMode = importedRuntimeDescriptor
        ? importedRuntimeDescriptor.backendMode ?? 'appServer'
        : normalizeCodexBackendMode(input.metadata.codexBackendMode);
    if (!backendMode) {
        return {
            agentRuntimeDescriptor: null,
            directSessionAgentRuntimeDescriptor: null,
        };
    }

    const agentRuntimeDescriptor = importedRuntimeDescriptor
        ? buildCodexAgentRuntimeDescriptor({
            backendMode: importedRuntimeDescriptor.backendMode ?? 'appServer',
            vendorSessionId: importedRuntimeDescriptor.vendorSessionId,
            home: importedRuntimeDescriptor.home,
            connectedServiceId: importedRuntimeDescriptor.connectedServiceId,
            connectedServiceProfileId: importedRuntimeDescriptor.connectedServiceProfileId,
            connectedServiceGroupId: importedRuntimeDescriptor.connectedServiceGroupId,
            homePath: importedRuntimeDescriptor.homePath,
        })
        : buildCodexAgentRuntimeDescriptor({
            backendMode,
            vendorSessionId: input.targetRemoteSessionId,
            ...resolveCodexRuntimeSourceAffinity(input.targetDirectSource),
        });

    return {
        metadataPatch: { codexBackendMode: backendMode },
        agentRuntimeDescriptor,
        directSessionAgentRuntimeDescriptor: agentRuntimeDescriptor,
    };
}
