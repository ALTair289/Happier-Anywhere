import { describe, expect, it } from "vitest";

import { buildRuntimeActivityOwnerSequenceCas } from "./runtimeActivityStorage";

describe("runtime activity v2 storage transaction guards", () => {
    it("fences both lifecycle sequence and compaction watermark on owner persistence", () => {
        expect(buildRuntimeActivityOwnerSequenceCas({ ownerSequence: 7, lowWatermark: 4 })).toEqual({
            ownerSequence: 7n,
            lowWatermark: 4n,
        });
    });
});
