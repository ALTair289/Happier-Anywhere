import { describe, expect, it } from "vitest";
import { encodeBase64, stringifySerializedJsonValue } from "@happier-dev/protocol";

import {
    tryParseEncryptedDataKeyEnvelopeV1,
    tryParsePersistedEncryptedDataKeyEnvelopeV1,
} from "./encryptedDataKeyValidation";

function secretBoxEnvelopeBytes(serializedPayload: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array(24 + 16 + new TextEncoder().encode(serializedPayload).byteLength).fill(1);
}

const KEY_BASE64 = "A".repeat(44);
const LEGACY_ENCRYPTED_DATA_KEY = secretBoxEnvelopeBytes(JSON.stringify({ v: 0, keyB64: KEY_BASE64 }));
const CURRENT_ENCRYPTED_DATA_KEY = secretBoxEnvelopeBytes(
    stringifySerializedJsonValue({ v: 0, keyB64: KEY_BASE64 }),
);

describe("encrypted public-share data-key envelope validation", () => {
    it("rejects malformed base64, unrelated envelope shapes, and missing persisted envelopes", () => {
        expect(tryParseEncryptedDataKeyEnvelopeV1("not-valid-base64")).toEqual({
            type: "error",
            error: "Invalid encryptedDataKey",
        });
        expect(tryParseEncryptedDataKeyEnvelopeV1(encodeBase64(Uint8Array.from([0, 1, 2]), "base64"))).toEqual({
            type: "error",
            error: "Invalid encryptedDataKey",
        });
        expect(tryParseEncryptedDataKeyEnvelopeV1(encodeBase64(new Uint8Array(105), "base64"))).toEqual({
            type: "error",
            error: "Invalid encryptedDataKey",
        });
        expect(tryParsePersistedEncryptedDataKeyEnvelopeV1(null)).toEqual({
            type: "error",
            error: "Invalid encryptedDataKey",
        });
        const structurallyValidBoxEnvelope = new Uint8Array(105).fill(7);
        structurallyValidBoxEnvelope[0] = 0;
        expect(tryParseEncryptedDataKeyEnvelopeV1(
            encodeBase64(structurallyValidBoxEnvelope, "base64"),
        )).toEqual({
            type: "error",
            error: "Invalid encryptedDataKey",
        });
    });

    it("accepts current and legacy public-share SecretBox envelopes", () => {
        const encoded = tryParseEncryptedDataKeyEnvelopeV1(encodeBase64(CURRENT_ENCRYPTED_DATA_KEY, "base64"));
        const persisted = tryParsePersistedEncryptedDataKeyEnvelopeV1(LEGACY_ENCRYPTED_DATA_KEY);

        expect(encoded.type).toBe("ok");
        expect(persisted.type).toBe("ok");
        expect(encoded.type === "ok" ? encoded.encryptedDataKey : null).toEqual(CURRENT_ENCRYPTED_DATA_KEY);
        expect(persisted.type === "ok" ? persisted.encryptedDataKey : null).toEqual(LEGACY_ENCRYPTED_DATA_KEY);
    });
});
