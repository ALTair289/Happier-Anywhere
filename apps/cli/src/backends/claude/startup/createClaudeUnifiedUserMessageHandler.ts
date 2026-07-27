import type { SessionUserMessageEnqueueResult } from '@/rpc/handlers/sessionUserMessageSend';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';

type UnifiedUserMessageRequest = Readonly<{
    text: string;
    localId?: string;
    meta: Record<string, unknown>;
}>;

export function createClaudeUnifiedUserMessageHandler(input: Readonly<{
    enqueueSessionUserMessage: (request: UnifiedUserMessageRequest) => Promise<SessionUserMessageEnqueueResult>;
}>): NonNullable<SessionRuntimeControls['handleUserMessage']> {
    return async (request) => {
        const result = await input.enqueueSessionUserMessage(request);
        if (result?.recoveryBlocked) {
            return {
                handled: true,
                result: {
                    ok: false,
                    status: result.recoveryBlocked.status,
                    errorCode: result.recoveryBlocked.errorCode,
                    error: result.recoveryBlocked.errorCode,
                },
            };
        }
        return {
            handled: true,
            result: {
                ok: true,
                ...(result?.providerAcceptancePending === true
                    ? { providerAcceptancePending: true }
                    : {}),
            },
        };
    };
}
