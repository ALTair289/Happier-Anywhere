import type { Metadata } from '@/api/types';
import { CATALOG_AGENT_IDS } from '@/backends/types';
import {
    createSessionHandoffMetadataSplit,
    pickSessionHandoffRuntimeLocalMetadata,
    type SessionHandoffLocalMetadataSource,
} from '@/session/handoff/metadata/runtimeLocalSessionHandoffMetadata';
import { buildRuntimeLocalHandoffMetadataForAgent } from '@/session/handoff/metadata/catalogHooks';
import type { TrackedSession } from '../types';
import { resolveTrackedSessionCatalogAgentId } from './resolveTrackedSessionCatalogAgentId';

function asMetadataRecord(value: unknown): Metadata | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    return value as Metadata;
}

function resolveTrackedSessionFallbackMetadata(params: Readonly<{
    trackedSession: TrackedSession;
    machineId?: string;
    fallbackHomeDir?: string;
}>): Record<string, unknown> | null {
    const sourcePath =
        typeof params.trackedSession.spawnOptions?.directory === 'string'
            ? params.trackedSession.spawnOptions.directory.trim()
            : '';
    const machineId = typeof params.machineId === 'string' ? params.machineId.trim() : '';
    const fallbackHomeDir = typeof params.fallbackHomeDir === 'string' ? params.fallbackHomeDir.trim() : '';
    const environmentVariables = params.trackedSession.spawnOptions?.environmentVariables;
    const homeDir = typeof environmentVariables?.HOME === 'string' && environmentVariables.HOME.trim().length > 0
        ? environmentVariables.HOME.trim()
        : fallbackHomeDir;
    const backendTarget = params.trackedSession.spawnOptions?.backendTarget;
    const flavor =
        backendTarget?.kind === 'builtInAgent'
        && typeof backendTarget.agentId === 'string'
        && (CATALOG_AGENT_IDS as readonly string[]).includes(backendTarget.agentId)
            ? backendTarget.agentId
            : '';
    if (!sourcePath || !machineId || !homeDir || !flavor) {
        return null;
    }
    return {
        machineId,
        path: sourcePath,
        homeDir,
        flavor,
    };
}

export function buildHandoffSessionMetadataFromTrackedSession(params: Readonly<{
    trackedSession: TrackedSession;
    machineId?: string;
    fallbackHomeDir?: string;
}>): SessionHandoffLocalMetadataSource | null {
    const metadata =
        asMetadataRecord(params.trackedSession.happySessionMetadataFromLocalWebhook)
        ?? resolveTrackedSessionFallbackMetadata(params);
    if (!metadata) {
        return null;
    }

    const runtimeLocalMetadata: Partial<Pick<
        Metadata,
        'claudeSessionId' | 'codexSessionId' | 'opencodeSessionId' | 'directSessionV1'
    >> = {
        ...(pickSessionHandoffRuntimeLocalMetadata(metadata) ?? {}),
    };
    const vendorResumeId =
        typeof params.trackedSession.vendorResumeId === 'string' && params.trackedSession.vendorResumeId.trim().length > 0
            ? params.trackedSession.vendorResumeId.trim()
            : '';
    if (!vendorResumeId) {
        return createSessionHandoffMetadataSplit({
            exportMetadata: metadata,
            ...(Object.keys(runtimeLocalMetadata).length > 0 ? { runtimeLocalMetadata } : {}),
        });
    }

    const providerRuntimeLocalMetadata = buildRuntimeLocalHandoffMetadataForAgent(
        resolveTrackedSessionCatalogAgentId(params.trackedSession),
        {
            metadata,
            trackedSession: params.trackedSession,
            vendorResumeId,
        },
    );
    if (providerRuntimeLocalMetadata) {
        Object.assign(runtimeLocalMetadata, providerRuntimeLocalMetadata);
    }

    return createSessionHandoffMetadataSplit({
        exportMetadata: metadata,
        ...(Object.keys(runtimeLocalMetadata).length > 0 ? { runtimeLocalMetadata } : {}),
    });
}
