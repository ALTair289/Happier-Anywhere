import { describe, expect, it } from 'vitest';

import type { AgentTextMessage, Message, UserTextMessage } from '@/sync/domains/messages/messageTypes';

import { resolveTranscriptRowPaintedIdentities } from './transcriptRowPaintedIdentities';

const userMessage = {
    kind: 'user-text',
    id: 'user-1',
    localId: 'local-user-1',
    createdAt: 1,
    text: 'hello',
} satisfies UserTextMessage;

const agentMessage = {
    kind: 'agent-text',
    id: 'agent-1',
    localId: 'local-agent-1',
    createdAt: 2,
    text: 'hi',
} satisfies AgentTextMessage;

const messages = new Map<string, Message>([
    [userMessage.id, userMessage],
    [agentMessage.id, agentMessage],
]);
const getMessageById = (messageId: string) => messages.get(messageId) ?? null;

describe('resolveTranscriptRowPaintedIdentities', () => {
    it('maps both sides of the pending-to-committed user utterance handover to one identity', () => {
        expect(resolveTranscriptRowPaintedIdentities({
            kind: 'pending-queue',
            pendingMessages: [{ localId: userMessage.localId }],
        }, getMessageById)).toEqual(['utterance:local-user-1']);

        expect(resolveTranscriptRowPaintedIdentities({
            kind: 'message',
            messageId: userMessage.id,
        }, getMessageById)).toEqual(['utterance:local-user-1']);

        expect(resolveTranscriptRowPaintedIdentities({
            kind: 'turn',
            turn: { userMessageId: userMessage.id },
        }, getMessageById)).toEqual(['utterance:local-user-1']);
    });

    it('does not classify an agent row localId as a user utterance identity', () => {
        expect(resolveTranscriptRowPaintedIdentities({
            kind: 'message',
            messageId: agentMessage.id,
        }, getMessageById)).toBeNull();
    });
});
