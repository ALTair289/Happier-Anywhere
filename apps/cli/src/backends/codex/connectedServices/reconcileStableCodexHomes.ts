import { readdir, readFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';

import { AGENTS_CORE } from '@happier-dev/agents';
import type { ConnectedServiceCredentialRecordV1, ConnectedServiceId } from '@happier-dev/protocol';

import { resolveConnectedServiceHomeDir } from '@/daemon/connectedServices/homes/resolveConnectedServiceHomeDir';
import { computeConnectedServiceAccessTokenFingerprint } from '@/daemon/connectedServices/refresh/credentialFreshness/tokenFingerprint';
import type { ConnectedServiceStableHomeReconcileResult } from '@/daemon/connectedServices/credentials/lifecycleTypes';
import { logger } from '@/ui/logger';
import { writeCodexAuthStoreFile } from './writeCodexAuthStoreFile';

const CONNECTED_SERVICE_GROUPS_HOME_SEGMENT = '__groups';

type ResolveStoreCredentialRecordForProfile = (binding: Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
}>) => Promise<ConnectedServiceCredentialRecordV1 | null>;

/**
 * A codex auth store is well-formed only when `last_refresh` is an RFC-3339 timestamp string and a
 * `tokens.access_token` is present. The triage #4 poison stored `last_refresh` as epoch millis
 * (number or numeric string), which codex-cli 0.142.3's strict RFC-3339 parser rejects on spawn.
 */
function readAuthStoreState(raw: unknown): Readonly<{ formatValid: boolean; accessToken: string | null }> {
  if (!raw || typeof raw !== 'object') return { formatValid: false, accessToken: null };
  const value = raw as { last_refresh?: unknown; access_token?: unknown; tokens?: unknown };
  const tokens = value.tokens && typeof value.tokens === 'object'
    ? (value.tokens as { access_token?: unknown })
    : null;
  const accessToken = typeof tokens?.access_token === 'string' && tokens.access_token.length > 0
    ? tokens.access_token
    : (typeof value.access_token === 'string' && value.access_token.length > 0 ? value.access_token : null);
  const lastRefreshValid = typeof value.last_refresh === 'string'
    && value.last_refresh.trim().length > 0
    && !Number.isNaN(Date.parse(value.last_refresh));
  const formatValid = lastRefreshValid && tokens !== null && accessToken !== null;
  return { formatValid, accessToken };
}

async function listStableProfileIds(input: Readonly<{
  activeServerDir: string;
  serviceId: ConnectedServiceId;
}>): Promise<readonly string[]> {
  const serviceRoot = join(input.activeServerDir, 'daemon', 'connected-services', 'homes', input.serviceId);
  let entries: Dirent[];
  try {
    entries = await readdir(serviceRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== CONNECTED_SERVICE_GROUPS_HOME_SEGMENT)
    .map((entry) => entry.name);
}

/**
 * Format+freshness-reconcile every EXISTING stable codex home (triage #4 systemic leg). Stable codex
 * homes are not refresh-target bound, so nothing else revisits them: historical malformed stores
 * persisted, and after a store rotation the on-disk home drifted stale. For each home this rewrites
 * — via the canonical {@link writeCodexAuthStoreFile} — whenever the auth store is malformed OR its
 * access-token fingerprint no longer matches the current store record. Fails CLOSED: a home with no
 * resolvable/oauth store record is left untouched (never clobbered with an empty/wrong credential).
 */
export async function reconcileStableCodexHomesAtStartup(input: Readonly<{
  activeServerDir: string;
  now: number;
  resolveStoreCredentialRecordForProfile: ResolveStoreCredentialRecordForProfile;
}>): Promise<ConnectedServiceStableHomeReconcileResult> {
  let scanned = 0;
  let rewritten = 0;

  for (const serviceId of AGENTS_CORE.codex.connectedServices.supportedServiceIds) {
    for (const profileId of await listStableProfileIds({ activeServerDir: input.activeServerDir, serviceId })) {
      const rootDir = resolveConnectedServiceHomeDir({
        activeServerDir: input.activeServerDir,
        serviceId,
        profileId,
        agentId: 'codex',
      });
      const codexHome = join(rootDir, 'codex-home');
      const authStorePath = join(codexHome, 'auth.json');

      let rawContent: string;
      try {
        rawContent = await readFile(authStorePath, 'utf8');
      } catch {
        // No stable auth store for this profile — nothing to reconcile (materialization owns creation).
        continue;
      }
      scanned += 1;

      let parsed: unknown = null;
      try {
        parsed = JSON.parse(rawContent);
      } catch {
        parsed = null;
      }
      const { formatValid, accessToken } = readAuthStoreState(parsed);

      // Resolve the current store record; fail closed when unavailable or non-oauth so we never
      // clobber a home we cannot source from the canonical credential.
      const record = await input.resolveStoreCredentialRecordForProfile({ serviceId, profileId }).catch(() => null);
      if (!record || record.kind !== 'oauth') continue;
      const storeFingerprint = computeConnectedServiceAccessTokenFingerprint(record.oauth.accessToken);
      const homeFingerprint = accessToken ? computeConnectedServiceAccessTokenFingerprint(accessToken) : null;

      const needsRewrite = !formatValid || homeFingerprint !== storeFingerprint;
      if (!needsRewrite) continue;

      try {
        await writeCodexAuthStoreFile({ codexHome, record });
        rewritten += 1;
        logger.debug('[DAEMON RUN] Reconciled stable codex home', {
          serviceId,
          profileId,
          reason: !formatValid ? 'malformed_auth_store' : 'store_fingerprint_mismatch',
        });
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to reconcile stable codex home', { serviceId, profileId, error });
      }
    }
  }

  return { scanned, rewritten };
}
