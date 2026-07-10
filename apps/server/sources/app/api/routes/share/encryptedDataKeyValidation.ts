import * as privacyKit from "privacy-kit";
import {
    BOX_BUNDLE_MIN_BYTES,
    ENCRYPTED_DATA_KEY_ENVELOPE_V1_VERSION_BYTE,
    parsePublicShareEncryptedDataKeyEnvelopeV0,
} from "@happier-dev/protocol";

const DATA_ENCRYPTION_KEY_BYTES = 32;
const ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES = 1 + BOX_BUNDLE_MIN_BYTES + DATA_ENCRYPTION_KEY_BYTES;

export type EncryptedDataKeyEnvelopeV1ParseResult =
    | Readonly<{ type: "ok"; encryptedDataKey: Uint8Array<ArrayBuffer> }>
    | Readonly<{ type: "error"; error: "Invalid encryptedDataKey" }>;

function copyToArrayBufferBackedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy;
}

function parseEncryptedDataKeyEnvelopeV1Bytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    // Public shares historically stored a token-derived SecretBox envelope. Newer shares use the
    // versioned box envelope used by session sharing. The server cannot decrypt either form, but
    // it can reject every shape except the two deployed SecretBox lengths and the fixed V1 shape.
    if (parsePublicShareEncryptedDataKeyEnvelopeV0(bytes)) {
        return copyToArrayBufferBackedBytes(bytes);
    }

    if (
        bytes.length !== ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES
        || bytes[0] !== ENCRYPTED_DATA_KEY_ENVELOPE_V1_VERSION_BYTE
    ) {
        throw new Error("Invalid encryptedDataKey envelope");
    }

    // A zero ephemeral public key can never be a valid box recipient and would create a share
    // that no viewer can decrypt. Reject this obvious malformed wire shape at the write boundary.
    const ephemeralPublicKey = bytes.subarray(1, 1 + 32);
    if (ephemeralPublicKey.every((byte) => byte === 0)) {
        throw new Error("Invalid encryptedDataKey envelope");
    }

    return copyToArrayBufferBackedBytes(bytes);
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
