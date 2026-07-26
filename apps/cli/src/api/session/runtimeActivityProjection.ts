import {
    parseSessionRuntimeActivityProjectionFields,
    type SessionRuntimeActivityState,
} from '@happier-dev/protocol';

export type SessionRuntimeActivityProjectionBoundary = Readonly<{
    runtimeActivityState?: SessionRuntimeActivityState | null;
    runtimeActivityActiveCount?: number;
    runtimeActivityObservedAt?: number | null;
    runtimeActivityRevision?: number;
}>;

/** Parses the final public Activity projection shape and fails closed to no evidence. */
export function readSessionRuntimeActivityProjectionBoundary(value: unknown): SessionRuntimeActivityProjectionBoundary {
    const parsed = parseSessionRuntimeActivityProjectionFields(value);
    if (parsed.kind !== 'valid') return {};
    return {
        runtimeActivityState: parsed.projection.state,
        runtimeActivityActiveCount: parsed.projection.activeCount,
        runtimeActivityObservedAt: parsed.projection.observedAt,
        runtimeActivityRevision: parsed.projection.revision,
    };
}

export function hasSessionRuntimeActivityProjectionBoundaryEvidence(
    projection: SessionRuntimeActivityProjectionBoundary,
): boolean {
    return projection.runtimeActivityState !== undefined;
}
