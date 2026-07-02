import {
  AcpConfigOptionOverridesV1Schema,
  buildAcpConfigOptionOverridesV1,
  type AcpConfigOptionOverridesV1,
} from '@happier-dev/protocol';

import { DEFAULT_CATALOG_AGENT_ID } from '@/backends/types';
import { readFlagValue, hasFlag } from '@/cli/commands/shared/argvFlags';
import { normalizeBackendTargetKeysFromCsv } from '@/cli/commands/session/shared/normalizeBackendTargetKeys';
import { resolveRequestedSessionDirectory } from '@/agent/runtime/resolveRequestedSessionDirectory';

type ConfigOptionValue = string | number | boolean | null;

export type SessionCreateSpawnActionInput = Record<string, unknown>;

export type ParsedSessionCreateSpawnOptions = Readonly<{
  backendRaw: string;
  backendTargetKey: string | null;
  actionInput: SessionCreateSpawnActionInput;
}>;

type ParseOptions = Readonly<{
  nowMs?: number;
}>;

export const SESSION_CREATE_USAGE = 'happier session create [--path <path>] [--backend <backend-target>] [--title <title>] [--tag <tag>] [--prompt <text>|--message <text>] [--model <model-id>] [--permission-mode <mode>] [--mode <agent-mode-id>] [--config-option <id=value>] [--reasoning-effort <value>] [--ultracode] [--config-overrides-json <json>] [--json]';

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

function parseConfigOptionValue(raw: string): ConfigOptionValue {
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

function parseConfigOptionFlag(raw: string): Readonly<{ id: string; value: ConfigOptionValue }> {
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

function parseConfigOverridesJson(raw: string, updatedAt: number): AcpConfigOptionOverridesV1 {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new Error('Invalid --config-overrides-json.');
  }

  const parsedCanonical = AcpConfigOptionOverridesV1Schema.safeParse(parsedJson);
  if (parsedCanonical.success) return parsedCanonical.data;

  if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
    throw new Error('Invalid --config-overrides-json.');
  }

  const overrides: Record<string, { updatedAt: number; value: ConfigOptionValue }> = {};
  for (const [key, value] of Object.entries(parsedJson)) {
    const id = key.trim();
    if (!id) continue;
    if (
      typeof value !== 'string'
      && typeof value !== 'number'
      && typeof value !== 'boolean'
      && value !== null
    ) {
      throw new Error('Invalid --config-overrides-json.');
    }
    overrides[id] = { updatedAt, value };
  }

  return buildAcpConfigOptionOverridesV1({ updatedAt, overrides });
}

function sameConfigOptionValue(left: ConfigOptionValue, right: ConfigOptionValue): boolean {
  return left === right;
}

function addConfigOverride(params: Readonly<{
  overrides: Record<string, { updatedAt: number; value: ConfigOptionValue }>;
  id: string;
  value: ConfigOptionValue;
  updatedAt: number;
}>): void {
  const existing = params.overrides[params.id];
  if (existing && !sameConfigOptionValue(existing.value, params.value)) {
    throw new Error(`Conflicting config option override: ${params.id}`);
  }
  params.overrides[params.id] = {
    updatedAt: params.updatedAt,
    value: params.value,
  };
}

function buildSessionConfigOptionOverrides(
  argv: readonly string[],
  nowMs: number,
): AcpConfigOptionOverridesV1 | null {
  const configOverridesRaw = readFlagValue(argv, '--config-overrides-json');
  const base = configOverridesRaw ? parseConfigOverridesJson(configOverridesRaw, nowMs) : null;
  const overrides: Record<string, { updatedAt: number; value: ConfigOptionValue }> = {
    ...(base?.overrides ?? {}),
  };

  const configOptionFlags = readRepeatedFlagValues(argv, '--config-option');
  for (const raw of configOptionFlags) {
    const parsed = parseConfigOptionFlag(raw);
    addConfigOverride({
      overrides,
      id: parsed.id,
      value: parsed.value,
      updatedAt: nowMs,
    });
  }

  const reasoningEffort = readFlagValue(argv, '--reasoning-effort');
  if (reasoningEffort) {
    addConfigOverride({
      overrides,
      id: 'reasoning_effort',
      value: reasoningEffort,
      updatedAt: nowMs,
    });
  }

  if (hasFlag(argv, '--ultracode')) {
    addConfigOverride({
      overrides,
      id: 'ultracode',
      value: true,
      updatedAt: nowMs,
    });
  }

  if (Object.keys(overrides).length === 0) return null;
  return buildAcpConfigOptionOverridesV1({
    updatedAt: nowMs,
    overrides,
  });
}

export function parseSessionCreateSpawnOptions(
  argv: readonly string[],
  options: ParseOptions = {},
): ParsedSessionCreateSpawnOptions {
  const nowMs = options.nowMs ?? Date.now();
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
  const sessionConfigOptionOverrides = buildSessionConfigOptionOverrides(argv, nowMs);

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
    },
  };
}
