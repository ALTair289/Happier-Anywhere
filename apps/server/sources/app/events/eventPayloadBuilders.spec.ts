import { describe, expect, it } from "vitest";

import { buildMessageUpdatedUpdate, buildNewMessageUpdate } from "./eventPayloadBuilders";

function buildMessageInput(content: unknown) {
    return {
        id: "m1",
        seq: 7,
        content,
        localId: "local-1",
        createdAt: new Date("2020-01-01T00:00:00.000Z"),
        updatedAt: new Date("2020-01-01T00:00:00.000Z"),
    };
}

function readMessagePayload(payload: { body: unknown }): { attentionImpact?: unknown } {
    return (payload.body as { message: { attentionImpact?: unknown } }).message;
}

describe("message update payload attentionImpact", () => {
    it("keeps the explicit write-time attentionImpact when provided", () => {
        const payload = buildNewMessageUpdate(
            buildMessageInput({ t: "encrypted", c: "ciphertext" }),
            "s1",
            1,
            "u1",
            { attentionImpact: { affectsUnread: false, affectsMeaningfulActivity: false } },
        );
        expect(readMessagePayload(payload).attentionImpact).toEqual({
            affectsUnread: false,
            affectsMeaningfulActivity: false,
        });
    });

    it("derives default user attention for encrypted content when no explicit impact was provided", () => {
        const payload = buildNewMessageUpdate(
            buildMessageInput({ t: "encrypted", c: "ciphertext" }),
            "s1",
            1,
            "u1",
        );
        expect(readMessagePayload(payload).attentionImpact).toEqual({
            affectsUnread: true,
            affectsMeaningfulActivity: true,
        });
    });

    it("derives quiet attention for plaintext maintenance agent events when no explicit impact was provided", () => {
        const payload = buildNewMessageUpdate(
            buildMessageInput({
                t: "plain",
                v: {
                    role: "agent",
                    content: {
                        type: "event",
                        id: "quota-wait-event",
                        data: {
                            type: "provider-quota-wait",
                            serviceId: "openai-codex",
                            groupId: "main",
                            resetAtMs: 1_900_000,
                            reason: "connected_service_group_quota_exhausted",
                        },
                    },
                },
            }),
            "s1",
            1,
            "u1",
        );
        expect(readMessagePayload(payload).attentionImpact).toEqual({
            affectsUnread: false,
            affectsMeaningfulActivity: false,
        });
    });

    it("derives attentionImpact for message-updated payloads too", () => {
        const payload = buildMessageUpdatedUpdate(
            buildMessageInput({ t: "encrypted", c: "ciphertext" }),
            "s1",
            1,
            "u1",
        );
        expect(readMessagePayload(payload).attentionImpact).toEqual({
            affectsUnread: true,
            affectsMeaningfulActivity: true,
        });
    });
});
