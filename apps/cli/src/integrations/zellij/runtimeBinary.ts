import { existsSync } from 'node:fs';

import { resolveCliRuntimeAssetPath } from '@/runtime/assets/resolveCliRuntimeAssetPath';

import { resolveZellijBinary } from './resolveZellijBinary';
import { warnIfOwnRunnerSnapshotRootMissing } from './warnMissingRunnerSnapshotRoot';

export const BUNDLED_ZELLIJ_VERSION = '0.44.3';

export function resolveZellijToolsDir(): string {
  const installedToolsDir = resolveCliRuntimeAssetPath('tools', 'unpacked');
  if (existsSync(installedToolsDir)) return installedToolsDir;
  return resolveCliRuntimeAssetPath('apps', 'cli', 'tools', 'unpacked');
}

export async function resolveZellijRuntimeBinary(params: Readonly<{
  expectedVersion?: string;
}> = {}): Promise<string | null> {
  const binary = await resolveZellijBinary({
    toolsDir: resolveZellijToolsDir(),
    expectedVersion: params.expectedVersion ?? BUNDLED_ZELLIJ_VERSION,
  });
  if (!binary) {
    // Surface the orphaned-snapshot class: if THIS runner is executing from a pinned snapshot root
    // that has been pruned away, the bundled zellij is unreachable. Diagnostic only.
    warnIfOwnRunnerSnapshotRootMissing();
  }
  return binary;
}
