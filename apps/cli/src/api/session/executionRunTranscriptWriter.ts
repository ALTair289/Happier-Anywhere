import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';

export function createExecutionRunTranscriptWriter(params: Readonly<{
    parentProvider: ACPProvider;
    randomId: () => string;
    sendUserTextMessage: (text: string, options: Readonly<{ meta: Record<string, unknown> }>) => void;
    sendAgentMessage: (
        provider: ACPProvider,
        body: ACPMessageData,
        options: Readonly<{ meta: Record<string, unknown> }>,
    ) => void;
    sendUserTextMessageCommitted: (
        text: string,
        options: Readonly<{ localId: string; meta: Record<string, unknown> }>,
    ) => Promise<void>;
    sendAgentMessageCommitted: (
        provider: ACPProvider,
        body: ACPMessageData,
        options: Readonly<{ localId: string; meta: Record<string, unknown> }>,
    ) => Promise<void>;
}>) {
    return {
        appendUserText: (text: string, meta: Record<string, unknown>) => {
            params.sendUserTextMessage(text, { meta });
        },
        appendAssistantText: (text: string, meta: Record<string, unknown>) => {
            params.sendAgentMessage(params.parentProvider, { type: 'message', message: text }, { meta });
        },
        appendUserTextCommitted: async (
            text: string,
            options: Readonly<{ localId: string; meta: Record<string, unknown> }>,
        ) => {
            await params.sendUserTextMessageCommitted(text, options);
        },
        appendAssistantTextCommitted: async (text: string, meta: Record<string, unknown>) => {
            await params.sendAgentMessageCommitted(
                params.parentProvider,
                { type: 'message', message: text },
                { localId: params.randomId(), meta },
            );
        },
    };
}
