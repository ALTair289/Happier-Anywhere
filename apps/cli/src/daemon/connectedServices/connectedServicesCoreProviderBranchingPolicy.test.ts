import { readdir, readFile } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const daemonConnectedServicesRoot = fileURLToPath(new URL('.', import.meta.url));
const daemonStartFile = fileURLToPath(new URL('../startDaemon.ts', import.meta.url));
const backendsConnectedServicesRoot = fileURLToPath(
  new URL('../../backends/connectedServices/', import.meta.url),
);

const providerOrServiceIdPattern =
  /(['"])(codex|claude|opencode|gemini|pi|openai-codex|claude-subscription|github|anthropic|openai)\1/gu;
const providerBackendImportPattern =
  /from\s+(['"])@\/backends\/(codex|claude|opencode|gemini|pi)(?:\/|\1)/gu;
const providerPersistedSessionMetadataPattern =
  /\b(codex|claude|opencode|gemini|pi)SessionFile\b/gu;
const providerQuotaEndpointLiteralPattern =
  /(chatgpt\.com\/backend-api\/wham|api\.anthropic\.com\/api\/oauth|HAPPIER_CONNECTED_SERVICES_(?:OPENAI_CODEX|CLAUDE_SUBSCRIPTION|ANTHROPIC)_[A-Z0-9_]*(?:USAGE_URL|RESET_CREDITS_URL|QUOTA_ENDPOINT|USER_AGENT))/gu;
const providerQuotaLeafImportPattern =
  /from\s+(['"]).*\/(?:claudeSubscriptionQuotaFetcher|geminiQuotaFetcher|openAiCodexQuotaFetcher|quotaFetcher)\1/gu;

/**
 * Documented provider-owned seams in the daemon `connectedServices` core.
 *
 * Paths are relative to `daemonConnectedServicesRoot`.
 */
const allowedDaemonProviderLiteralFiles: Readonly<Record<string, string>> = {
  'descriptors/connectedAccountDescriptors.ts':
    'canonical connected-account descriptors own service ids and OAuth defaults',
  'github/githubConnectedAccountTarget.ts':
    'provider-owned GitHub connected-account target owns the GitHub service id',
  'notifications/dispatchConnectedServiceAccountSwitchNotification.ts':
    'notification copy maps canonical service ids to product display names',
  'refresh/ConnectedServiceRefreshCoordinator.ts':
    'Codex app-server ChatGPT bridge refresh is the central daemon lifecycle entrypoint for openai-codex',
  'refresh/serviceRefreshers.ts':
    'central OAuth refreshers own service-id to provider OAuth metadata mapping',
  'shared/oauthConfig.ts':
    'legacy OAuth config accessors intentionally wrap canonical service descriptors',
};

/**
 * Documented provider-owned seams in the shared `backends/connectedServices` core.
 *
 * Paths are relative to `backendsConnectedServicesRoot`. This path is the K4 acceptance scope:
 * after the catalog-hook dispatch refactor it must hold NO provider/service-id literals, so this
 * allowlist is intentionally empty.
 */
const allowedBackendsProviderLiteralFiles: Readonly<Record<string, string>> = {};

const scannedRoots: ReadonlyArray<Readonly<{
  label: string;
  root: string;
  allowed: Readonly<Record<string, string>>;
}>> = [
  {
    label: 'daemon connectedServices',
    root: daemonConnectedServicesRoot,
    allowed: allowedDaemonProviderLiteralFiles,
  },
  {
    label: 'backends connectedServices',
    root: backendsConnectedServicesRoot,
    allowed: allowedBackendsProviderLiteralFiles,
  },
];

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = `${dir}${sep}${entry.name}`;
    if (entry.isDirectory()) return await listSourceFiles(fullPath);
    if (!entry.isFile()) return [];
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return [];
    return [fullPath];
  }));
  return files.flat();
}

async function collectProviderLiteralViolations(scope: Readonly<{
  root: string;
  allowed: Readonly<Record<string, string>>;
}>): Promise<string[]> {
  const files = await listSourceFiles(scope.root);
  const violations: string[] = [];

  for (const file of files) {
    const relativePath = relative(scope.root, file).split(sep).join('/');
    if (scope.allowed[relativePath]) continue;

    const source = await readFile(file, 'utf8');
    const matches = Array.from(source.matchAll(providerOrServiceIdPattern), (match) => match[2]);
    const providerImports = Array.from(source.matchAll(providerBackendImportPattern), (match) => `@/backends/${match[2]}`);
    if (matches.length === 0 && providerImports.length === 0) continue;

    violations.push(`${relativePath}: ${Array.from(new Set([...matches, ...providerImports])).join(', ')}`);
  }

  return violations;
}

describe('connected-services shared core provider branching policy', () => {
  it.each(scannedRoots)(
    'keeps provider and service ids out of $label shared core except documented provider-owned seams',
    async (scope) => {
      const violations = await collectProviderLiteralViolations(scope);
      expect(violations).toEqual([]);
    },
  );

  it('keeps provider persisted-session metadata field reads out of daemon spawn core', async () => {
    const source = await readFile(daemonStartFile, 'utf8');
    const matches = Array.from(
      source.matchAll(providerPersistedSessionMetadataPattern),
      (match) => match[0],
    );

    expect(Array.from(new Set(matches))).toEqual([]);
  });

  it('keeps provider quota endpoint literals and leaf imports out of the generic quota fetcher factory', async () => {
    const factoryPath = fileURLToPath(new URL('quotas/createConnectedServiceQuotaFetchers.ts', import.meta.url));
    const source = await readFile(factoryPath, 'utf8');
    const endpointLiterals = Array.from(
      source.matchAll(providerQuotaEndpointLiteralPattern),
      (match) => match[0],
    );
    const providerLeafImports = Array.from(
      source.matchAll(providerQuotaLeafImportPattern),
      (match) => match[0],
    );

    expect({
      endpointLiterals: Array.from(new Set(endpointLiterals)),
      providerLeafImports: Array.from(new Set(providerLeafImports)),
    }).toEqual({
      endpointLiterals: [],
      providerLeafImports: [],
    });
  });
});
