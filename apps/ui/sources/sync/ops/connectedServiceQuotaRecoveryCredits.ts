import {
    ConnectedServiceQuotaRecoveryCreditConsumeRequestV1Schema,
    ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema,
    type ConnectedServiceId,
    type ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1,
    type ConnectedServiceQuotaRecoveryCreditConsumeResponseV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { t } from '@/text';
import { sanitizeEndpointErrorMessage } from '@/sync/runtime/connectivity/sanitizeEndpointErrorMessage';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

export type ConnectedServiceQuotaRecoveryCreditConsumeInput = Readonly<{
    machineId: string;
    serverId?: string | null;
    serviceId: ConnectedServiceId;
    profileId: string;
    providerCreditId?: string | null;
    sourceSnapshotFetchedAtMs?: number | null;
}>;

function failure(
    errorCode: string,
    error: unknown = errorCode,
    receipt?: ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1,
): ConnectedServiceQuotaRecoveryCreditConsumeResponseV1 {
    return {
        ok: false,
        errorCode,
        error: sanitizeEndpointErrorMessage(error) ?? t('common.error'),
        ...(receipt ? { receipt } : {}),
    };
}

function hashStringFNV1a32(value: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
}

function buildRecoveryCreditConsumeIdempotencyKey(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    providerCreditId?: string | null;
    sourceSnapshotFetchedAtMs?: number | null;
}>): string {
    const providerCreditId = typeof input.providerCreditId === 'string' ? input.providerCreditId.trim() : '';
    const snapshotFetchedAtMs = typeof input.sourceSnapshotFetchedAtMs === 'number' && Number.isFinite(input.sourceSnapshotFetchedAtMs)
        ? Math.max(0, Math.trunc(input.sourceSnapshotFetchedAtMs))
        : null;
    const selector = providerCreditId.length > 0
        ? `credit:${providerCreditId}`
        : `aggregate:${snapshotFetchedAtMs ?? 'unknown'}`;
    const key = `connected-service-quota-recovery-credit:v1:${input.serviceId}:${input.profileId}:${selector}`;
    return key.length <= 256
        ? key
        : `connected-service-quota-recovery-credit:v1:${hashStringFNV1a32(key)}:${key.length}`;
}

export async function connectedServiceQuotaRecoveryCreditConsume(
    input: ConnectedServiceQuotaRecoveryCreditConsumeInput,
): Promise<ConnectedServiceQuotaRecoveryCreditConsumeResponseV1> {
    const machineId = input.machineId.trim();
    if (!machineId) return failure('machine_unavailable', 'machine_unavailable');
    const profileId = input.profileId.trim();
    const providerCreditId = typeof input.providerCreditId === 'string' && input.providerCreditId.trim().length > 0
        ? input.providerCreditId.trim()
        : undefined;

    const parsedPayload = ConnectedServiceQuotaRecoveryCreditConsumeRequestV1Schema.safeParse({
        serviceId: input.serviceId,
        profileId,
        idempotencyKey: buildRecoveryCreditConsumeIdempotencyKey({
            serviceId: input.serviceId,
            profileId,
            ...(providerCreditId ? { providerCreditId } : {}),
            ...(typeof input.sourceSnapshotFetchedAtMs === 'number' ? { sourceSnapshotFetchedAtMs: input.sourceSnapshotFetchedAtMs } : {}),
        }),
        ...(providerCreditId ? { providerCreditId } : {}),
    });
    if (!parsedPayload.success) return failure('invalid_parameters', 'invalid_parameters');

    try {
        const response = await machineRpcWithServerScope<unknown, typeof parsedPayload.data>({
            machineId,
            serverId: input.serverId ?? undefined,
            method: RPC_METHODS.DAEMON_CONNECTED_SERVICE_QUOTA_RECOVERY_CREDIT_CONSUME,
            payload: parsedPayload.data,
        });
        const parsedResponse = ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema.safeParse(response);
        if (!parsedResponse.success) return failure('unsupported_response', 'unsupported_response');
        if (!parsedResponse.data.ok) {
            return failure(parsedResponse.data.errorCode, parsedResponse.data.error, parsedResponse.data.receipt);
        }
        return parsedResponse.data;
    } catch (error) {
        return failure(readRpcErrorCode(error) ?? 'machine_rpc_failed', error);
    }
}
