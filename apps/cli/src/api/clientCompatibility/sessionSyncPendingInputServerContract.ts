import {
    FeaturesResponseSchema,
    PENDING_INPUT_PROTOCOL_VERSION_V1,
    SESSION_SYNC_PROTOCOL_VERSION_RUNTIME_ACTIVITY,
    SessionSyncPendingInputCompatibilityPingAckV1Schema,
} from '@happier-dev/protocol';

import { normalizeBaseUrl } from '@/diagnostics/httpClient';

export type SessionSyncPendingInputServerContractMode =
    | 'session_sync_v2_pending_input_v1'
    | 'released_server_v0_2_1'
    | 'indeterminate'
    | 'auth_failed';

type ProbeSocket = Readonly<{
    connected?: boolean;
}>;

type PingAckEmitter = Readonly<{
    timeout?: (timeoutMs: number) => PingAckEmitter;
    emitWithAck: (event: 'ping') => Promise<unknown>;
}>;

export type SessionSyncPendingInputServerContractResult = Readonly<{
    mode: SessionSyncPendingInputServerContractMode;
    sessionConnectionEpoch: number;
    socket: ProbeSocket;
}>;

type ContractProbe = Readonly<{
    sessionConnectionEpoch: number;
    socket: ProbeSocket;
    machineId: string | null | undefined;
}>;

type HttpCandidate = 'session_sync_v2_pending_input_v1' | 'released_server_v0_2_1';

function classifySuccessfulHttpPayload(raw: unknown): HttpCandidate | null {
    const features = FeaturesResponseSchema.safeParse(raw);
    if (!features.success) return null;

    const compatibility = features.data.capabilities.compatibility;
    const sessionSyncVersion = compatibility?.sessionSync.currentSessionSyncProtocolVersion;
    const pendingInputVersion = compatibility?.pendingInput?.currentPendingInputProtocolVersion;
    if (
        typeof sessionSyncVersion === 'number'
        && sessionSyncVersion >= SESSION_SYNC_PROTOCOL_VERSION_RUNTIME_ACTIVITY
        && typeof pendingInputVersion === 'number'
        && pendingInputVersion >= PENDING_INPUT_PROTOCOL_VERSION_V1
    ) {
        return 'session_sync_v2_pending_input_v1';
    }

    if (
        compatibility === undefined
        && features.data.features.sharing.pendingQueueV2.enabled === true
        && features.data.features.sharing.pendingDeliveryState.enabled !== true
    ) {
        return 'released_server_v0_2_1';
    }

    return null;
}

function isExactEmptyObject(value: unknown): value is Record<string, never> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return (prototype === Object.prototype || prototype === null) && Object.keys(value).length === 0;
}

function socketProvesCurrentContract(rawAck: unknown): boolean {
    const ack = SessionSyncPendingInputCompatibilityPingAckV1Schema.safeParse(rawAck);
    if (!ack.success) return false;
    const sessionSyncVersion = ack.data.compatibility.sessionSync.currentSessionSyncProtocolVersion;
    const pendingInputVersion = ack.data.compatibility.pendingInput?.currentPendingInputProtocolVersion;
    return typeof sessionSyncVersion === 'number'
        && sessionSyncVersion >= SESSION_SYNC_PROTOCOL_VERSION_RUNTIME_ACTIVITY
        && typeof pendingInputVersion === 'number'
        && pendingInputVersion >= PENDING_INPUT_PROTOCOL_VERSION_V1;
}

export function createSessionSyncPendingInputServerContractController(options: Readonly<{
    serverUrl: string;
    token: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}>) {
    const timeoutMs = options.timeoutMs ?? 6_000;
    const fetchImpl = options.fetchImpl ?? fetch;
    let active: {
        readonly sessionConnectionEpoch: number;
        readonly socket: ProbeSocket;
        promise: Promise<SessionSyncPendingInputServerContractResult> | null;
    } | null = null;

    const result = (
        probe: ContractProbe,
        mode: SessionSyncPendingInputServerContractMode,
    ): SessionSyncPendingInputServerContractResult => ({
        mode,
        sessionConnectionEpoch: probe.sessionConnectionEpoch,
        socket: probe.socket,
    });
    const isCurrent = (attempt: NonNullable<typeof active>): boolean => active === attempt;

    async function run(
        probe: ContractProbe,
        attempt: NonNullable<typeof active>,
    ): Promise<SessionSyncPendingInputServerContractResult> {
        if (!probe.machineId?.trim() || probe.socket.connected !== true) {
            return result(probe, 'indeterminate');
        }

        const abortController = new AbortController();
        const timer = setTimeout(() => abortController.abort(), timeoutMs);
        timer.unref?.();
        let rawFeatures: unknown;
        try {
            const response = await fetchImpl(`${normalizeBaseUrl(options.serverUrl)}/v1/features`, {
                method: 'GET',
                headers: { Authorization: `Bearer ${options.token}` },
                redirect: 'manual',
                signal: abortController.signal,
            });
            if (!isCurrent(attempt) || probe.socket.connected !== true) {
                return result(probe, 'indeterminate');
            }
            if (response.status === 401 || response.status === 403) return result(probe, 'auth_failed');
            if (!response.ok) return result(probe, 'indeterminate');
            rawFeatures = await response.json();
            if (!isCurrent(attempt) || probe.socket.connected !== true) {
                return result(probe, 'indeterminate');
            }
        } catch {
            return result(probe, 'indeterminate');
        } finally {
            clearTimeout(timer);
        }

        const httpCandidate = classifySuccessfulHttpPayload(rawFeatures);
        if (httpCandidate === null) return result(probe, 'indeterminate');

        let rawAck: unknown;
        try {
            // Socket.IO's overloaded event map is adapted only at this transport boundary.
            const emitter = probe.socket as unknown as PingAckEmitter;
            const socket = emitter.timeout?.(timeoutMs) ?? emitter;
            rawAck = await socket.emitWithAck('ping');
        } catch {
            return result(probe, 'indeterminate');
        }
        if (!isCurrent(attempt) || probe.socket.connected !== true) {
            return result(probe, 'indeterminate');
        }

        if (
            httpCandidate === 'session_sync_v2_pending_input_v1'
            && socketProvesCurrentContract(rawAck)
        ) {
            return result(probe, 'session_sync_v2_pending_input_v1');
        }
        if (
            httpCandidate === 'released_server_v0_2_1'
            && isExactEmptyObject(rawAck)
        ) {
            return result(probe, 'released_server_v0_2_1');
        }
        return result(probe, 'indeterminate');
    }

    return {
        resolve(probe: ContractProbe): Promise<SessionSyncPendingInputServerContractResult> {
            if (!probe.machineId?.trim() || probe.socket.connected !== true) {
                active = null;
                return Promise.resolve(result(probe, 'indeterminate'));
            }
            if (
                active?.sessionConnectionEpoch === probe.sessionConnectionEpoch
                && active.socket === probe.socket
                && active.promise
            ) {
                return active.promise;
            }
            const attempt: NonNullable<typeof active> = {
                sessionConnectionEpoch: probe.sessionConnectionEpoch,
                socket: probe.socket,
                promise: null,
            };
            const promise = run(probe, attempt);
            attempt.promise = promise;
            active = attempt;
            return promise;
        },
        invalidate(probe?: Readonly<{
            sessionConnectionEpoch?: number;
            socket?: ProbeSocket;
        }>): SessionSyncPendingInputServerContractResult | null {
            if (
                active && probe?.sessionConnectionEpoch !== undefined
                && active.sessionConnectionEpoch !== probe.sessionConnectionEpoch
            ) return null;
            if (active && probe?.socket !== undefined && active.socket !== probe.socket) return null;
            const invalidated = active;
            active = null;
            const sessionConnectionEpoch = probe?.sessionConnectionEpoch ?? invalidated?.sessionConnectionEpoch;
            const socket = probe?.socket ?? invalidated?.socket;
            return sessionConnectionEpoch !== undefined && socket
                ? { mode: 'indeterminate', sessionConnectionEpoch, socket }
                : null;
        },
    };
}
