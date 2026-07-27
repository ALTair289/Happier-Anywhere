import {
    ClientUpgradeRequiredV1Schema,
    ClientVersionCheckResponseV1Schema,
    type ClientUpgradeRequiredV1,
} from '@happier-dev/protocol';

import { storage } from '@/sync/domains/state/storage';
import type { NativeUpdateStatus } from '@/sync/store/domains/realtime';

type ApplyNativeUpdateStatus = (status: NativeUpdateStatus) => void;

export function parseUiClientUpgradeRequired(input: unknown): ClientUpgradeRequiredV1 | null {
    const direct = ClientUpgradeRequiredV1Schema.safeParse(input);
    if (direct.success) return direct.data;
    if (!input || typeof input !== 'object') return null;
    const nested = (input as { data?: unknown }).data;
    const parsedNested = ClientUpgradeRequiredV1Schema.safeParse(nested);
    return parsedNested.success ? parsedNested.data : null;
}

/**
 * HTTP 426 and Socket.IO connect_error converge through the existing global
 * update-status owner. Required update state is never dismissible; retaining it
 * even without a URL prevents a reconnect loop from silently looking healthy.
 */
export function applyUiClientUpgradeRequired(
    input: unknown,
    apply: ApplyNativeUpdateStatus = (status) => storage.getState().applyNativeUpdateStatus(status),
): boolean {
    const payload = parseUiClientUpgradeRequired(input);
    if (!payload) {
        const versionResponse = ClientVersionCheckResponseV1Schema.safeParse(input);
        if (!versionResponse.success || versionResponse.data.status !== 'upgrade-required') return false;
        apply({
            available: true,
            required: true,
            minimumAppVersion: versionResponse.data.minimumAppVersion,
            ...(versionResponse.data.updateUrl ? { updateUrl: versionResponse.data.updateUrl } : {}),
        });
        return true;
    }
    apply({
        available: true,
        required: true,
        ...(payload.requirement.minimumAppVersion
            ? { minimumAppVersion: payload.requirement.minimumAppVersion }
            : {}),
        ...(payload.requirement.updateUrl
            ? { updateUrl: payload.requirement.updateUrl }
            : {}),
    });
    return true;
}

export async function observeUiClientUpgradeRequiredResponse(response: Response): Promise<boolean> {
    if (response.status !== 426) return false;
    try {
        return applyUiClientUpgradeRequired(await response.clone().json());
    } catch {
        return false;
    }
}
