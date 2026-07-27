import { describe, expect, it, vi } from 'vitest';

import { createClaudeReadyHandler } from './createClaudeReadyHandler';

function createReadySession() {
    return {
        sessionId: 'session-test',
        sendSessionEvent: vi.fn(),
    };
}

describe('createClaudeReadyHandler', () => {
    it('emits the ready session event when nothing is pending or queued', () => {
        const session = createReadySession();
        const handler = createClaudeReadyHandler({
            session,
            pushSender: null,
            waitingForCommandLabel: 'Claude',
            logPrefix: '[test]',
            getPending: () => null,
            getQueueSize: () => 0,
        });

        handler();

        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
    });

    it('suppresses ready while genuinely-deliverable queued work remains', () => {
        const session = createReadySession();
        const handler = createClaudeReadyHandler({
            session,
            pushSender: null,
            waitingForCommandLabel: 'Claude',
            logPrefix: '[test]',
            getPending: () => null,
            getQueueSize: () => 1,
            hasOnlyBlockedPendingWork: () => false,
        });

        handler();

        expect(session.sendSessionEvent).not.toHaveBeenCalled();
    });

    it('still emits ready when the only pending work is blocked/undeliverable', () => {
        // A row escalated to a blocked (undeliverable) state must not suppress the
        // completed-turn ready event + push forever. A non-empty local queue whose canonical pending
        // work is entirely blocked cannot advance, so the completed turn must still notify.
        const session = createReadySession();
        const handler = createClaudeReadyHandler({
            session,
            pushSender: null,
            waitingForCommandLabel: 'Claude',
            logPrefix: '[test]',
            getPending: () => null,
            getQueueSize: () => 1,
            hasOnlyBlockedPendingWork: () => true,
        });

        handler();

        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
    });
});
