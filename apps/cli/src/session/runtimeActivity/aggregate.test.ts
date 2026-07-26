import { SESSION_RUNTIME_ACTIVITY_ACTIVE_COUNT_MAX } from "@happier-dev/protocol";
import { describe, expect, it } from "vitest";

import { aggregateSessionRuntimeActivityContributions } from "./aggregate";
import {
    SessionRuntimeActivityContributionSchema,
    type SessionRuntimeActivityContribution,
} from "./types";

const idle = (): SessionRuntimeActivityContribution => ({
    state: "idle",
    activeCount: 0,
});

const unknown = (): SessionRuntimeActivityContribution => ({
    state: "unknown",
    activeCount: 0,
});

const active = (activeCount: number): SessionRuntimeActivityContribution => ({
    state: "active",
    activeCount,
});

describe("aggregateSessionRuntimeActivityContributions", () => {
    it("reduces sealed applicability using active-over-unknown algebra", () => {
        expect(aggregateSessionRuntimeActivityContributions([])).toEqual({ state: "idle", activeCount: 0 });
        expect(aggregateSessionRuntimeActivityContributions([idle(), unknown()])).toEqual({ state: "unknown", activeCount: 0 });
        expect(aggregateSessionRuntimeActivityContributions([unknown(), active(2), idle()])).toEqual({ state: "active", activeCount: 2 });
        expect(aggregateSessionRuntimeActivityContributions([active(2), active(3)])).toEqual({ state: "active", activeCount: 5 });
        expect(aggregateSessionRuntimeActivityContributions([active(2), active(3)]))
            .toEqual({ state: "active", activeCount: 5 });
    });

    it("is order independent and returns an output detached from mutable inputs", () => {
        const first = active(2) as {
            state: "active";
            activeCount: number;
        };
        const second = active(3);

        const aggregate = aggregateSessionRuntimeActivityContributions([first, second]);
        expect(aggregateSessionRuntimeActivityContributions([second, first])).toEqual(aggregate);

        first.activeCount = 99;
        expect(aggregate).toEqual({ state: "active", activeCount: 5 });
    });

    it("accepts the exact aggregate maximum and rejects overflow before addition", () => {
        expect(aggregateSessionRuntimeActivityContributions([
            active(SESSION_RUNTIME_ACTIVITY_ACTIVE_COUNT_MAX),
            idle(),
            unknown(),
        ])).toEqual({ state: "active", activeCount: SESSION_RUNTIME_ACTIVITY_ACTIVE_COUNT_MAX });

        expect(() => aggregateSessionRuntimeActivityContributions([
            active(SESSION_RUNTIME_ACTIVITY_ACTIVE_COUNT_MAX),
            active(1),
        ])).toThrow(RangeError);
    });

    it.each([
        { state: "active", activeCount: 1, sourceClass: "mixed" },
        { state: "active", activeCount: 1, sourceClass: "invalid_source" },
        { state: "active", activeCount: 0 },
        { state: "idle", activeCount: 1 },
        { state: "unknown", activeCount: 1 },
        { state: "idle", activeCount: 0, extra: true },
        { state: "active", activeCount: -1 },
        { state: "active", activeCount: 1.5 },
        { state: "active", activeCount: Number.MAX_SAFE_INTEGER + 1 },
    ])("rejects an extra-field or contradictory contribution: $state/$activeCount", (value) => {
        expect(SessionRuntimeActivityContributionSchema.safeParse(value).success).toBe(false);
    });
});
