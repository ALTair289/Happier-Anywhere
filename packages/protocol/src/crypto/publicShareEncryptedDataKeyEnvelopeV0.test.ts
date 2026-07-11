import { describe, expect, it } from 'vitest';

import {
  parsePublicShareEncryptedDataKeyEnvelopeV0,
  PUBLIC_SHARE_ENCRYPTED_DATA_KEY_CURRENT_V0_BYTES,
  PUBLIC_SHARE_ENCRYPTED_DATA_KEY_LEGACY_V0_BYTES,
} from './publicShareEncryptedDataKeyEnvelopeV0.js';

describe('public share encrypted data-key envelope v0', () => {
  it('accepts only the legacy and current deployed SecretBox shapes', () => {
    expect(PUBLIC_SHARE_ENCRYPTED_DATA_KEY_LEGACY_V0_BYTES).toBe(103);
    expect(PUBLIC_SHARE_ENCRYPTED_DATA_KEY_CURRENT_V0_BYTES).toBe(165);
    expect(parsePublicShareEncryptedDataKeyEnvelopeV0(new Uint8Array(103))?.format).toBe('legacy-json');
    expect(parsePublicShareEncryptedDataKeyEnvelopeV0(new Uint8Array(165))?.format).toBe('serialized-json-v1');
    expect(parsePublicShareEncryptedDataKeyEnvelopeV0(new Uint8Array(105))).toBeNull();
    expect(parsePublicShareEncryptedDataKeyEnvelopeV0(new Uint8Array(0))).toBeNull();
  });
});
