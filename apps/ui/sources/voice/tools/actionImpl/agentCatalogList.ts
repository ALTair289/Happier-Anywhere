import { AGENT_IDS, getAgentCore, isAgentId, type AgentId } from '@/agents/catalog/catalog';
import { buildBackendTargetKey, parseBackendTargetKey } from '@happier-dev/protocol';
import { getAgentStaticModels } from '@happier-dev/agents';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { machineCapabilitiesInvoke } from '@/sync/ops/capabilities';
import {
  readDynamicModelProbeCache,
  runDynamicModelProbeDedupe,
  writeDynamicModelProbeCacheError,
  writeDynamicModelProbeCacheSuccess,
  writeDynamicModelProbeCacheTransientSuccess,
} from '@/sync/domains/models/dynamicModelProbeCache';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';
import { parsePreflightModelListFromProbeModelsResult } from '@/sync/domains/models/parsePreflightModelListFromProbeModelsResult';
import type { PreflightModelList } from '@/sync/domains/models/modelOptions';
import type { CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';
import { readNonBlankSessionControlIdentifier } from '@/sync/domains/sessionControl/opaqueIdentifiers';

type AgentModelCatalogItem = Readonly<{
  modelId: string;
  label: string;
  description?: string;
}>;

function dedupeOpaqueModelCatalogItems(items: readonly AgentModelCatalogItem[]): AgentModelCatalogItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = readNonBlankSessionControlIdentifier(item.modelId);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

function titleCaseId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return '';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function resolveBackendCatalogItemsForVoiceTool(params: Readonly<{
  includeDisabled: boolean;
}>): Array<{
  targetKey: string;
  label: string;
  enabled: boolean;
  agentId?: string;
  subtitle?: string | null;
  experimental?: boolean;
  uiConnectedService?: Readonly<{
    serviceId: string | null;
    label: string;
    connectRoute: string | null;
  }> | null;
  flavorAliases?: readonly string[];
  supportsModelSelection?: boolean;
  supportsFreeformModels?: boolean;
}> {
  const state = storage.getState();
  const backendEnabledByTargetKey = state.settings?.backendEnabledByTargetKey ?? null;
  const acpCatalogSettingsV1 = state.settings?.acpCatalogSettingsV1 ?? { v: 2, backends: [] };
  const enabledBuiltInAgentIds = params.includeDisabled
    ? Array.from(AGENT_IDS)
    : Array.from(AGENT_IDS).filter((id) => backendEnabledByTargetKey?.[buildBackendTargetKey({ kind: 'builtInAgent', agentId: id })] !== false);

  return getResolvedBackendCatalogEntries({
    enabledAgentIds: enabledBuiltInAgentIds,
    acpCatalogSettingsV1,
    backendEnabledByTargetKey: params.includeDisabled ? undefined : backendEnabledByTargetKey,
  })
    .map((entry) => {
      const enabled = backendEnabledByTargetKey?.[entry.targetKey] !== false;
      if (!params.includeDisabled && !enabled) return null;

      if (entry.builtInAgentId) {
        const core = getAgentCore(entry.builtInAgentId);
        return {
          targetKey: entry.targetKey,
          label: entry.title || titleCaseId(entry.builtInAgentId),
          subtitle: entry.subtitle,
          enabled,
          agentId: entry.builtInAgentId,
          experimental: core.availability.experimental === true,
          uiConnectedService: core.uiConnectedService,
          flavorAliases: core.flavorAliases,
          supportsModelSelection: core.model.supportsSelection === true,
          supportsFreeformModels: core.model.supportsFreeform === true,
        };
      }

      return {
        targetKey: entry.targetKey,
        label: entry.title,
        subtitle: entry.subtitle,
        enabled,
        agentId: 'customAcp',
        experimental: false,
        uiConnectedService: null,
        flavorAliases: [],
        supportsModelSelection: true,
        supportsFreeformModels: true,
      };
    })
    .filter(Boolean) as Array<{
      targetKey: string;
      label: string;
      enabled: boolean;
      agentId?: string;
      subtitle?: string | null;
      experimental?: boolean;
      uiConnectedService?: Readonly<{
        serviceId: string | null;
        label: string;
        connectRoute: string | null;
      }> | null;
      flavorAliases?: readonly string[];
      supportsModelSelection?: boolean;
      supportsFreeformModels?: boolean;
    }>;
}

export async function listAgentBackendsForVoiceTool(params: Readonly<{ includeDisabled?: boolean; limit?: number }>): Promise<unknown> {
  const includeDisabled = params.includeDisabled === true;
  const limitRaw = Number(params.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : null;
  const items = resolveBackendCatalogItemsForVoiceTool({ includeDisabled });

  return { items: limit ? items.slice(0, limit) : items };
}

export async function listAgentModelsForVoiceTool(params: Readonly<{
  agentId?: string;
  machineId?: string;
  limit?: number;
  backendTargetKey?: string;
}>): Promise<unknown> {
  const backendTargetKey = normalizeId(params.backendTargetKey);
  let backendTarget: ReturnType<typeof parseBackendTargetKey> | null = null;
  if (backendTargetKey) {
    try {
      backendTarget = parseBackendTargetKey(backendTargetKey);
    } catch {
      return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };
    }
  }
  const agentIdRaw = normalizeId(params.agentId)
    || (backendTarget?.kind === 'builtInAgent' ? backendTarget.agentId : backendTarget?.kind === 'configuredAcpBackend' ? 'customAcp' : '');
  if (!agentIdRaw || !isAgentId(agentIdRaw)) {
    return { ok: false, errorCode: 'unknown_agent', errorMessage: 'unknown_agent', agentId: agentIdRaw };
  }
  if (backendTarget && backendTarget.kind === 'builtInAgent' && agentIdRaw !== backendTarget.agentId) {
    return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters', agentId: agentIdRaw };
  }
  if (backendTarget && backendTarget.kind === 'configuredAcpBackend' && agentIdRaw !== 'customAcp') {
    return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters', agentId: agentIdRaw };
  }
  if (agentIdRaw === 'customAcp' && !backendTarget) {
    return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters', agentId: agentIdRaw };
  }
  const agentId = agentIdRaw as AgentId;
  const limitRaw = Number(params.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : null;
  const core = getAgentCore(agentId);
  if (core.model.supportsSelection !== true) {
    return {
      agentId,
      items: [{ modelId: 'default', label: 'Default' }].slice(0, limit ?? 1),
      supportsFreeform: false,
      source: 'static' as const,
    };
  }

  const machineId = normalizeId(params.machineId);
  if (machineId) {
    const serverId = normalizeId(getActiveServerSnapshot()?.serverId) || null;
    const cacheKey = buildDynamicModelProbeCacheKey({
      machineId,
      targetKey: backendTargetKey || buildBackendTargetKey({ kind: 'builtInAgent', agentId }),
      serverId,
      cwd: null,
    });

    const nowMs = Date.now();
    const cacheEntry = cacheKey ? readDynamicModelProbeCache(cacheKey) : null;
    const cached = cacheEntry?.kind === 'success' ? cacheEntry.value : null;
    const cachedCanPersist = cacheEntry?.kind === 'success' && cacheEntry.cacheable !== false;
    if (cached && nowMs >= 0 && nowMs < cacheEntry!.expiresAt) {
      const dynamic = cached.availableModels.map((m) => ({
        modelId: String(m.id),
        label: String(m.name),
        ...(typeof m.description === 'string' ? { description: m.description } : {}),
      }));

      const withDefault = [{ modelId: 'default', label: 'Default' }, ...dynamic.filter((m) => m.modelId !== 'default')];
      const items = dedupeOpaqueModelCatalogItems(withDefault);

      return {
        agentId,
        machineId,
        items: limit ? items.slice(0, limit) : items,
        supportsFreeform: cached.supportsFreeform === true,
        source: 'preflight' as const,
      };
    }

    if (cacheKey) {
      const attempt = await runDynamicModelProbeDedupe<Readonly<{
        list: PreflightModelList;
        cacheable: boolean;
      }> | null>(cacheKey, async () => {
        const capabilityId: CapabilityId = `cli.${agentId}`;
        const res = await machineCapabilitiesInvoke(
          machineId,
          {
            id: capabilityId,
            method: 'probeModels',
            params: {
              timeoutMs: 15_000,
              ...(backendTarget ? { backendTarget } : {}),
            },
          },
          { ...(serverId ? { serverId } : {}) },
        );

        if (!res.supported) return null;
        if (!res.response.ok) return null;

        const list = parsePreflightModelListFromProbeModelsResult(res.response.result);
        if (!list) return null;
        const result = res.response.result;
        const source = result && typeof result === 'object' && !Array.isArray(result)
          ? (typeof (result as Record<string, unknown>).source === 'string' ? (result as Record<string, unknown>).source : null)
          : null;
        const cacheable = source !== 'static';
        return { list, cacheable };
      });

      const commitNowMs = Date.now();
      const list = attempt?.list ?? null;
      if (list && attempt?.cacheable !== false) {
        writeDynamicModelProbeCacheSuccess(cacheKey, list, commitNowMs);
        const dynamic = list.availableModels.map((m) => ({
          modelId: String(m.id),
          label: String(m.name),
          ...(typeof m.description === 'string' ? { description: m.description } : {}),
        }));

        const withDefault = [{ modelId: 'default', label: 'Default' }, ...dynamic.filter((m) => m.modelId !== 'default')];
        const items = dedupeOpaqueModelCatalogItems(withDefault);

        return {
          agentId,
          machineId,
          items: limit ? items.slice(0, limit) : items,
          supportsFreeform: list.supportsFreeform === true,
          source: 'preflight' as const,
        };
      }

      if (list && attempt?.cacheable === false && !cached) {
        writeDynamicModelProbeCacheTransientSuccess(cacheKey, list, commitNowMs);
        writeDynamicModelProbeCacheError(cacheKey, commitNowMs);
        const dynamic = list.availableModels.map((m) => ({
          modelId: String(m.id),
          label: String(m.name),
          ...(typeof m.description === 'string' ? { description: m.description } : {}),
        }));
        const withDefault = [{ modelId: 'default', label: 'Default' }, ...dynamic.filter((m) => m.modelId !== 'default')];
        const items = dedupeOpaqueModelCatalogItems(withDefault);

        return {
          agentId,
          machineId,
          items: limit ? items.slice(0, limit) : items,
          supportsFreeform: list.supportsFreeform === true,
          source: 'preflight' as const,
        };
      }

      if (cached) {
        if (cachedCanPersist) {
          writeDynamicModelProbeCacheSuccess(cacheKey, cached, commitNowMs);
        }
        const dynamic = cached.availableModels.map((m) => ({
          modelId: String(m.id),
          label: String(m.name),
          ...(typeof m.description === 'string' ? { description: m.description } : {}),
        }));
        const withDefault = [{ modelId: 'default', label: 'Default' }, ...dynamic.filter((m) => m.modelId !== 'default')];
        const items = dedupeOpaqueModelCatalogItems(withDefault);

        return {
          agentId,
          machineId,
          items: limit ? items.slice(0, limit) : items,
          supportsFreeform: cached.supportsFreeform === true,
          source: 'preflight' as const,
        };
      }

      writeDynamicModelProbeCacheError(cacheKey, commitNowMs);
    }
  }

  const items = dedupeOpaqueModelCatalogItems([
    { modelId: 'default', label: 'Default' },
    ...getAgentStaticModels(agentId).map((model) => ({
      modelId: String(model.id),
      label: String(model.name),
      ...(typeof model.description === 'string' ? { description: model.description } : {}),
    })),
  ]);

  return {
    agentId,
    items: limit ? items.slice(0, limit) : items,
    supportsFreeform: core.model.supportsFreeform === true,
    source: 'static' as const,
  };
}
