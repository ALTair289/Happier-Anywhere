import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { writeCodexAuthStoreFile } from './writeCodexAuthStoreFile';

describe('writeCodexAuthStoreFile', () => {
  it('writes last_refresh as RFC 3339 — codex-cli >= 0.142 rejects epoch numbers (published contract)', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-auth-store-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000_000,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 2_000_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: 'id',
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    await writeCodexAuthStoreFile({ codexHome, record });

    const written = JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8')) as {
      last_refresh: unknown;
      tokens: { account_id: unknown };
    };
    // A mid-June 2026 writer regression stored epoch millis here, which codex-cli 0.142.3
    // rejects at parse time — every direct spawn from a managed home failed. Pin the contract.
    expect(typeof written.last_refresh).toBe('string');
    expect(written.last_refresh).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u);
    expect(Number.isNaN(Date.parse(written.last_refresh as string))).toBe(false);
    expect(written.tokens.account_id).toBe('acct');
  });
});
