export type PendingTerminalPairing = Readonly<{
    secretB64Url: string;
    createdAtMs: number;
    expiresAtMs: number;
}>;

export type PendingTerminalConnect = Readonly<{
    publicKeyB64Url: string;
    serverUrl: string;
    pairing?: PendingTerminalPairing;
}>;

export type PendingTerminalConnectRecord = Readonly<{
    publicKeyB64Url: string;
    serverUrl: string;
    createdAtMs: number;
    pairing?: PendingTerminalPairing;
}>;

const DEFAULT_TTL_MS = 10 * 60 * 1000;

function readTtlFromEnv(): number {
    const raw = String(process.env.EXPO_PUBLIC_PENDING_TERMINAL_CONNECT_TTL_MS ?? '').trim();
    if (!raw) return DEFAULT_TTL_MS;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_TTL_MS;
    return Math.floor(value);
}

const ttlMs = readTtlFromEnv();

function normalizePairing(value: unknown): PendingTerminalPairing | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    const secretB64Url = String(record.secretB64Url ?? '').trim();
    const createdAtMs = Number(record.createdAtMs);
    const expiresAtMs = Number(record.expiresAtMs);
    if (
        !secretB64Url
        || !Number.isSafeInteger(createdAtMs)
        || !Number.isSafeInteger(expiresAtMs)
        || createdAtMs < 0
        || expiresAtMs <= createdAtMs
    ) {
        return undefined;
    }
    return { secretB64Url, createdAtMs, expiresAtMs };
}

export function toRecord(value: PendingTerminalConnect): PendingTerminalConnectRecord | null {
    const publicKeyB64Url = String(value?.publicKeyB64Url ?? '').trim();
    const serverUrl = String(value?.serverUrl ?? '').trim();
    if (!publicKeyB64Url || !serverUrl) return null;
    const pairing = normalizePairing(value.pairing);
    return {
        publicKeyB64Url,
        serverUrl,
        createdAtMs: Date.now(),
        ...(pairing ? { pairing } : {}),
    };
}

export function fromRecord(value: unknown): PendingTerminalConnect | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const publicKeyB64Url = String(record.publicKeyB64Url ?? '').trim();
    const serverUrl = String(record.serverUrl ?? '').trim();
    const createdAtMs = Number(record.createdAtMs ?? 0);
    if (!publicKeyB64Url || !serverUrl || !Number.isFinite(createdAtMs) || createdAtMs <= 0) return null;
    if (Date.now() - createdAtMs > ttlMs) return null;
    const pairing = normalizePairing(record.pairing);
    return {
        publicKeyB64Url,
        serverUrl,
        ...(pairing ? { pairing } : {}),
    };
}
