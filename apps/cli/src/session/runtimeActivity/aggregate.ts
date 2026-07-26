import {
    SESSION_RUNTIME_ACTIVITY_ACTIVE_COUNT_MAX,
    SessionRuntimeActivitySnapshotSchema,
    type SessionRuntimeActivitySnapshot,
} from "@happier-dev/protocol";

import {
    SessionRuntimeActivityContributionSchema,
    type SessionRuntimeActivityContribution,
} from "./types";

export function aggregateSessionRuntimeActivityContributions(
    contributions: readonly SessionRuntimeActivityContribution[],
): SessionRuntimeActivitySnapshot {
    let activeCount = 0;
    let hasUnknown = false;

    for (const rawContribution of contributions) {
        const contribution = SessionRuntimeActivityContributionSchema.parse(rawContribution);

        if (contribution.state === "unknown") {
            hasUnknown = true;
            continue;
        }
        if (contribution.state !== "active") {
            continue;
        }

        if (contribution.activeCount > SESSION_RUNTIME_ACTIVITY_ACTIVE_COUNT_MAX - activeCount) {
            throw new RangeError("Session runtime activity active count exceeds the public maximum");
        }
        activeCount += contribution.activeCount;

    }

    if (activeCount > 0) {
        return SessionRuntimeActivitySnapshotSchema.parse({
            state: "active",
            activeCount,
        });
    }

    return hasUnknown
        ? { state: "unknown", activeCount: 0 }
        : { state: "idle", activeCount: 0 };
}
