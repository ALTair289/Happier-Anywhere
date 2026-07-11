import {
  AcpConfigOptionOverridesV1Schema,
  AgentRuntimeDescriptorV1Schema,
  ConnectedServiceBindingsV1Schema,
  SessionMcpSelectionV1Schema,
  type SpawnConfigOptionValue,
} from '@happier-dev/protocol';

import { DEFAULT_CATALOG_AGENT_ID } from '@/backends/types';
import { readFlagValue, hasFlag } from '@/cli/commands/shared/argvFlags';
import { normalizeBackendTargetKeysFromCsv } from '@/cli/commands/session/shared/normalizeBackendTargetKeys';
import { resolveRequestedSessionDirectory } from '@/agent/runtime/resolveRequestedSessionDirectory';

export type SessionCreateSpawnActionInput = Record<string, unknown>;

export type ParsedSessionCreateSpawnOptions = Readonly<{
  backendRaw: string;
  backendTargetKey: string | null;
  actionInput: SessionCreateSpawnActionInput;
}>;

export const SESSION_CREATE_USAGE = 'happier session create [--path <path>] [--backend <backend-target>] [--title <title>] [--tag <tag>] [--prompt <text>|--message <text>] [--model <model-id>] [--permission-mode <mode>] [--mode <agent-mode-id>] [--config-option <id=value>] [--reasoning-effort <value>] [--ultracode] [--config-overrides-json <json>] [--profile <profile-id>] [--env <KEY=VALUE>] [--connected-services-json <json>] [--mcp-selection-json <json>] [--transcript-storage <persisted|direct>] [--terminal-json <json>] [--codex-backend-mode <mcp|acp|appServer>] [--runtime-descriptor-json <json>|--agent-runtime-descriptor-json <json>] [--host <host>] [--machine-id <machineId>] [--json]';

function readRepeatedFlagValues(argv: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== flag) continue;
    const raw = argv[index + 1];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed.length > 0) values.push(trimmed);
  }
  return values;
}

function parseConfigOptionValue(raw: string): SpawnConfigOptionValue {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return trimmed;
}

function parseConfigOptionFlag(raw: string): Readonly<{ id: string; value: SpawnConfigOptionValue }> {
  const separatorIndex = raw.indexOf('=');
  if (separatorIndex <= 0) {
    throw new Error('Invalid --config-option. Expected <id=value>.');
  }
  const id = raw.slice(0, separatorIndex).trim();
  if (!id) {
    throw new Error('Invalid --config-option. Expected <id=value>.');
  }
  return {
    id,
    value: parseConfigOptionValue(raw.slice(separatorIndex + 1)),
  };
}

function parseJsonFlagValue(raw: string, flag: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid ${flag}.`);
  }
}

function parseObjectJsonFlagValue(raw: string, flag: string): Record<string, unknown> {
  const parsed = parseJsonFlagValue(raw, flag);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid ${flag}.`);
  }
  return parsed as Record<string, unknown>;
}

function readParsedJsonFlag<T>(
  argv: readonly string[],
  flag: string,
  parse: (value: unknown) => T,
): T | null {
  const raw = readFlagValue(argv, flag);
  if (!raw) return null;
  const parsed = parseJsonFlagValue(raw, flag);
  try {
    return parse(parsed);
  } catch {
    throw new Error(`Invalid ${flag}.`);
  }
}

function parseEnvironmentVariables(argv: readonly string[]): Record<string, string> | null {
  const values = readRepeatedFlagValues(argv, '--env');
  if (values.length === 0) return null;
  const environmentVariables: Record<string, string> = {};
  for (const raw of values) {
    const separatorIndex = raw.indexOf('=');
    if (separatorIndex <= 0) {
      throw new Error('Invalid --env. Expected <KEY=VALUE>.');
    }
    const key = raw.slice(0, separatorIndex).trim();
    if (!key) {
      throw new Error('Invalid --env. Expected <KEY=VALUE>.');
    }
    environmentVariables[key] = raw.slice(separatorIndex + 1);
  }
  return environmentVariables;
}

function parseTranscriptStorage(raw: string): 'persisted' | 'direct' {
  if (raw === 'persisted' || raw === 'direct') return raw;
  throw new Error('Invalid --transcript-storage.');
}

function parseCodexBackendMode(raw: string): 'mcp' | 'acp' | 'appServer' {
  if (raw === 'mcp' || raw === 'acp' || raw === 'appServer') return raw;
  throw new Error('Invalid --codex-backend-mode.');
}

function parseConfigOptions(argv: readonly string[]): Record<string, SpawnConfigOptionValue> | null {
  const configOptions: Record<string, SpawnConfigOptionValue> = {};
  for (const raw of readRepeatedFlagValues(argv, '--config-option')) {
    const parsed = parseConfigOptionFlag(raw);
    configOptions[parsed.id] = parsed.value;
  }

  const reasoningEffort = readFlagValue(argv, '--reasoning-effort');
  if (reasoningEffort) {
    configOptions.reasoning_effort = reasoningEffort.trim();
  }

  if (hasFlag(argv, '--ultracode')) {
    configOptions.ultracode = true;
  }

  return Object.keys(configOptions).length > 0 ? configOptions : null;
}

export function parseSessionCreateSpawnOptions(argv: readonly string[]): ParsedSessionCreateSpawnOptions {
  const path = resolveRequestedSessionDirectory({
    requestedDirectory: readFlagValue(argv, '--path') ?? null,
  });
  const tag = (readFlagValue(argv, '--tag') ?? '').trim();
  const title = (readFlagValue(argv, '--title') ?? '').trim();
  const initialPrompt = (readFlagValue(argv, '--message') ?? readFlagValue(argv, '--prompt') ?? '').trim();
  const backendRaw = (readFlagValue(argv, '--backend') ?? readFlagValue(argv, '--agent') ?? '').trim();
  const backendTargetKeys = normalizeBackendTargetKeysFromCsv(backendRaw);
  const backendTargetKey = backendTargetKeys.length === 1 ? backendTargetKeys[0] : null;
  const modelId = (readFlagValue(argv, '--model') ?? '').trim();
  const permissionMode = (readFlagValue(argv, '--permission-mode') ?? '').trim();
  const agentModeId = (readFlagValue(argv, '--mode') ?? '').trim();
  const profileId = (readFlagValue(argv, '--profile') ?? '').trim();
  const host = (readFlagValue(argv, '--host') ?? '').trim();
  const machineId = (readFlagValue(argv, '--machine-id') ?? '').trim();
  const transcriptStorageRaw = (readFlagValue(argv, '--transcript-storage') ?? '').trim();
  const codexBackendModeRaw = (readFlagValue(argv, '--codex-backend-mode') ?? '').trim();
  const sessionConfigOptionOverrides = readParsedJsonFlag(
    argv,
    '--config-overrides-json',
    (value) => AcpConfigOptionOverridesV1Schema.parse(value),
  );
  const configOptions = parseConfigOptions(argv);
  const environmentVariables = parseEnvironmentVariables(argv);
  const connectedServices = readParsedJsonFlag(
    argv,
    '--connected-services-json',
    (value) => ConnectedServiceBindingsV1Schema.parse(value),
  );
  const mcpSelection = readParsedJsonFlag(
    argv,
    '--mcp-selection-json',
    (value) => SessionMcpSelectionV1Schema.parse(value),
  );
  const terminalRaw = readFlagValue(argv, '--terminal-json');
  const terminal = terminalRaw ? parseObjectJsonFlagValue(terminalRaw, '--terminal-json') : null;
  const agentRuntimeDescriptorRaw =
    readFlagValue(argv, '--agent-runtime-descriptor-json')
    ?? readFlagValue(argv, '--runtime-descriptor-json');
  const agentRuntimeDescriptorV1 = agentRuntimeDescriptorRaw
    ? AgentRuntimeDescriptorV1Schema.parse(parseJsonFlagValue(agentRuntimeDescriptorRaw, '--agent-runtime-descriptor-json'))
    : null;
  const transcriptStorage = transcriptStorageRaw ? parseTranscriptStorage(transcriptStorageRaw) : null;
  const codexBackendMode = codexBackendModeRaw ? parseCodexBackendMode(codexBackendModeRaw) : null;

  return {
    backendRaw,
    backendTargetKey,
    actionInput: {
      path,
      ...(backendTargetKey ? { backendTargetKey } : { agentId: DEFAULT_CATALOG_AGENT_ID }),
      ...(title ? { title } : {}),
      ...(tag ? { tag } : {}),
      ...(initialPrompt ? { initialMessage: initialPrompt } : {}),
      ...(modelId ? { modelId } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(agentModeId ? { agentModeId } : {}),
      ...(sessionConfigOptionOverrides ? { sessionConfigOptionOverrides } : {}),
      ...(configOptions ? { configOptions } : {}),
      ...(profileId ? { profileId } : {}),
      ...(environmentVariables ? { environmentVariables } : {}),
      ...(connectedServices ? { connectedServices } : {}),
      ...(mcpSelection ? { mcpSelection } : {}),
      ...(transcriptStorage ? { transcriptStorage } : {}),
      ...(terminal ? { terminal } : {}),
      ...(codexBackendMode ? { codexBackendMode } : {}),
      ...(agentRuntimeDescriptorV1 ? { agentRuntimeDescriptorV1 } : {}),
      ...(host ? { host } : {}),
      ...(machineId ? { machineId } : {}),
    },
  };
}
