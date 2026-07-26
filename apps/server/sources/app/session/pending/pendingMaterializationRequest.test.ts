import { describe, expect, it } from "vitest";

import { parsePendingMaterializeDeliveryTiming } from "./pendingMaterializationRequest";

describe("parsePendingMaterializeDeliveryTiming", () => {
    it.each([
        [{}, { status: "absent" }],
        [{ deliveryTiming: "after_foreground_ready" }, { status: "valid", value: "after_foreground_ready" }],
        [{ deliveryTiming: "after_runtime_idle" }, { status: "valid", value: "after_runtime_idle" }],
        [{ deliveryTiming: null }, { status: "invalid" }],
        [{ deliveryTiming: "" }, { status: "invalid" }],
        [{ deliveryTiming: 42 }, { status: "invalid" }],
    ] as const)("distinguishes timing presence for %j", (input, expected) => {
        expect(parsePendingMaterializeDeliveryTiming(input)).toEqual(expected);
    });
});
