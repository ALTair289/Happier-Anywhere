import {
  parseBackendTargetKey,
  type BackendTargetRefV1,
} from '@happier-dev/protocol';
import { AGENT_IDS, type AgentId } from '@happier-dev/agents';

import type { Credentials } from '@/persistence';
import {
  probeAgentModelsBestEffort,
  type ProbedAgentModelsResult,
} from '@/capabilities/probes/agentModelsProbe';
import {
  probeAgentModesBestEffort,
  type ProbedAgentModesResult,
} from '@/capabilities/probes/agentModesProbe';
import {
  probeAgentConfigOptionsBestEffort,
  type ProbedAgentConfigOptionsResult,
  type ProbedAgentConfigOptionValue,
} from '@/capabilities/probes/agentConfigOptionsProbe';
import { normalizeActionOptionLimit } from './actionOptionInputNormalization';

type ProbeModels = typeof probeAgentModelsBestEffort;
type ProbeModes = typeof probeAgentModesBestEffort;
type ProbeConfigOptions = typeof probeAgentConfigOptionsBestEffort;

type ListArgs = Readonly<{
  agentId: string;
  backendTargetKey?: string;
  modelId?: string;
  limit?: number;
  path?: string;
  directory?: string;
}>;

type OptionItem = Readonly<{
  id: string;
  label: string;
  description?: string;
}>;

type ModelItem = OptionItem & Readonly<{
  contextWindowTokens?: number;
  modelOptions?: unknown;
}>;

type ConfigOptionItem = OptionItem & Readonly<{
  type: string;
  currentValue: ProbedAgentConfigOptionValue;
  options?: readonly Readonly<{
    value: ProbedAgentConfigOptionValue;
    label: string;
    description?: string;
  }>[];
}>;

export type AgentsModelsListResult = Readonly<{
  agentId: string;
  backendTargetKey?: string;
  items: readonly ModelItem[];
  supportsFreeform: boolean;
  source: ProbedAgentModelsResult['source'];
}>;

export type AgentsConfigOptionsListResult = Readonly<{
  agentId: string;
  backendTargetKey?: string;
  items: readonly ConfigOptionItem[];
  source: ProbedAgentConfigOptionsResult['source'];
}>;

export type AgentsSessionModesListResult = Readonly<{
  agentId: string;
  backendTargetKey?: string;
  items: readonly OptionItem[];
  source: ProbedAgentModesResult['source'];
}>;

export type CliActionOptionProviderRegistry = Readonly<{
  agentsModelsList: (args: ListArgs) => Promise<AgentsModelsListResult>;
  agentsConfigOptionsList: (args: ListArgs) => Promise<AgentsConfigOptionsListResult>;
  agentsSessionModesList: (args: ListArgs) => Promise<AgentsSessionModesListResult>;
}>;

export type CreateCliActionOptionProviderRegistryParams = Readonly<{
  probeModels?: ProbeModels;
  probeModes?: ProbeModes;
  probeConfigOptions?: ProbeConfigOptions;
  cwd?: string;
  credentials?: Credentials | null;
  accountSettings?: Readonly<Record<string, unknown>> | null;
}>;

const SECRET_CONFIG_OPTION_PATTERN = /(?:token|secret|password|credential|api[_-]?key)/i;

function normalizeCatalogAgentId(value: string): AgentId {
  const normalized = value.trim();
  if (AGENT_IDS.includes(normalized as AgentId)) return normalized as AgentId;
  throw new Error('invalid_agent_id');
}

function normalizeBackendTargetKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveBackendTarget(backendTargetKey: string | undefined): BackendTargetRefV1 | undefined {
  if (!backendTargetKey) return undefined;
  return parseBackendTargetKey(backendTargetKey);
}

function resolveCwd(params: Readonly<{ args: ListArgs; fallbackCwd?: string }>): string {
  const explicit = typeof params.args.path === 'string' && params.args.path.trim().length > 0
    ? params.args.path.trim()
    : typeof params.args.directory === 'string' && params.args.directory.trim().length > 0
      ? params.args.directory.trim()
      : null;
  if (explicit) return explicit;
  if (params.fallbackCwd && params.fallbackCwd.trim().length > 0) return params.fallbackCwd.trim();
  return process.cwd();
}

function withLimit<T>(items: readonly T[], limit: unknown): readonly T[] {
  const bounded = normalizeActionOptionLimit(limit);
  return bounded ? items.slice(0, bounded) : items;
}

function isSecretConfigOption(option: Readonly<{ id: string; label: string; type?: string }>): boolean {
  return SECRET_CONFIG_OPTION_PATTERN.test(option.id)
    || SECRET_CONFIG_OPTION_PATTERN.test(option.label)
    || (typeof option.type === 'string' && SECRET_CONFIG_OPTION_PATTERN.test(option.type));
}

type ProbedModelOption = NonNullable<ProbedAgentModelsResult['availableModels'][number]['modelOptions']>[number];

function filterSafeModelOptions(modelOptions: readonly ProbedModelOption[] | undefined): readonly ProbedModelOption[] | undefined {
  if (!Array.isArray(modelOptions)) return undefined;
  const filtered = modelOptions.filter((option) => !isSecretConfigOption({
    id: option.id,
    label: option.name || option.id,
    type: option.type,
  }));
  return filtered.length > 0 ? filtered : undefined;
}

function configOptionItemFromModelOption(option: ProbedModelOption): ConfigOptionItem {
  return {
    id: option.id,
    label: option.name || option.id,
    type: option.type,
    currentValue: option.currentValue,
    ...(option.description ? { description: option.description } : {}),
    ...(Array.isArray(option.options)
      ? {
          options: option.options.map((choice) => ({
            value: choice.value,
            label: choice.name,
            ...(choice.description ? { description: choice.description } : {}),
          })),
        }
      : {}),
  };
}

function collectModelScopedConfigOptions(params: Readonly<{
  models: ProbedAgentModelsResult['availableModels'];
  modelId?: string;
}>): readonly ConfigOptionItem[] {
  const requestedModelId = typeof params.modelId === 'string' ? params.modelId.trim() : '';
  const candidateModels = requestedModelId && requestedModelId !== 'default'
    ? params.models.filter((model) => model.id === requestedModelId)
    : params.models;
  const seen = new Set<string>();
  const items: ConfigOptionItem[] = [];

  for (const model of candidateModels) {
    for (const option of model.modelOptions ?? []) {
      const item = configOptionItemFromModelOption(option);
      if (seen.has(item.id) || isSecretConfigOption(item)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }

  return items;
}

export function createCliActionOptionProviderRegistry(
  params: CreateCliActionOptionProviderRegistryParams = {},
): CliActionOptionProviderRegistry {
  const probeModels = params.probeModels ?? probeAgentModelsBestEffort;
  const probeModes = params.probeModes ?? probeAgentModesBestEffort;
  const probeConfigOptions = params.probeConfigOptions ?? probeAgentConfigOptionsBestEffort;

  const buildProbeContext = (args: ListArgs) => {
    const agentId = normalizeCatalogAgentId(args.agentId);
    const backendTargetKey = normalizeBackendTargetKey(args.backendTargetKey);
    return {
      agentId,
      backendTargetKey,
      backendTarget: resolveBackendTarget(backendTargetKey),
      cwd: resolveCwd({ args, fallbackCwd: params.cwd }),
      credentials: params.credentials ?? null,
      accountSettings: params.accountSettings ?? null,
    };
  };

  return {
    agentsModelsList: async (args) => {
      const context = buildProbeContext(args);
      const probed = await probeModels({
        agentId: context.agentId,
        ...(context.backendTarget ? { backendTarget: context.backendTarget } : {}),
        cwd: context.cwd,
        credentials: context.credentials,
        accountSettings: context.accountSettings,
      });
      const items = probed.availableModels.map((model): ModelItem => {
        const modelOptions = filterSafeModelOptions(model.modelOptions);
        return {
          id: model.id,
          label: model.name || model.id,
          ...(model.description ? { description: model.description } : {}),
          ...(typeof model.contextWindowTokens === 'number' ? { contextWindowTokens: model.contextWindowTokens } : {}),
          ...(modelOptions ? { modelOptions } : {}),
        };
      });
      return {
        agentId: context.agentId,
        ...(context.backendTargetKey ? { backendTargetKey: context.backendTargetKey } : {}),
        items: withLimit(items, args.limit),
        supportsFreeform: probed.supportsFreeform,
        source: probed.source,
      };
    },

    agentsConfigOptionsList: async (args) => {
      const context = buildProbeContext(args);
      const probed = await probeConfigOptions({
        agentId: context.agentId,
        ...(context.backendTarget ? { backendTarget: context.backendTarget } : {}),
        cwd: context.cwd,
        credentials: context.credentials,
        accountSettings: context.accountSettings,
      });
      const items = probed.configOptions
        .map((option): ConfigOptionItem => ({
          id: option.id,
          label: option.name || option.id,
          type: option.type,
          currentValue: option.currentValue,
          ...(option.description ? { description: option.description } : {}),
          ...(Array.isArray(option.options)
            ? {
                options: option.options.map((choice) => ({
                  value: choice.value,
                  label: choice.name,
                  ...(choice.description ? { description: choice.description } : {}),
                })),
              }
            : {}),
        }))
        .filter((option) => !isSecretConfigOption(option));
      if (items.length === 0) {
        const modelProbe = await probeModels({
          agentId: context.agentId,
          ...(context.backendTarget ? { backendTarget: context.backendTarget } : {}),
          cwd: context.cwd,
          credentials: context.credentials,
          accountSettings: context.accountSettings,
        });
        const modelScopedItems = collectModelScopedConfigOptions({
          models: modelProbe.availableModels,
          modelId: args.modelId,
        });
        if (modelScopedItems.length > 0) {
          return {
            agentId: context.agentId,
            ...(context.backendTargetKey ? { backendTargetKey: context.backendTargetKey } : {}),
            items: withLimit(modelScopedItems, args.limit),
            source: modelProbe.source,
          };
        }
      }
      return {
        agentId: context.agentId,
        ...(context.backendTargetKey ? { backendTargetKey: context.backendTargetKey } : {}),
        items: withLimit(items, args.limit),
        source: probed.source,
      };
    },

    agentsSessionModesList: async (args) => {
      const context = buildProbeContext(args);
      const probed = await probeModes({
        agentId: context.agentId,
        ...(context.backendTarget ? { backendTarget: context.backendTarget } : {}),
        cwd: context.cwd,
        credentials: context.credentials,
        accountSettings: context.accountSettings,
      });
      const items = probed.availableModes.map((mode): OptionItem => ({
        id: mode.id,
        label: mode.name || mode.id,
        ...(mode.description ? { description: mode.description } : {}),
      }));
      return {
        agentId: context.agentId,
        ...(context.backendTargetKey ? { backendTargetKey: context.backendTargetKey } : {}),
        items: withLimit(items, args.limit),
        source: probed.source,
      };
    },
  };
}
