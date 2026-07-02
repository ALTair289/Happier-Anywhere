import { rm } from 'node:fs/promises';

import type { CatalogAgentId } from '@/backends/types';
import { resolveConnectedServiceTargetMaterializedRoot } from './resolveConnectedServiceTargetMaterializedRoot';

export function createConnectedServiceMaterializedTargetRootCleanup(params: Readonly<{
  agentId: CatalogAgentId;
  env: Readonly<Record<string, string>>;
}>): (() => void) | null {
  const root = resolveConnectedServiceTargetMaterializedRoot({
    agentId: params.agentId,
    targetMaterializedEnv: params.env,
  })?.trim();
  if (!root) return null;

  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    void rm(root, { recursive: true, force: true }).catch(() => {});
  };
}
