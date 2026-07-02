import { describe, expect, it } from "vitest";

import { createFakeRouteApp, getRouteEntry } from "../../testkit/routeHarness";

describe("sessionPendingRoutes rate limits", () => {
    it("registers pending routes with explicit rate limits", async () => {
        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const app = createFakeRouteApp();
        sessionPendingRoutes(app as any);
        for (const [method, path] of [
            ["GET", "/v2/sessions/:sessionId/pending"],
            ["POST", "/v2/sessions/:sessionId/pending"],
            ["PATCH", "/v2/sessions/:sessionId/pending/:localId"],
            ["DELETE", "/v2/sessions/:sessionId/pending/:localId"],
            ["POST", "/v2/sessions/:sessionId/pending/:localId/discard"],
            ["POST", "/v2/sessions/:sessionId/pending/:localId/restore"],
            ["POST", "/v2/sessions/:sessionId/pending/reorder"],
            ["POST", "/v2/sessions/:sessionId/pending/materialize-next"],
            ["POST", "/v2/sessions/:sessionId/pending/:localId/delivery/accepted"],
            ["POST", "/v2/sessions/:sessionId/pending/delivery/accepted-through-seq"],
            ["POST", "/v2/sessions/:sessionId/pending/delivery/provider-attach"],
            ["POST", "/v2/sessions/:sessionId/pending/:localId/delivery/block"],
            ["POST", "/v2/sessions/:sessionId/pending/:localId/delivery/retry"],
            ["POST", "/v2/sessions/:sessionId/pending/:localId/delivery/handled"],
        ] as const) {
            expect(getRouteEntry(app, method, path).opts.config?.rateLimit).toEqual(
                expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }),
            );
        }
    });
});
