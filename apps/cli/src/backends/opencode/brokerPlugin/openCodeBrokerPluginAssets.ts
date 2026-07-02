import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { configuration } from '@/configuration';

import {
  OPEN_CODE_BROKER_PROVIDERS,
  type OpenCodeBrokerProvider,
} from './openCodeBrokerPluginEnv';
import {
  buildOpenCodeBrokerPluginSource,
  OPEN_CODE_BROKER_PLUGIN_VERSION,
} from './openCodeBrokerPluginSource';

/**
 * Deterministic, version-keyed on-disk paths for the broker assets. They are derived purely from
 * `happyHomeDir` (a stable singleton) + the plugin version, so:
 *  - the materializer can REFERENCE the paths without any filesystem I/O (keeping it pure +
 *    overlay-safe for fingerprint computation), and
 *  - the server-launch path can WRITE the assets idempotently (live spawn only).
 */

/** Happier-owned, isolated OpenCode config home for connected sessions (no user 3rd-party plugins). */
export function resolveOpenCodeConnectedConfigHomeDir(happyHomeDir: string = configuration.happyHomeDir): string {
  return join(happyHomeDir, 'opencode', 'connected-config');
}

/**
 * OpenCode's plugin auto-discovery dir, RELATIVE TO the (redirected) `XDG_CONFIG_HOME`. Live-verified
 * against opencode v1.14.41: it scans `<XDG_CONFIG_HOME>/opencode/plugin/` (and `plugins/`) and loads
 * each plugin file from there. The broker plugin lives here so that pointing `XDG_CONFIG_HOME` at the
 * connected config home (config isolation) is sufficient to load it — no `OPENCODE_CONFIG_CONTENT`
 * registration is needed (and an absolute path in `config.plugin` does NOT load).
 */
export function resolveOpenCodeBrokerPluginDir(happyHomeDir: string = configuration.happyHomeDir): string {
  return join(resolveOpenCodeConnectedConfigHomeDir(happyHomeDir), 'opencode', 'plugin');
}

export function resolveOpenCodeBrokerPluginPath(
  provider: OpenCodeBrokerProvider,
  happyHomeDir: string = configuration.happyHomeDir,
): string {
  // MUST be `.js`: opencode v1.14.41's plugin auto-discovery globs `*.js` ONLY and ignores `*.mjs`
  // (live-verified head-to-head in the same dir). A `.mjs` broker file is silently never loaded.
  return join(resolveOpenCodeBrokerPluginDir(happyHomeDir), `happier-broker-${provider}-${OPEN_CODE_BROKER_PLUGIN_VERSION}.js`);
}

async function writeFileIfChanged(path: string, content: string): Promise<void> {
  const existing = await readFile(path, 'utf8').catch(() => null);
  if (existing === content) return;
  await writeFile(path, content, { mode: 0o600 });
}

/**
 * Idempotently materialize the broker assets for the given providers:
 *  - ensure the Happier-owned connected config home exists (isolated ⇒ no user 3rd-party plugins), and
 *  - write each provider's self-contained broker plugin `.js` file into the config home's
 *    `opencode/plugin/` auto-load dir so OpenCode discovers + loads it from the redirected
 *    `XDG_CONFIG_HOME` (live-verified mechanism; `.mjs` + `OPENCODE_CONFIG_CONTENT.plugin` do not load).
 *
 * Safe to call repeatedly (write-if-changed). Called from the live server-launch path only.
 */
export async function ensureOpenCodeBrokerPluginAssets(params: Readonly<{
  providers: readonly OpenCodeBrokerProvider[];
  happyHomeDir?: string;
}>): Promise<void> {
  const happyHomeDir = params.happyHomeDir ?? configuration.happyHomeDir;
  await mkdir(resolveOpenCodeConnectedConfigHomeDir(happyHomeDir), { recursive: true });
  const providers = params.providers.filter((provider) => OPEN_CODE_BROKER_PROVIDERS.includes(provider));
  if (providers.length === 0) return;
  await mkdir(resolveOpenCodeBrokerPluginDir(happyHomeDir), { recursive: true });
  await Promise.all(providers.map(async (provider) => {
    await writeFileIfChanged(resolveOpenCodeBrokerPluginPath(provider, happyHomeDir), buildOpenCodeBrokerPluginSource(provider));
  }));
}
