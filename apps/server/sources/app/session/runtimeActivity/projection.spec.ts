import { describe, expect, it } from "vitest";

import {
    parseSessionRuntimeActivitySnapshot,
    readStoredSessionRuntimeActivityProjection,
    readStoredSessionRuntimeActivityProjectionResult,
} from "./projection";

describe("session Runtime Activity projection boundary", () => {
    it("accepts only a strict, internally consistent complete snapshot", () => {
        expect(parseSessionRuntimeActivitySnapshot({
            state: "active",
            activeCount: 2,
        })).toEqual({
            state: "active",
            activeCount: 2,
        });

        for (const malformed of [
            { state: "active", activeCount: 0 },
            { state: "idle", activeCount: 1 },
            { state: "unknown", activeCount: 1 },
            { state: "active", activeCount: 2_147_483_648 },
            { state: "idle", activeCount: 0, revision: 1 },
        ]) {
            expect(() => parseSessionRuntimeActivitySnapshot(malformed)).toThrow();
        }
    });

    it("returns a valid stored projection exactly", () => {
        expect(readStoredSessionRuntimeActivityProjection({
            runtimeActivityState: "active",
            runtimeActivityActiveCount: 3,
            runtimeActivityObservedAt: 1234n,
            runtimeActivityRevision: 7n,
        })).toEqual({
            state: "active",
            activeCount: 3,
            observedAt: 1234,
            revision: 7,
        });
    });

    it("rejects malformed final storage instead of synthesizing unknown truth", () => {
        expect(() => readStoredSessionRuntimeActivityProjection({
            runtimeActivityState: "active",
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: 1234n,
            runtimeActivityRevision: 7n,
        })).toThrow("Invalid stored Session Runtime Activity projection");
    });

    it("distinguishes canonical unknown from malformed storage and preserves only a separately valid revision", () => {
        expect(readStoredSessionRuntimeActivityProjectionResult({
            runtimeActivityState: "unknown",
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: null,
            runtimeActivityRevision: 12n,
        })).toEqual({
            status: "valid",
            projection: {
                state: "unknown",
                activeCount: 0,
                observedAt: null,
                revision: 12,
            },
        });

        expect(readStoredSessionRuntimeActivityProjectionResult({
            runtimeActivityState: "unknown",
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: null,
            runtimeActivityRevision: 12n,
        })).toEqual({ status: "invalid", revision: 12 });

        expect(readStoredSessionRuntimeActivityProjectionResult({
            runtimeActivityState: "unknown",
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: -1n,
            runtimeActivityRevision: 12n,
        })).toEqual({ status: "invalid", revision: 12 });

        expect(readStoredSessionRuntimeActivityProjectionResult({
            runtimeActivityState: "unknown",
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: -1n,
            runtimeActivityRevision: -1n,
        })).toEqual({ status: "invalid", revision: null });
    });
});
