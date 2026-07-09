import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import { reconcileStableCodexHomesAtStartup } from './reconcileStableCodexHomes';

const now = 1_000_000;

function storeRecord(accessToken: string): ConnectedServiceCredentialRecordV1 {
  return buildConnectedServiceCredentialRecord({
    now,
    serviceId: 'openai-codex',
    profileId: 'work',
    kind: 'oauth',
    expiresAt: now + 10 * 60_000,
    oauth: {
      accessToken,
      refreshToken: 'store-refresh',
      idToken: null,
      scope: 'openid',
      tokenType: 'Bearer',
      providerAccountId: 'acct',
      providerEmail: 'user@example.com',
    },
  });
}

async function makeCodexHome(activeServerDir: string, profileId: string, authStore: unknown): Promise<string> {
  const codexHome = join(activeServerDir, 'daemon', 'connected-services', 'homes', 'openai-codex', profileId, 'codex', 'codex-home');
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, 'auth.json'), JSON.stringify(authStore), 'utf8');
  return codexHome;
}

async function readAuthStore(codexHome: string): Promise<any> {
  return JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8'));
}

describe('reconcileStableCodexHomesAtStartup', () => {
  it('rewrites a malformed auth store (epoch-millis last_refresh) from the current store record', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-codex-reconcile-malformed-'));
    const codexHome = await makeCodexHome(activeServerDir, 'work', {
      auth_mode: 'chatgpt',
      access_token: 'home-access',
      tokens: { access_token: 'home-access', refresh_token: 'r', id_token: null, account_id: 'acct' },
      last_refresh: 1718611200000, // epoch millis — codex-cli 0.142.3 rejects this
    });
    const resolveStoreCredentialRecordForProfile = vi.fn(async () => storeRecord('home-access'));

    const result = await reconcileStableCodexHomesAtStartup({
      activeServerDir,
      now,
      resolveStoreCredentialRecordForProfile,
    });

    expect(result).toEqual({ scanned: 1, rewritten: 1 });
    const store = await readAuthStore(codexHome);
    expect(typeof store.last_refresh).toBe('string');
    expect(Number.isNaN(Date.parse(store.last_refresh))).toBe(false);
    expect(store.tokens.access_token).toBe('home-access');
  });

  it('rewrites a well-formed home whose access token no longer matches the store record (freshness)', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-codex-reconcile-stale-'));
    const codexHome = await makeCodexHome(activeServerDir, 'work', {
      auth_mode: 'chatgpt',
      access_token: 'stale-home-access',
      tokens: { access_token: 'stale-home-access', refresh_token: 'r', id_token: null, account_id: 'acct' },
      last_refresh: new Date(now).toISOString(),
    });
    const resolveStoreCredentialRecordForProfile = vi.fn(async () => storeRecord('fresh-store-access'));

    const result = await reconcileStableCodexHomesAtStartup({
      activeServerDir,
      now,
      resolveStoreCredentialRecordForProfile,
    });

    expect(result).toEqual({ scanned: 1, rewritten: 1 });
    const store = await readAuthStore(codexHome);
    expect(store.tokens.access_token).toBe('fresh-store-access');
  });

  it('does not rewrite a well-formed home that already matches the store record', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-codex-reconcile-match-'));
    const codexHome = await makeCodexHome(activeServerDir, 'work', {
      auth_mode: 'chatgpt',
      access_token: 'same-access',
      tokens: { access_token: 'same-access', refresh_token: 'r', id_token: null, account_id: 'acct' },
      last_refresh: new Date(now).toISOString(),
    });
    const before = await readAuthStore(codexHome);
    const resolveStoreCredentialRecordForProfile = vi.fn(async () => storeRecord('same-access'));

    const result = await reconcileStableCodexHomesAtStartup({
      activeServerDir,
      now,
      resolveStoreCredentialRecordForProfile,
    });

    expect(result).toEqual({ scanned: 1, rewritten: 0 });
    expect(await readAuthStore(codexHome)).toEqual(before);
  });

  it('fails closed: leaves a malformed home untouched when no store record is resolvable', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-codex-reconcile-failclosed-'));
    const poisoned = {
      auth_mode: 'chatgpt',
      access_token: 'home-access',
      tokens: { access_token: 'home-access', refresh_token: 'r', id_token: null, account_id: 'acct' },
      last_refresh: 1718611200000,
    };
    const codexHome = await makeCodexHome(activeServerDir, 'work', poisoned);
    const resolveStoreCredentialRecordForProfile = vi.fn(async () => null);

    const result = await reconcileStableCodexHomesAtStartup({
      activeServerDir,
      now,
      resolveStoreCredentialRecordForProfile,
    });

    expect(result).toEqual({ scanned: 1, rewritten: 0 });
    expect(await readAuthStore(codexHome)).toEqual(poisoned);
  });

  it('reports nothing scanned when there are no stable codex homes', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-codex-reconcile-empty-'));
    const resolveStoreCredentialRecordForProfile = vi.fn(async () => storeRecord('x'));
    const result = await reconcileStableCodexHomesAtStartup({
      activeServerDir,
      now,
      resolveStoreCredentialRecordForProfile,
    });
    expect(result).toEqual({ scanned: 0, rewritten: 0 });
    expect(resolveStoreCredentialRecordForProfile).not.toHaveBeenCalled();
  });
});
