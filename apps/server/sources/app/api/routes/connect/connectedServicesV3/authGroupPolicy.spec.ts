import { describe, expect, it } from "vitest";

import {
    DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
    parseConnectedServiceAuthGroupPolicyJson,
} from "./authGroupPolicy";

describe("parseConnectedServiceAuthGroupPolicyJson", () => {
    it("preserves canonical policy fields when stored JSON carries retired no-op keys", () => {
        const parsed = parseConnectedServiceAuthGroupPolicyJson(JSON.stringify({
            v: 1,
            strategy: "priority",
            autoSwitch: true,
            recoveryMode: "switch_or_wait",
            recoveryPromptMode: "standard",
            effectiveMeterStrategy: "most_constrained",
            memberRuntimeStatePersistence: "server_state_json",
        }));

        expect(parsed).toEqual(expect.objectContaining({
            strategy: "priority",
            autoSwitch: true,
            recoveryMode: "switch_or_wait",
        }));
        expect(parsed).not.toHaveProperty("recoveryPromptMode");
        expect(parsed).not.toHaveProperty("effectiveMeterStrategy");
        expect(parsed).not.toHaveProperty("memberRuntimeStatePersistence");
    });

    it("falls back to the fail-closed default for corrupt or unrelated unknown stored fields", () => {
        expect(parseConnectedServiceAuthGroupPolicyJson("{malformed")).toEqual(
            DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
        );
        expect(parseConnectedServiceAuthGroupPolicyJson(JSON.stringify({
            v: 1,
            autoSwitch: true,
            recoveryPromptMode: "standard",
            unrelatedUnknownField: true,
        }))).toEqual(DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1);
    });
});
