import * as React from 'react';
import {
    buildBackendTargetKey,
    isBuiltInAgentTarget,
    type BackendTargetRefV1,
    type ConnectedServiceBindingsV1,
} from '@happier-dev/protocol';

import { resolveProviderAgentIdForBackendTarget } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { machineCapabilitiesInvoke } from '@/sync/ops/capabilities';
import { normalizeSessionConfigOptionsArray, type SessionConfigOption } from '@/sync/domains/sessionControl/configOptionsControl';
import { buildDynamicConfigOptionsProbeCacheKey } from '@/sync/acp/dynamicConfigOptionsProbeCacheKey';
import {
    DYNAMIC_CONFIG_OPTIONS_PROBE_ERROR_BACKOFF_MS,
    readDynamicConfigOptionsProbeCache,
    runDynamicConfigOptionsProbeDedupe,
    writeDynamicConfigOptionsProbeCacheError,
    writeDynamicConfigOptionsProbeCacheSuccess,
} from '@/sync/acp/dynamicConfigOptionsProbeCache';
import {
    buildNewSessionCapabilityProbeContextKey,
    normalizeNewSessionCapabilityProbeContextCacheKeySuffixParts,
    type NewSessionCapabilityProbeContext,
} from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import { NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS } from '@/components/sessions/new/modules/newSessionCapabilityProbeTimeoutMs';
import { scheduleProbedResourceRetryAfterExpiry } from './probedResourceRetrySchedule';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

export function useNewSessionPreflightConfigOptionsState(params: Readonly<{
    backendTarget: BackendTargetRefV1;
    selectedMachineId: string | null;
    capabilityServerId: string;
    cwd?: string | null;
    probeContext?: NewSessionCapabilityProbeContext | null;
    connectedServices?: ConnectedServiceBindingsV1 | null;
}>): Readonly<{
    configOptions: readonly SessionConfigOption[] | null;
    probe: Readonly<{
        phase: 'idle' | 'loading' | 'refreshing';
        refreshedAt: number | null;
        onRefresh: () => void;
    }>;
}> {
    const [configOptions, setConfigOptions] = React.useState<readonly SessionConfigOption[] | null>(null);
    const [probePhase, setProbePhase] = React.useState<'idle' | 'loading' | 'refreshing'>('idle');
    const [refreshedAt, setRefreshedAt] = React.useState<number | null>(null);
    const [refreshNonce, setRefreshNonce] = React.useState(0);
    const lastHandledRefreshNonceRef = React.useRef(0);
    const configOptionsRef = React.useRef<readonly SessionConfigOption[] | null>(null);
    const refreshedAtRef = React.useRef<number | null>(null);
    const lastScopeKeyRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        configOptionsRef.current = configOptions;
        refreshedAtRef.current = refreshedAt;
    }, [configOptions, refreshedAt]);

    const onRefresh = React.useCallback(() => {
        setRefreshNonce((current) => current + 1);
    }, []);

    const backendTargetKind = params.backendTarget.kind;
    const backendTargetAgentId = isBuiltInAgentTarget(params.backendTarget) ? params.backendTarget.agentId : null;
    const backendTargetBackendId = isBuiltInAgentTarget(params.backendTarget) ? null : params.backendTarget.backendId;

    const backendTarget = React.useMemo<BackendTargetRefV1>(() => {
        return backendTargetKind === 'builtInAgent'
            ? { kind: 'builtInAgent', agentId: backendTargetAgentId! }
            : { kind: 'configuredAcpBackend', backendId: backendTargetBackendId! };
    }, [backendTargetAgentId, backendTargetBackendId, backendTargetKind]);

    const agentType = React.useMemo(() => resolveProviderAgentIdForBackendTarget(backendTarget), [backendTarget]);
    const probeKey = React.useMemo(() => buildBackendTargetKey(backendTarget), [backendTarget]);
    const probeContextKey = buildNewSessionCapabilityProbeContextKey(params.probeContext);
    const probeContextCacheKeySuffixParts = React.useMemo(
        () => normalizeNewSessionCapabilityProbeContextCacheKeySuffixParts(params.probeContext),
        [probeContextKey],
    );
    const probeContextCapabilityParams = React.useMemo(
        () => params.probeContext?.capabilityParams ?? null,
        [probeContextKey],
    );
    const connectedServicesKey = React.useMemo(
        () => stableJsonStringify(params.connectedServices ?? null),
        [params.connectedServices],
    );
    const cacheKeySuffixParts = React.useMemo(
        () => [
            ...(probeContextCacheKeySuffixParts ?? []),
            ...(params.connectedServices ? [`connectedServices:${connectedServicesKey}`] : []),
        ],
        [probeContextCacheKeySuffixParts, connectedServicesKey, params.connectedServices],
    );

    const cacheKey = React.useMemo(() => buildDynamicConfigOptionsProbeCacheKey({
        machineId: params.selectedMachineId,
        targetKey: probeKey,
        serverId: params.capabilityServerId,
        cwd: params.cwd ?? null,
        extraKeySuffixParts: cacheKeySuffixParts,
    }), [params.capabilityServerId, params.cwd, params.selectedMachineId, cacheKeySuffixParts, probeKey]);

    const probeScopeKey = React.useMemo(() => {
        const machineId = String(params.selectedMachineId ?? '').trim();
        if (!machineId) return null;
        const serverId = String(params.capabilityServerId ?? '').trim() || 'active';
        return JSON.stringify([
            'dynamicConfigOptionsProbeScope',
            serverId,
            machineId,
            probeKey,
            ...cacheKeySuffixParts,
        ]);
    }, [params.capabilityServerId, params.selectedMachineId, cacheKeySuffixParts, probeKey]);

    React.useEffect(() => {
        if (!cacheKey) {
            setConfigOptions(null);
            configOptionsRef.current = null;
            setProbePhase('idle');
            setRefreshedAt(null);
            refreshedAtRef.current = null;
            lastScopeKeyRef.current = probeScopeKey;
            return;
        }

        let retryTimeout: ReturnType<typeof setTimeout> | null = null;
        const shouldForceProbe = refreshNonce !== 0 && refreshNonce !== lastHandledRefreshNonceRef.current;
        if (shouldForceProbe) {
            lastHandledRefreshNonceRef.current = refreshNonce;
        }

        const cacheEntry = readDynamicConfigOptionsProbeCache(cacheKey);
        const cached = cacheEntry?.kind === 'success' ? cacheEntry.value : null;
        const scopeStable = lastScopeKeyRef.current !== null && probeScopeKey !== null && lastScopeKeyRef.current === probeScopeKey;
        lastScopeKeyRef.current = probeScopeKey;
        if (cached) {
            setConfigOptions(cached);
            configOptionsRef.current = cached;
            const cachedUpdatedAt = cacheEntry?.updatedAt ?? null;
            setRefreshedAt(cachedUpdatedAt);
            refreshedAtRef.current = cachedUpdatedAt;
        } else if (!scopeStable) {
            setConfigOptions(null);
            configOptionsRef.current = null;
            setRefreshedAt(null);
            refreshedAtRef.current = null;
        }

        const nowMs = Date.now();
        if (!shouldForceProbe && cacheEntry && nowMs >= 0 && nowMs < cacheEntry.expiresAt) {
            setProbePhase('idle');
            retryTimeout = scheduleProbedResourceRetryAfterExpiry(cacheEntry, nowMs, () => {
                setRefreshNonce((n) => n + 1);
            });
            return () => {
                if (retryTimeout) clearTimeout(retryTimeout);
            };
        }

        let cancelled = false;
        const run = async () => {
            if (!params.selectedMachineId) return;
            setProbePhase(configOptionsRef.current ? 'refreshing' : 'loading');
            const cwd = typeof params.cwd === 'string' ? params.cwd.trim() : '';
            const attempt = await runDynamicConfigOptionsProbeDedupe<Readonly<{
                value: readonly SessionConfigOption[];
                cacheable: boolean;
            }> | null>(cacheKey, async () => {
                const response = await machineCapabilitiesInvoke(
                    params.selectedMachineId!,
                    {
                        id: `cli.${agentType}` as any,
                        method: 'probeConfigOptions',
                        params: {
                            timeoutMs: NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS,
                            backendTarget,
                            ...(probeContextCapabilityParams ? probeContextCapabilityParams : {}),
                            ...(params.connectedServices ? { connectedServices: params.connectedServices } : {}),
                            ...(cwd ? { cwd } : {}),
                        },
                    },
                    {
                        serverId: params.capabilityServerId,
                    },
                );

                if (!response.supported) return null;
                if (!response.response.ok) return null;
                const result = response.response.result as any;
                const normalized = normalizeSessionConfigOptionsArray(result?.configOptions);
                if (!normalized) return null;
                const source = typeof result?.source === 'string' ? result.source : null;
                const cacheable = source !== 'static';
                return { value: normalized, cacheable };
            });

            if (cancelled) return;
            const commitNowMs = Date.now();
            const value = attempt?.value ?? null;

            if (value && attempt?.cacheable !== false) {
                writeDynamicConfigOptionsProbeCacheSuccess(cacheKey, value, commitNowMs);
                setConfigOptions(value);
                setRefreshedAt(commitNowMs);
                setProbePhase('idle');
                return;
            }

            if (value && attempt?.cacheable === false && !cached) {
                writeDynamicConfigOptionsProbeCacheError(cacheKey, commitNowMs);
                setConfigOptions(value);
                setRefreshedAt(commitNowMs);
                setProbePhase('idle');
                return;
            }

            if (cached) {
                writeDynamicConfigOptionsProbeCacheSuccess(cacheKey, cached, commitNowMs);
                setConfigOptions(cached);
                setRefreshedAt(commitNowMs);
                setProbePhase('idle');
                return;
            }

            const stale = configOptionsRef.current;
            const staleUpdatedAt = refreshedAtRef.current;
            if (stale && staleUpdatedAt) {
                writeDynamicConfigOptionsProbeCacheSuccess(cacheKey, stale, commitNowMs);
                setConfigOptions(stale);
                setRefreshedAt(commitNowMs);
                setProbePhase('idle');
                return;
            }

            writeDynamicConfigOptionsProbeCacheError(cacheKey, commitNowMs);
            setProbePhase('idle');
            retryTimeout = setTimeout(() => {
                setRefreshNonce((n) => n + 1);
            }, DYNAMIC_CONFIG_OPTIONS_PROBE_ERROR_BACKOFF_MS);
        };

        void run();
        return () => {
            cancelled = true;
            if (retryTimeout) clearTimeout(retryTimeout);
        };
    }, [agentType, backendTarget, cacheKey, params.capabilityServerId, params.cwd, params.selectedMachineId, probeContextCapabilityParams, probeContextKey, probeScopeKey, refreshNonce, params.connectedServices]);

    return {
        configOptions,
        probe: {
            phase: probePhase,
            refreshedAt,
            onRefresh,
        },
    };
}
