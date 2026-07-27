import {
  readSpawnConfigOptionOverrideValue,
  type AcpConfigOptionOverridesV1,
} from '@happier-dev/protocol';

import type { AgentBackend, SessionId, StartSessionResult } from '@/agent/core/AgentBackend';
import { readNonBlankSessionControlIdentifier } from '@/agent/runtime/sessionControlIdentifiers';

/**
 * Canonical, provider-agnostic apply-options seam for execution-run backends.
 *
 * A run's `modelId` and canonical config-option overrides (e.g. `reasoning_effort`) are part of the
 * execution-run contract, but the ONLY place a backend can safely apply them is after the (new or
 * resumed) session id is known. This wrapper defers option application to exactly that point by
 * wrapping `startSession` / `loadSession` / `loadSessionWithReplayCapture`.
 *
 * It is capability-driven, not provider-name-driven: options are applied only when the backend
 * exposes the corresponding setter (`setSessionModel` / `setSessionConfigOption`). Backends that
 * cannot apply an option (e.g. the Codex MCP transport, which bakes the model in at construction)
 * are returned untouched — the wrapper is a no-op rather than a hard failure.
 */

type ModelConfigurableBackend = AgentBackend &
  Partial<{
    setSessionModel: (sessionId: SessionId, modelId: string) => Promise<void>;
    setSessionConfigOption: (
      sessionId: SessionId,
      configId: string,
      value: string | number | boolean | null,
    ) => Promise<void>;
  }>;

export function withExecutionRunBackendModelOptions(
  backend: AgentBackend,
  options: Readonly<{
    modelId?: string;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
  }>,
): AgentBackend {
  const modelId = readNonBlankSessionControlIdentifier(options.modelId) ?? '';
  const overrides = options.sessionConfigOptionOverrides?.overrides ?? null;
  const overrideEntries = overrides
    ? Object.keys(overrides)
      .filter((configId) => readNonBlankSessionControlIdentifier(configId) !== null)
      .flatMap((configId) => {
        const value = readSpawnConfigOptionOverrideValue(options.sessionConfigOptionOverrides, configId);
        return value === undefined || value === null ? [] : [[configId, value] as const];
      })
    : [];
  if (!modelId && overrideEntries.length === 0) return backend;

  const target = backend as ModelConfigurableBackend;

  const applyOptions = async (sessionId: SessionId): Promise<void> => {
    if (modelId && typeof target.setSessionModel === 'function') {
      await target.setSessionModel(sessionId, modelId);
    }
    if (overrideEntries.length > 0 && typeof target.setSessionConfigOption === 'function') {
      for (const [configId, value] of overrideEntries) {
        await target.setSessionConfigOption(sessionId, configId, value);
      }
    }
  };

  const originalStartSession = backend.startSession.bind(backend);
  target.startSession = async (initialPrompt?: string): Promise<StartSessionResult> => {
    const started = await originalStartSession(initialPrompt);
    await applyOptions(started.sessionId);
    return started;
  };

  if (typeof backend.loadSession === 'function') {
    const originalLoadSession = backend.loadSession.bind(backend);
    target.loadSession = async (existingSessionId: SessionId): Promise<StartSessionResult> => {
      const loaded = await originalLoadSession(existingSessionId);
      await applyOptions(loaded.sessionId);
      return loaded;
    };
  }

  if (typeof backend.loadSessionWithReplayCapture === 'function') {
    const originalLoadReplay = backend.loadSessionWithReplayCapture.bind(backend);
    target.loadSessionWithReplayCapture = async (
      existingSessionId: SessionId,
    ): Promise<StartSessionResult & { replay: unknown[] }> => {
      const loaded = await originalLoadReplay(existingSessionId);
      await applyOptions(loaded.sessionId);
      return loaded;
    };
  }

  return backend;
}
