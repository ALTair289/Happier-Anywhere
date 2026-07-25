import { afterEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { parseSerializedJsonValue } from '@happier-dev/protocol';

import { createRunDirs } from '../../src/testkit/runDir';
import { fetchJson } from '../../src/testkit/http';
import { createTestAuth } from '../../src/testkit/auth';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';

const run = createRunDirs({ runLabel: 'core' });

const RELEASED_PUBLIC_SHARE_VECTORS = [
  {
    name: 'current 165-byte writer',
    token: 'released-current-public-share-vector',
    dataKeyB64: 'IB8eHRwbGhkYFxYVFBMSERAPDg0MCwoJCAcGBQQDAgE=',
    envelopeB64:
      'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJRIYkKAXBR77d5HFP5Lil/o4VB5lvpZLQNo94yuThilYBtgQ9LbGUyV6dWcbPnLGHBPcxyNkBZf40BNOjG6UZHJeiKCEmhA0XoQPUg27S16lSOR18S2AquqS32k0IM423w3n9rcPLiwrLKN7Pw9JYN+Ubz8mNl4CQHdiIDyjQKosZbPxByuWtcw+kPOkR',
  },
  {
    name: 'legacy 103-byte preview writer',
    token: 'released-preview-public-share-vector',
    dataKeyB64: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=',
    envelopeB64:
      'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHMJ6ZwXvlgV+Ew6Jtlspr/Sg/SEHyrn8lcqu7Euram/O2gprQ7e4Fe1w3nB1i3RVUrT1cj9PUi4jF5+isG5G/WnzMt54qn3pC0aKPXk8e2w==',
  },
] as const;

function hmacSha512(key: Uint8Array, data: Uint8Array): Uint8Array {
  return new Uint8Array(
    createHmac('sha512', Buffer.from(key)).update(Buffer.from(data)).digest(),
  );
}

function derivePublicShareSecretBoxKey(token: string): Uint8Array {
  const encoder = new TextEncoder();
  const root = hmacSha512(
    encoder.encode('Happy Public Share Master Seed'),
    encoder.encode(token),
  );
  const child = hmacSha512(
    root.slice(32),
    new Uint8Array([0, ...encoder.encode('v1')]),
  );
  return child.slice(0, 32);
}

function openPublicShareDataKey(envelopeB64: string, token: string): Uint8Array | null {
  const envelope = new Uint8Array(Buffer.from(envelopeB64, 'base64'));
  const opened = tweetnacl.secretbox.open(
    envelope.slice(tweetnacl.secretbox.nonceLength),
    envelope.slice(0, tweetnacl.secretbox.nonceLength),
    derivePublicShareSecretBoxKey(token),
  );
  if (!opened) return null;
  const parsed = parseSerializedJsonValue(new TextDecoder().decode(opened)) as {
    v?: unknown;
    keyB64?: unknown;
  };
  return parsed?.v === 0 && typeof parsed.keyB64 === 'string'
    ? new Uint8Array(Buffer.from(parsed.keyB64, 'base64'))
    : null;
}

describe('core e2e: e2ee public share requires encryptedDataKey', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('round-trips every released SecretBox envelope and rejects missing/Box/decrypt-failure cases', async () => {
    const testDir = run.testDir('sharing-public-e2ee-encrypted-datakey-required');
    server = await startServerLight({ testDir });

    const auth = await createTestAuth(server.baseUrl);

    for (const [index, vector] of RELEASED_PUBLIC_SHARE_VECTORS.entries()) {
      const create = await fetchJson<any>(`${server.baseUrl}/v1/sessions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tag: `e2e-public-share-e2ee-${index}`,
          encryptionMode: 'e2ee',
          metadata: Buffer.from('cipher-meta', 'utf8').toString('base64'),
          agentState: null,
          dataEncryptionKey: Buffer.from('test-data-key', 'utf8').toString('base64'),
        }),
        timeoutMs: 15_000,
      });
      expect(create.status, vector.name).toBe(200);
      const sessionId = create.data?.session?.id;
      expect(typeof sessionId, vector.name).toBe('string');

      if (index === 0) {
        const missing = await fetchJson<any>(`${server.baseUrl}/v1/sessions/${sessionId}/public-share`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${auth.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ token: vector.token, isConsentRequired: false }),
          timeoutMs: 15_000,
        });
        expect(missing.status).toBe(400);

        const genericBox = await fetchJson<any>(`${server.baseUrl}/v1/sessions/${sessionId}/public-share`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${auth.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            token: vector.token,
            encryptedDataKey: Buffer.alloc(105, 1).toString('base64'),
            isConsentRequired: false,
          }),
          timeoutMs: 15_000,
        });
        expect(genericBox.status).toBe(400);
      }

      const createShare = await fetchJson<any>(`${server.baseUrl}/v1/sessions/${sessionId}/public-share`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          token: vector.token,
          encryptedDataKey: vector.envelopeB64,
          isConsentRequired: false,
        }),
        timeoutMs: 15_000,
      });
      expect(createShare.status, vector.name).toBe(200);

      const access = await fetchJson<any>(
        `${server.baseUrl}/v1/public-share/${encodeURIComponent(vector.token)}`,
        { timeoutMs: 15_000 },
      );
      expect(access.status, vector.name).toBe(200);
      expect(access.data?.encryptedDataKey).toBe(vector.envelopeB64);
      expect(openPublicShareDataKey(access.data.encryptedDataKey, vector.token)).toEqual(
        new Uint8Array(Buffer.from(vector.dataKeyB64, 'base64')),
      );
      expect(openPublicShareDataKey(access.data.encryptedDataKey, `${vector.token}-wrong`)).toBeNull();
    }
  }, 180_000);
});
