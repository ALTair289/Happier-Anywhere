import {
    CURRENT_SESSION_SYNC_PROTOCOL_VERSION,
    ClientCompatibilityDeclarationV1Schema,
    ClientUpgradeRequiredV1Schema,
    buildClientCompatibilityHttpHeadersV1,
    buildClientCompatibilitySocketAuthV1,
    type ClientCompatibilityDeclarationV1,
} from '@happier-dev/protocol';

import { configuration } from '@/configuration';

type CliClientKind = Extract<ClientCompatibilityDeclarationV1['clientKind'], 'cli' | 'daemon' | 'session-runner'>;

function normalizeAppVersion(value: string | null | undefined): string {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,95}$/.test(normalized) ? normalized : '0.0.0';
}

function normalizeReleaseChannel(value: string | null | undefined): string | undefined {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return /^[a-z0-9][a-z0-9-]{0,31}$/.test(normalized) ? normalized : undefined;
}

export function resolveCliClientCompatibilityDeclaration(input: Readonly<{
    clientKind: CliClientKind;
    appVersion: string | null | undefined;
    releaseChannel?: string | null;
}>): ClientCompatibilityDeclarationV1 {
    const releaseChannel = normalizeReleaseChannel(input.releaseChannel);
    return ClientCompatibilityDeclarationV1Schema.parse({
        v: 1,
        clientKind: input.clientKind,
        appVersion: normalizeAppVersion(input.appVersion),
        ...(releaseChannel ? { releaseChannel } : {}),
        sessionSyncProtocolVersion: CURRENT_SESSION_SYNC_PROTOCOL_VERSION,
    });
}

export function readCurrentCliClientCompatibilityDeclaration(
    clientKind: CliClientKind,
): ClientCompatibilityDeclarationV1 {
    return resolveCliClientCompatibilityDeclaration({
        clientKind,
        appVersion: configuration.currentCliVersion,
        releaseChannel: process.env.HAPPIER_PUBLIC_RELEASE_CHANNEL ?? null,
    });
}

export function buildCliClientCompatibilityHttpHeaders(
    declaration: ClientCompatibilityDeclarationV1,
) {
    return buildClientCompatibilityHttpHeadersV1(declaration);
}

export function buildCurrentCliClientCompatibilityHttpHeaders(clientKind: CliClientKind) {
    return buildCliClientCompatibilityHttpHeaders(readCurrentCliClientCompatibilityDeclaration(clientKind));
}

export function buildCliClientCompatibilitySocketAuth(
    declaration: ClientCompatibilityDeclarationV1,
) {
    return buildClientCompatibilitySocketAuthV1(declaration);
}

export function buildCurrentCliClientCompatibilitySocketAuth(clientKind: CliClientKind) {
    return buildCliClientCompatibilitySocketAuth(readCurrentCliClientCompatibilityDeclaration(clientKind));
}

function readRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

export function readCliClientUpgradeRequired(value: unknown) {
    const record = readRecord(value);
    const rpcRegistrationPayload = record?.type === 'register'
        ? {
            error: record.error,
            requirement: record.requirement,
        }
        : null;
    const candidates = [
        value,
        rpcRegistrationPayload,
        record?.data,
        readRecord(record?.response)?.data,
    ];
    for (const candidate of candidates) {
        const parsed = ClientUpgradeRequiredV1Schema.safeParse(candidate);
        if (parsed.success) return parsed.data;
    }
    return null;
}

export class CliClientUpgradeRequiredError extends Error {
    readonly statusCode = 426;
    readonly requirement: NonNullable<ReturnType<typeof readCliClientUpgradeRequired>>['requirement'];

    constructor(payload: NonNullable<ReturnType<typeof readCliClientUpgradeRequired>>) {
        super('This Happier client must be upgraded before it can sync sessions.');
        this.name = 'CliClientUpgradeRequiredError';
        this.requirement = payload.requirement;
    }
}

export function throwIfCliClientUpgradeRequired(status: number, payload: unknown): void {
    if (status !== 426) return;
    const parsed = readCliClientUpgradeRequired(payload);
    if (parsed) throw new CliClientUpgradeRequiredError(parsed);
}
