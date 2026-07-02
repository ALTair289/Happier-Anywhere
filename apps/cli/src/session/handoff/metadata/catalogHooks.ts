import { AGENTS, resolveCatalogAgentId } from '@/backends/catalog';
import type { CatalogAgentId, ProviderRuntimeLocalHandoffMetadataBuilder } from '@/backends/types';

export function buildRuntimeLocalHandoffMetadataForAgent(
  agentId: CatalogAgentId | null | undefined,
  params: Parameters<ProviderRuntimeLocalHandoffMetadataBuilder>[0],
): ReturnType<ProviderRuntimeLocalHandoffMetadataBuilder> | null {
  const catalogId = resolveCatalogAgentId(agentId);
  const entry = AGENTS[catalogId];
  return entry?.buildRuntimeLocalHandoffMetadata?.(params) ?? null;
}
