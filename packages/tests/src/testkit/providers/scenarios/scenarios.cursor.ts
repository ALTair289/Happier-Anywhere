import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { decryptLegacyBase64 } from '../../messageCrypto';
import { fetchAllMessages, fetchSessionV2 } from '../../sessions';
import { sleep } from '../../timing';
import { assertSingleDurableToolCallPerLogicalId, decryptSessionMessageLegacy } from '../assertions';
import type { ProviderFixtures, ProviderScenario, ProviderUnderTest } from '../types';

const cursorAliasModelId = 'gpt-5.1-codex-max-medium-fast';
const cursorNormalizedModelConfigValue = 'gpt-5.1-codex-max[reasoning=medium,fast=false]';
const cursorFastConfigValue = 'true';
const cursorStubCallsRel = 'cursor-acp-stub/config-calls.json';
const cursorModelConfigAliasOutputRel = 'e2e-cursor-model-config-alias.json';
const cursorModeConfigOutputRel = 'e2e-cursor-mode-config-option.json';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: UnknownRecord | null | undefined, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readConfigOptionCurrentValue(configOptions: unknown, configId: string): string | null {
  if (!Array.isArray(configOptions)) return null;
  for (const option of configOptions) {
    if (!isRecord(option)) continue;
    if (readString(option, 'id') !== configId) continue;
    const value = option.currentValue;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return null;
  }
  return null;
}

function readFixtureExamples(fixtures: ProviderFixtures): Record<string, unknown[]> {
  const examples = fixtures.examples;
  if (!examples || typeof examples !== 'object' || Array.isArray(examples)) {
    throw new Error('Invalid fixtures: missing examples');
  }
  return examples as Record<string, unknown[]>;
}

function findExamplesBySuffix(fixtures: ProviderFixtures, suffix: string): unknown[] {
  const examples = readFixtureExamples(fixtures);
  for (const [key, value] of Object.entries(examples)) {
    if (key.endsWith(suffix) && Array.isArray(value)) return value;
  }
  return [];
}

function findNestedValue(value: unknown, key: string): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedValue(item, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const found = findNestedValue(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function assertCursorBackedProvider(provider: ProviderUnderTest, scenarioId: string): void {
  if (provider.protocol !== 'acp') {
    throw new Error(`${scenarioId} only supports ACP providers (got ${provider.protocol})`);
  }
  if (provider.cli.subcommand !== 'cursor') {
    throw new Error(`${scenarioId} requires the Cursor CLI backend (got ${provider.cli.subcommand})`);
  }
}

async function readJsonRecord(path: string): Promise<UnknownRecord> {
  const raw = await readFile(path, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(`Expected JSON object at ${path}`);
  }
  return parsed;
}

export function makeCursorAcpStubModelConfigAliasScenario(provider: ProviderUnderTest): ProviderScenario {
  const scenarioId = 'cursor_acp_stub_model_config_alias';
  assertCursorBackedProvider(provider, scenarioId);

  return {
    id: scenarioId,
    title: 'cursor: ACP model alias normalization applies exact config payloads',
    tier: 'smoke',
    yolo: true,
    cliArgs: () => ['--model', cursorAliasModelId, '--model-updated-at', String(Date.now())],
    prompt: () => 'CURSOR_STUB_READY',
    requiredTraceSubstrings: ['task_complete'],
    postSatisfy: {
      timeoutMs: 120_000,
      run: async ({ workspaceDir, baseUrl, token, sessionId, secret, cliHome }) => {
        const deadline = Date.now() + 60_000;
        let output: UnknownRecord | null = null;
        while (Date.now() < deadline) {
          const snap = await fetchSessionV2(baseUrl, token, sessionId);
          const metadata = decryptLegacyBase64(snap.metadata, secret);
          const metadataObj = isRecord(metadata) ? metadata : {};
          const sessionModels = isRecord(metadataObj.acpSessionModelsV1) ? metadataObj.acpSessionModelsV1 : {};
          const currentModelId = readString(sessionModels, 'currentModelId');
          const configState = isRecord(metadataObj.acpConfigOptionsV1) ? metadataObj.acpConfigOptionsV1 : {};
          const configOptions = configState.configOptions;
          const modelConfigValue = readConfigOptionCurrentValue(configOptions, 'model');
          const fastConfigValue = readConfigOptionCurrentValue(configOptions, 'fast');

          if (
            currentModelId === cursorNormalizedModelConfigValue &&
            modelConfigValue === cursorNormalizedModelConfigValue &&
            fastConfigValue === 'true'
          ) {
            const recordedConfigPayloads = await readJsonRecord(join(cliHome, cursorStubCallsRel));
            output = {
              requestedModelAlias: cursorAliasModelId,
              normalizedModelConfigValue: cursorNormalizedModelConfigValue,
              companionConfigUpdates: [{ configId: 'fast', value: cursorFastConfigValue }],
              metadataConfigValues: {
                model: modelConfigValue,
                fast: fastConfigValue,
              },
              appliedCurrentModelId: currentModelId,
              recordedConfigPayloads: recordedConfigPayloads.calls,
            };
            break;
          }

          await sleep(250);
        }

        if (!output) {
          throw new Error('cursor_acp_stub_model_config_alias: normalized Cursor ACP config payloads were not observed');
        }

        await writeFile(join(workspaceDir, cursorModelConfigAliasOutputRel), JSON.stringify(output, null, 2) + '\n', 'utf8');
      },
    },
    verify: async ({ workspaceDir }) => {
      const output = await readJsonRecord(join(workspaceDir, cursorModelConfigAliasOutputRel));
      expectEqual(output.requestedModelAlias, cursorAliasModelId, 'requestedModelAlias');
      expectEqual(output.normalizedModelConfigValue, cursorNormalizedModelConfigValue, 'normalizedModelConfigValue');
      expectEqual(output.appliedCurrentModelId, cursorNormalizedModelConfigValue, 'appliedCurrentModelId');

      if (!Array.isArray(output.recordedConfigPayloads)) {
        throw new Error('cursor_acp_stub_model_config_alias: recordedConfigPayloads missing');
      }
      expectJson(output.recordedConfigPayloads, [
        { configId: 'model', value: cursorNormalizedModelConfigValue },
        { configId: 'fast', value: cursorFastConfigValue },
      ], 'recordedConfigPayloads');
      expectJson(output.companionConfigUpdates, [{ configId: 'fast', value: cursorFastConfigValue }], 'companionConfigUpdates');
      expectJson(output.metadataConfigValues, {
        model: cursorNormalizedModelConfigValue,
        fast: 'true',
      }, 'metadataConfigValues');
    },
  };
}

export function makeCursorAcpStubModeConfigOptionScenario(provider: ProviderUnderTest): ProviderScenario {
  const scenarioId = 'cursor_acp_stub_mode_config_option';
  assertCursorBackedProvider(provider, scenarioId);

  return {
    id: scenarioId,
    title: 'cursor: ACP mode override applies mode config option before prompt',
    tier: 'smoke',
    yolo: true,
    cliArgs: () => ['--agent-mode', 'plan', '--agent-mode-updated-at', String(Date.now())],
    prompt: () => 'CURSOR_STUB_READY',
    requiredTraceSubstrings: ['task_complete'],
    postSatisfy: {
      timeoutMs: 120_000,
      run: async ({ workspaceDir, baseUrl, token, sessionId, secret, cliHome }) => {
        const deadline = Date.now() + 60_000;
        let output: UnknownRecord | null = null;
        while (Date.now() < deadline) {
          const snap = await fetchSessionV2(baseUrl, token, sessionId);
          const metadata = decryptLegacyBase64(snap.metadata, secret);
          const metadataObj = isRecord(metadata) ? metadata : {};
          const sessionModes = isRecord(metadataObj.acpSessionModesV1) ? metadataObj.acpSessionModesV1 : {};
          const currentModeId = readString(sessionModes, 'currentModeId');
          const configState = isRecord(metadataObj.acpConfigOptionsV1) ? metadataObj.acpConfigOptionsV1 : {};
          const configOptions = configState.configOptions;
          const modeConfigValue = readConfigOptionCurrentValue(configOptions, 'mode');

          if (currentModeId === 'plan' && modeConfigValue === 'plan') {
            const recordedConfigPayloads = await readJsonRecord(join(cliHome, cursorStubCallsRel));
            output = {
              requestedModeId: 'plan',
              appliedCurrentModeId: currentModeId,
              metadataConfigValues: { mode: modeConfigValue },
              recordedConfigPayloads: recordedConfigPayloads.calls,
            };
            break;
          }

          await sleep(250);
        }

        if (!output) {
          throw new Error('cursor_acp_stub_mode_config_option: Cursor ACP mode config payload was not observed');
        }

        await writeFile(join(workspaceDir, cursorModeConfigOutputRel), JSON.stringify(output, null, 2) + '\n', 'utf8');
      },
    },
    verify: async ({ workspaceDir }) => {
      const output = await readJsonRecord(join(workspaceDir, cursorModeConfigOutputRel));
      expectEqual(output.requestedModeId, 'plan', 'requestedModeId');
      expectEqual(output.appliedCurrentModeId, 'plan', 'appliedCurrentModeId');

      if (!Array.isArray(output.recordedConfigPayloads)) {
        throw new Error('cursor_acp_stub_mode_config_option: recordedConfigPayloads missing');
      }
      expectJson(output.recordedConfigPayloads, [
        { configId: 'mode', value: 'plan' },
      ], 'recordedConfigPayloads');
      expectJson(output.metadataConfigValues, { mode: 'plan' }, 'metadataConfigValues');
    },
  };
}

export function makeCursorAcpStubExtensionPlanTodosScenario(provider: ProviderUnderTest): ProviderScenario {
  const scenarioId = 'cursor_acp_stub_extension_plan_todos';
  assertCursorBackedProvider(provider, scenarioId);

  return {
    id: scenarioId,
    title: 'cursor: extension plan and todos surface through visible work-state',
    tier: 'smoke',
    yolo: true,
    allowPermissionAutoApproveInYolo: true,
    permissionAutoDecision: 'approved',
    prompt: () => 'CURSOR_STUB_EXTENSION_UX=1',
    requiredTraceSubstrings: ['task_complete'],
    verify: async ({ fixtures }) => {
      const todoRequests = findExamplesBySuffix(fixtures, '/permission-request/TodoWrite')
        .concat(findExamplesBySuffix(fixtures, '/tool-call/TodoWrite'));
      const planRequests = findExamplesBySuffix(fixtures, '/permission-request/ExitPlanMode')
        .concat(findExamplesBySuffix(fixtures, '/tool-call/ExitPlanMode'));

      if (todoRequests.length === 0) {
        throw new Error('cursor_acp_stub_extension_plan_todos: missing visible TodoWrite work-state request');
      }
      if (planRequests.length === 0) {
        throw new Error('cursor_acp_stub_extension_plan_todos: missing visible ExitPlanMode plan request');
      }

      const todoContent = findNestedValue(todoRequests, 'content');
      if (todoContent !== 'Review Cursor ACP config payload') {
        throw new Error('cursor_acp_stub_extension_plan_todos: TodoWrite payload content was not visible in fixtures');
      }

      const planText = findNestedValue(planRequests, 'plan');
      if (planText !== '# Cursor Stub Plan\n\n1. Verify extension UX parity.') {
        throw new Error('cursor_acp_stub_extension_plan_todos: ExitPlanMode plan text was not visible in fixtures');
      }
    },
  };
}

export function makeCursorAcpStubCapturedLifecycleReplayScenario(provider: ProviderUnderTest): ProviderScenario {
  const scenarioId = 'cursor_acp_stub_captured_lifecycle_replay';
  assertCursorBackedProvider(provider, scenarioId);

  return {
    id: scenarioId,
    title: 'cursor: captured lifecycle replay preserves one durable row per logical call',
    tier: 'extended',
    yolo: true,
    prompt: () => 'CURSOR_STUB_CAPTURED_REPLAY=1',
    requiredTraceSubstrings: ['CURSOR_CAPTURED_REPLAY_DONE'],
    verify: async ({ baseUrl, token, sessionId, secret }) => {
      const rows = await fetchAllMessages(baseUrl, token, sessionId);
      const messages = rows
        .map((row) => decryptSessionMessageLegacy(row, secret))
        .filter((message): message is NonNullable<typeof message> => message !== null);
      assertSingleDurableToolCallPerLogicalId(messages);
    },
  };
}

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function expectJson(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
