import type { SessionRuntimeActivitySourceClassV1 } from '@happier-dev/protocol';

export type SessionRuntimeActivityProjectionBase = Readonly<{
    runtimeActivityActiveCount?: number | null;
    runtimeActivityObservedAt?: number | null;
    runtimeActivityExpiresAt?: number | null;
    runtimeActivitySourceClass?: SessionRuntimeActivitySourceClassV1 | null;
}>;

export type SessionRuntimeActivityProjectionFields = Readonly<{
    runtimeActivityActiveCount: number;
    runtimeActivityObservedAt: number | null;
    runtimeActivityExpiresAt: number | null;
    runtimeActivitySourceClass: SessionRuntimeActivitySourceClassV1 | null;
}>;

export type SessionRuntimeActivityProjectionPatch = Partial<SessionRuntimeActivityProjectionFields>;

export function hasSessionRuntimeActivityProjectionFields(updateBody: unknown): boolean {
    if (!updateBody || typeof updateBody !== 'object') return false;
    return [
        'runtimeActivityActiveCount',
        'runtimeActivityObservedAt',
        'runtimeActivityExpiresAt',
        'runtimeActivitySourceClass',
    ].some((key) => Object.prototype.hasOwnProperty.call(updateBody, key));
}

export function resolveSessionRuntimeActivityProjectionFields(
    base: SessionRuntimeActivityProjectionBase,
    updateBody: unknown,
): SessionRuntimeActivityProjectionFields {
    const body = updateBody && typeof updateBody === 'object'
        ? updateBody as Record<string, unknown>
        : {};
    const activeCount = readNonNegativeInteger(body.runtimeActivityActiveCount)
        ?? readNonNegativeInteger(base.runtimeActivityActiveCount)
        ?? 0;
    const clear = activeCount === 0
        && Object.prototype.hasOwnProperty.call(body, 'runtimeActivityActiveCount');
    const observedAt = readNullableFiniteTimestamp(body.runtimeActivityObservedAt);
    const expiresAt = readNullableFiniteTimestamp(body.runtimeActivityExpiresAt);
    const sourceClass = readRuntimeActivitySourceClass(body.runtimeActivitySourceClass);

    return {
        runtimeActivityActiveCount: activeCount,
        runtimeActivityObservedAt: clear
            ? null
            : observedAt !== undefined
                ? observedAt
                : base.runtimeActivityObservedAt ?? null,
        runtimeActivityExpiresAt: clear
            ? null
            : expiresAt !== undefined
                ? expiresAt
                : base.runtimeActivityExpiresAt ?? null,
        runtimeActivitySourceClass: clear
            ? null
            : sourceClass !== undefined
                ? sourceClass
                : base.runtimeActivitySourceClass ?? null,
    };
}

export function buildSessionRuntimeActivityProjectionPatch(
    base: SessionRuntimeActivityProjectionBase,
    updateBody: unknown,
): SessionRuntimeActivityProjectionPatch {
    if (!hasSessionRuntimeActivityProjectionFields(updateBody)) return {};
    return resolveSessionRuntimeActivityProjectionFields(base, updateBody);
}

function readFiniteTimestamp(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.trunc(value)
        : undefined;
}

function readNullableFiniteTimestamp(value: unknown): number | null | undefined {
    if (value === null) return null;
    return readFiniteTimestamp(value);
}

function readNonNegativeInteger(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    return Math.max(0, Math.trunc(value));
}

function readRuntimeActivitySourceClass(value: unknown): SessionRuntimeActivitySourceClassV1 | null | undefined {
    if (value === null) return null;
    return value === 'provider_detached_task'
        || value === 'provider_autonomous_output'
        || value === 'mixed'
            ? value
            : undefined;
}
