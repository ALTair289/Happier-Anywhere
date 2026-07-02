import {
    buildOpenCodeAgentRuntimeDescriptor,
    normalizeOpenCodeBackendMode,
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

function normalizeOpenCodeBackendModeForHandoff(value: unknown): 'server' | 'acp' | null {
    return value === 'server' || value === 'acp' ? value : null;
}

function readTargetOpenCodeServerBaseUrl(
    metadata: Record<string, unknown>,
    targetDirectSource: DirectSessionsSource | Record<string, unknown>,
): string | null {
    const directSourceRecord = asRecord(targetDirectSource);
    if (directSourceRecord?.kind === 'opencodeServer') {
        return normalizeTrimmedString(directSourceRecord.baseUrl);
    }

    if (metadata.opencodeServerBaseUrlExplicit === true) {
        return normalizeTrimmedString(metadata.opencodeServerBaseUrl);
    }

    return null;
}

function resolveTargetOpenCodeBackendMode(
    metadata: Record<string, unknown>,
    targetDirectSource: DirectSessionsSource | Record<string, unknown>,
): 'server' | 'acp' | null {
    const directSourceRecord = asRecord(targetDirectSource);
    if (directSourceRecord?.kind === 'opencodeServer') {
        return 'server';
    }

    return normalizeOpenCodeBackendModeForHandoff(metadata.opencodeBackendMode);
}

export function buildOpenCodeSessionHandoffProviderPatch(input: Readonly<{
    metadata: Record<string, unknown>;
    targetRemoteSessionId: string;
    targetDirectSource: DirectSessionsSource | Record<string, unknown>;
    targetRuntimeDescriptor?: AgentRuntimeDescriptorV1;
}>): AgentSessionHandoffProviderPatch {
    const importedRuntimeDescriptor = readCanonicalAgentRuntimeDescriptorV1ForProvider(input.targetRuntimeDescriptor, 'opencode');
    const backendMode = importedRuntimeDescriptor
        ? importedRuntimeDescriptor.backendMode ?? 'server'
        : resolveTargetOpenCodeBackendMode(input.metadata, input.targetDirectSource);
    if (!backendMode) {
        return {
            metadataPatch: {
                opencodeServerBaseUrl: undefined,
                opencodeServerBaseUrlExplicit: undefined,
            },
            agentRuntimeDescriptor: null,
            directSessionAgentRuntimeDescriptor: null,
        };
    }

    const serverBaseUrl = importedRuntimeDescriptor?.serverBaseUrl
        ?? readTargetOpenCodeServerBaseUrl(input.metadata, input.targetDirectSource);
    const agentRuntimeDescriptor = buildOpenCodeAgentRuntimeDescriptor({
        backendMode: normalizeOpenCodeBackendMode(backendMode),
        vendorSessionId: importedRuntimeDescriptor
            ? importedRuntimeDescriptor.vendorSessionId
            : input.targetRemoteSessionId,
        ...(serverBaseUrl ? { serverBaseUrl } : {}),
        ...(serverBaseUrl ? { serverBaseUrlExplicit: true } : {}),
    });

    return {
        metadataPatch: {
            opencodeBackendMode: backendMode,
            ...(serverBaseUrl
                ? {
                    opencodeServerBaseUrl: serverBaseUrl,
                    opencodeServerBaseUrlExplicit: true,
                }
                : {
                    opencodeServerBaseUrl: undefined,
                    opencodeServerBaseUrlExplicit: undefined,
                }),
        },
        agentRuntimeDescriptor,
        directSessionAgentRuntimeDescriptor: agentRuntimeDescriptor,
    };
}
