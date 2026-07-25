import * as privacyKit from "privacy-kit";
import {
    parsePublicShareEncryptedDataKeyEnvelopeV0,
} from "@happier-dev/protocol";

export type EncryptedDataKeyEnvelopeV1ParseResult =
    | Readonly<{ type: "ok"; encryptedDataKey: Uint8Array<ArrayBuffer> }>
    | Readonly<{ type: "error"; error: "Invalid encryptedDataKey" }>;

function copyToArrayBufferBackedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy;
}

function parseEncryptedDataKeyEnvelopeV1Bytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    // The public-share writer/viewer contract is token-derived SecretBox. The protocol owner
    // accepts both deployed writer shapes (legacy JSON and current serialized JSON).
    if (parsePublicShareEncryptedDataKeyEnvelopeV0(bytes)) {
        return copyToArrayBufferBackedBytes(bytes);
    }
    throw new Error("Invalid encryptedDataKey envelope");
}

export function tryParseEncryptedDataKeyEnvelopeV1(
    encryptedDataKeyBase64: string,
): EncryptedDataKeyEnvelopeV1ParseResult {
    try {
        return {
            type: "ok",
            encryptedDataKey: parseEncryptedDataKeyEnvelopeV1Bytes(privacyKit.decodeBase64(encryptedDataKeyBase64)),
        };
    } catch {
        return { type: "error", error: "Invalid encryptedDataKey" };
    }
}

export function tryParsePersistedEncryptedDataKeyEnvelopeV1(
    encryptedDataKey: Uint8Array | null | undefined,
): EncryptedDataKeyEnvelopeV1ParseResult {
    try {
        if (!encryptedDataKey) {
            throw new Error("Missing encryptedDataKey");
        }
        return { type: "ok", encryptedDataKey: parseEncryptedDataKeyEnvelopeV1Bytes(encryptedDataKey) };
    } catch {
        return { type: "error", error: "Invalid encryptedDataKey" };
    }
}
