import { describe, expect, it, vi } from 'vitest';

import { createExecutionRunTranscriptWriter } from './executionRunTranscriptWriter';

describe('createExecutionRunTranscriptWriter', () => {
    it('carries the outer durable localId into the committed user writer without replacing it', async () => {
        const deterministicRandomIdTrap = vi.fn(() => 'random-id-trap');
        const sendUserTextMessageCommitted = vi.fn(async () => {});
        const writer = createExecutionRunTranscriptWriter({
            parentProvider: 'claude',
            randomId: deterministicRandomIdTrap,
            sendUserTextMessage: vi.fn(),
            sendAgentMessage: vi.fn(),
            sendUserTextMessageCommitted,
            sendAgentMessageCommitted: vi.fn(async () => {}),
        });

        await writer.appendUserTextCommitted('Persist this user turn', {
            localId: ' durable-outer-id ',
            meta: { source: 'cli' },
        });

        expect(sendUserTextMessageCommitted).toHaveBeenCalledWith(
            'Persist this user turn',
            {
                localId: ' durable-outer-id ',
                meta: { source: 'cli' },
            },
        );
        expect(deterministicRandomIdTrap).not.toHaveBeenCalled();
    });
});
