import { describe, expect, it } from "vitest";

import { readStoredSessionRuntimeActivityProjectionV2 } from "./readProjection";

describe("readStoredSessionRuntimeActivityProjectionV2", () => {
    it("reads a valid v2 projection before legacy lease fields", () => {
        expect(readStoredSessionRuntimeActivityProjectionV2({
            availability: "v2",
            nowMs: 50_000,
            row: {
                runtimeActivityVersion: 2,
                runtimeActivityState: "active",
                runtimeActivityActiveCount: 2,
                runtimeActivityObservedAt: 10_000n,
                runtimeActivityExpiresAt: null,
                runtimeActivitySourceClass: "provider_detached_task",
                runtimeActivityRevision: 7n,
            },
        })).toEqual({
            source: "v2",
            projection: {
                v: 2,
                state: "active",
                activeCount: 2,
                sourceClass: "provider_detached_task",
                observedAtMs: 10_000,
                revision: 7,
            },
        });
    });

    it("maps an elapsed v1 lease to unknown and never to idle", () => {
        expect(readStoredSessionRuntimeActivityProjectionV2({
            availability: "v1",
            nowMs: 50_000,
            row: {
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: 10_000n,
                runtimeActivityExpiresAt: 20_000n,
                runtimeActivitySourceClass: "provider_detached_task",
            },
        })).toMatchObject({ source: "v1", projection: { state: "unknown", activeCount: 0 } });
    });

    it("keeps a no-runtime-schema fallback distinct instead of fabricating state", () => {
        expect(readStoredSessionRuntimeActivityProjectionV2({
            availability: "none",
            nowMs: 50_000,
            row: {},
        })).toEqual({ source: "none", projection: null });
    });
});
