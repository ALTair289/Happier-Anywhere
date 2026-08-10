import * as React from 'react';
import { normalizePairingClaimOriginV1 } from '@happier-dev/protocol';

import { createPairingSecret } from '@/auth/pairing/pairingSecret';
import { buildPairingClaimDeepLink, buildPairingDeepLink } from '@/auth/pairing/pairingUrl';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import type { ActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { getCachedServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { resolvePreferredShareableServerUrl } from '@/sync/domains/server/url/shareableServerUrl';
import { isRuntimeActive } from '@/utils/runtime/isRuntimeActive';
import {
    pairingClaimStart,
    pairingStart,
    pairingStatus,
    type PairingStatus,
} from '@/sync/api/account/apiPairingAuth';

const PAIRING_STATUS_POLL_INTERVAL_MS = 1_000;

type StartPairingResult = { ok: true } | { ok: false; status: number };
export type PairingProtocol = 'legacy' | 'claim-v1';

type PairingSessionOwner = Readonly<{
    pairId: string;
    serverId: string;
    serverUrl: string;
    generation: number;
}>;

function createPairingSessionOwner(pairId: string, snapshot: ActiveServerSnapshot): PairingSessionOwner {
    return {
        pairId,
        serverId: snapshot.serverId,
        serverUrl: snapshot.serverUrl,
        generation: snapshot.generation,
    };
}

function isPairingSessionOwnerActive(owner: PairingSessionOwner): boolean {
    const active = getActiveServerSnapshot();
    return active.serverId === owner.serverId
        && active.serverUrl === owner.serverUrl
        && active.generation === owner.generation;
}

/**
 * Desktop/web pairing session lifecycle:
 * - start: default to the legacy secret protocol so existing phone apps remain compatible
 * - claim-v1: an explicit security mode; it never silently falls back to a secret link
 * - poll: GET /v1/auth/pairing/status until phone requests
 * - approve: handled by caller via existing auth account link flow
 */
export function usePairingSession(params: Readonly<{ enabled: boolean; isAuthenticated: boolean }>): Readonly<{
    deepLink: string | null;
    status: PairingStatus | null;
    isExpired: boolean;
    isStarting: boolean;
    protocol: PairingProtocol | null;
    startPairing: (options?: Readonly<{ protocol?: PairingProtocol }>) => Promise<StartPairingResult>;
    clearSession: () => void;
}> {
    const enabled = params.enabled;
    const isAuthenticated = params.isAuthenticated;

    const [pairId, setPairId] = React.useState<string | null>(null);
    const [status, setStatus] = React.useState<PairingStatus | null>(null);
    const [deepLink, setDeepLink] = React.useState<string | null>(null);
    const [isExpired, setIsExpired] = React.useState(false);
    const [isStarting, setIsStarting] = React.useState(false);
    const [protocol, setProtocol] = React.useState<PairingProtocol | null>(null);
    const operationGenerationRef = React.useRef(0);
    const activeStartGenerationRef = React.useRef<number | null>(null);
    const sessionOwnerRef = React.useRef<PairingSessionOwner | null>(null);

    const clearSession = React.useCallback(() => {
        operationGenerationRef.current += 1;
        activeStartGenerationRef.current = null;
        sessionOwnerRef.current = null;
        setPairId(null);
        setStatus(null);
        setDeepLink(null);
        setIsExpired(false);
        setIsStarting(false);
        setProtocol(null);
    }, []);

    React.useEffect(() => {
        if (enabled && isAuthenticated) return;
        clearSession();
    }, [clearSession, enabled, isAuthenticated]);

    React.useEffect(() => () => {
        operationGenerationRef.current += 1;
        activeStartGenerationRef.current = null;
        sessionOwnerRef.current = null;
    }, []);

    const startPairing = React.useCallback(async (options?: Readonly<{ protocol?: PairingProtocol }>) => {
        if (!enabled || !isAuthenticated) {
            return { ok: false, status: 401 } as const;
        }
        if (activeStartGenerationRef.current !== null) {
            return { ok: false, status: 409 } as const;
        }

        const operationGeneration = operationGenerationRef.current + 1;
        operationGenerationRef.current = operationGeneration;
        activeStartGenerationRef.current = operationGeneration;
        const isCurrentOperation = () => activeStartGenerationRef.current === operationGeneration;
        setIsStarting(true);
        setIsExpired(false);
        setStatus(null);
        setDeepLink(null);
        setPairId(null);
        setProtocol(null);
        sessionOwnerRef.current = null;

        try {
            const active = getActiveServerSnapshot();
            const cached = getCachedServerFeaturesSnapshot({ serverId: active.serverId });
            const canonicalRaw =
                cached?.status === 'ready'
                    ? cached.features.capabilities?.server?.canonicalServerUrl
                    : null;
            const canonical = typeof canonicalRaw === 'string' ? canonicalRaw.trim() : '';
            const serverUrl = resolvePreferredShareableServerUrl({
                preferredShareableServerUrl: active.activeShareableServerUrl,
                canonicalServerUrl: canonical || null,
                activeServerUrl: active.serverUrl,
            });

            const requestedProtocol = options?.protocol ?? 'legacy';
            if (requestedProtocol === 'claim-v1') {
                const claimOrigin = serverUrl ? normalizePairingClaimOriginV1(serverUrl) : null;
                if (!claimOrigin) return { ok: false, status: 422 } as const;
                const claimed = await pairingClaimStart({ origin: claimOrigin });
                if (!isCurrentOperation()) return { ok: false, status: 409 } as const;
                if (claimed.ok) {
                    const data = claimed.data;
                    if (!isPairingSessionOwnerActive(createPairingSessionOwner(data.claimId, active))) {
                        return { ok: false, status: 409 } as const;
                    }
                    sessionOwnerRef.current = createPairingSessionOwner(data.claimId, active);
                    setPairId(data.claimId);
                    setDeepLink(buildPairingClaimDeepLink({ claimId: data.claimId, origin: data.origin }));
                    setStatus({ state: 'pending', pairId: data.claimId, expiresAt: data.expiresAt });
                    setProtocol('claim-v1');
                    return { ok: true } as const;
                }
                return { ok: false, status: claimed.status } as const;
            }

            const { secret, secretHash } = await createPairingSecret();
            if (!isCurrentOperation()) return { ok: false, status: 409 } as const;
            const started = await pairingStart({ secretHash });
            if (!isCurrentOperation()) return { ok: false, status: 409 } as const;
            if (!started.ok) {
                return { ok: false, status: started.status } as const;
            }

            const data = started.data;

            if (!isPairingSessionOwnerActive(createPairingSessionOwner(data.pairId, active))) {
                return { ok: false, status: 409 } as const;
            }
            sessionOwnerRef.current = createPairingSessionOwner(data.pairId, active);

            const link = buildPairingDeepLink({ pairId: data.pairId, secret, serverUrl });

            setPairId(data.pairId);
            setDeepLink(link);
            setStatus({ state: 'pending', pairId: data.pairId, expiresAt: data.expiresAt });
            setProtocol('legacy');
            return { ok: true } as const;
        } catch {
            return { ok: false, status: 500 } as const;
        } finally {
            if (activeStartGenerationRef.current === operationGeneration) {
                activeStartGenerationRef.current = null;
                setIsStarting(false);
            }
        }
    }, [enabled, isAuthenticated]);

    React.useEffect(() => {
        if (!enabled || !isAuthenticated) return;
        if (!pairId) return;
        const owner = sessionOwnerRef.current;
        if (!owner || owner.pairId !== pairId) return;
        let cancelled = false;
        let timeout: ReturnType<typeof setTimeout> | null = null;

        const invalidateOwnedSession = () => {
            if (cancelled || sessionOwnerRef.current !== owner) return;
            clearSession();
        };

        const poll = async () => {
            if (cancelled) return;
            if (!isPairingSessionOwnerActive(owner)) {
                invalidateOwnedSession();
                return;
            }
            if (isRuntimeActive()) {
                try {
                    const res = await pairingStatus({ pairId });
                    if (cancelled || sessionOwnerRef.current !== owner) return;
                    if (!isPairingSessionOwnerActive(owner)) {
                        invalidateOwnedSession();
                        return;
                    }
                    if (!res.ok) {
                        if (res.reason === 'not_found') {
                            sessionOwnerRef.current = null;
                            setIsExpired(true);
                            setStatus(null);
                            setDeepLink(null);
                            setPairId(null);
                        }
                    } else {
                        setIsExpired(false);
                        setStatus(res.data);
                    }
                } catch {
                    if (!isPairingSessionOwnerActive(owner)) {
                        invalidateOwnedSession();
                        return;
                    }
                }
            }
            if (!cancelled && sessionOwnerRef.current === owner && isPairingSessionOwnerActive(owner)) {
                timeout = setTimeout(() => {
                    void poll();
                }, PAIRING_STATUS_POLL_INTERVAL_MS);
            }
        };

        void poll();

        return () => {
            cancelled = true;
            if (timeout) clearTimeout(timeout);
        };
    }, [clearSession, enabled, isAuthenticated, pairId]);

    return { deepLink, status, isExpired, isStarting, protocol, startPairing, clearSession };
}
