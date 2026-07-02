import type { AgentBackend } from '@/agent';
import type { AcpTurnOutcome } from '@/agent/acp/backend/turn/_types';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

type GeminiPromptBackend = Omit<AgentBackend, 'waitForResponseComplete'> & {
  waitForResponseComplete?: (timeoutMs?: number | null) => Promise<AcpTurnOutcome | void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isAcpTurnOutcome(value: unknown): value is AcpTurnOutcome {
  if (!isRecord(value)) return false;
  return (
    value.kind === 'completed' ||
    value.kind === 'aborted' ||
    value.kind === 'refused' ||
    value.kind === 'failed' ||
    value.kind === 'timed_out'
  );
}

function isAbortLikeError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function getErrorCode(error: unknown): unknown {
  return isRecord(error) ? error.code : null;
}

function getErrorDetails(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (!isRecord(error)) return '';
  const data = isRecord(error.data) ? error.data : null;
  const details = data?.details ?? error.details ?? error.message;
  return typeof details === 'string' ? details : '';
}

export async function sendGeminiPromptWithRetry(params: {
  backend: GeminiPromptBackend;
  acpSessionId: string;
  prompt: string;
  messageBuffer: MessageBuffer;
  session: ApiSessionClient;
  onDebug: (message: string) => void;
  maxRetries?: number;
  retryDelayMs?: number;
  waitForResponseTimeoutMs?: number;
  onProviderPromptAccepted?: () => void;
}): Promise<AcpTurnOutcome | void> {
  const maxRetries = typeof params.maxRetries === 'number' ? params.maxRetries : 3;
  const retryDelayMs = typeof params.retryDelayMs === 'number' ? params.retryDelayMs : 2_000;
  const waitForResponseTimeoutMs: number | null = typeof params.waitForResponseTimeoutMs === 'number'
    ? params.waitForResponseTimeoutMs
    : null;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let providerPromptAccepted = false;
    try {
      await params.backend.sendPrompt(params.acpSessionId, params.prompt);
      providerPromptAccepted = true;
      params.onProviderPromptAccepted?.();
      params.onDebug('[gemini] Prompt sent successfully');

      // Wait for Gemini to finish responding (all chunks received + final idle)
      // This ensures we don't send task_complete until response is truly done.
      if (params.backend.waitForResponseComplete) {
        const outcome = await params.backend.waitForResponseComplete(waitForResponseTimeoutMs);
        params.onDebug('[gemini] Response complete');
        return isAcpTurnOutcome(outcome) ? outcome : undefined;
      }

      return undefined;
    } catch (promptError) {
      if (providerPromptAccepted) {
        throw promptError;
      }

      lastError = promptError;
      const errorDetails = getErrorDetails(promptError);
      const errorCode = getErrorCode(promptError);

      // Quota/capacity errors are not retryable.
      const isQuotaError = errorDetails.includes('exhausted') ||
        errorDetails.includes('quota') ||
        errorDetails.includes('capacity');
      if (isQuotaError) {
        const resetTimeMatch = errorDetails.match(/reset after (\d+h)?(\d+m)?(\d+s)?/i);
        let resetTimeMsg = '';
        if (resetTimeMatch) {
          const parts = resetTimeMatch.slice(1).filter(Boolean).join('');
          resetTimeMsg = ` Quota resets in ${parts}.`;
        }
        const quotaMsg = `Gemini quota exceeded.${resetTimeMsg} Try using a different model (gemini-2.5-flash-lite) or wait for quota reset.`;
        params.messageBuffer.addMessage(quotaMsg, 'status');
        params.session.sendAgentMessage('gemini', { type: 'message', message: quotaMsg });
        throw promptError;
      }

      // Retry transient internal/empty-response failures.
      const isEmptyResponseError = errorDetails.includes('empty response') ||
        errorDetails.includes('Model stream ended');
      const isInternalError = errorCode === -32603;
      const isStallTimeout =
        /Timeout waiting for response to complete/i.test(errorDetails) ||
        /turn inactivity timeout/i.test(errorDetails);
      const isRetryable = !isAbortLikeError(promptError) && (
        isEmptyResponseError ||
        isInternalError ||
        isStallTimeout
      );

      if (isRetryable && attempt < maxRetries) {
        params.onDebug(`[gemini] Retryable error on attempt ${attempt}/${maxRetries}: ${errorDetails}`);
        params.messageBuffer.addMessage(`Gemini returned empty response, retrying (${attempt}/${maxRetries})...`, 'status');
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
        continue;
      }

      throw promptError;
    }
  }

  if (lastError && maxRetries > 1) {
    // If we had transient failures but eventually succeeded.
    params.onDebug('[gemini] Prompt succeeded after retries');
  }
}
