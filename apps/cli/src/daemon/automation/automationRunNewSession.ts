import {
  SPAWN_SESSION_ERROR_CODES,
  type SpawnSessionOptions,
  type SpawnSessionResult,
} from '@/rpc/handlers/registerSessionHandlers';
import { mergeSpawnSessionOptions } from '@/rpc/handlers/spawnSessionOptionsContract';
import { createPendingFirstInput } from '@/daemon/spawn/pendingFirstInput';

export async function runAutomationAsNewSession(params: {
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  runId: string;
  firstInputText?: string;
  template: SpawnSessionOptions;
}): Promise<SpawnSessionResult> {
  const normalizedRunId = params.runId.trim();
  if (!normalizedRunId) {
    return {
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      errorMessage: 'automation run id is required for a new session',
    };
  }
  const spawnNonce = `automation:${normalizedRunId}`;
  const firstInputText = params.firstInputText;
  return await params.spawnSession(
    mergeSpawnSessionOptions(
      params.template,
      {
        approvedNewDirectoryCreation: true,
        spawnNonce,
        ...(typeof firstInputText === 'string' && firstInputText.trim().length > 0
          ? { pendingFirstInput: createPendingFirstInput({ text: firstInputText, spawnNonce }) }
          : {}),
      },
    ) as SpawnSessionOptions,
  );
}
