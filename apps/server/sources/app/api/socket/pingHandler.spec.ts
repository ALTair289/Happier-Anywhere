import { describe, expect, it, vi } from 'vitest';

import { pingHandler } from './pingHandler';

describe('pingHandler', () => {
    it('acks the exact socket with the canonical current session-sync requirements', async () => {
        let handler: ((callback: (response: unknown) => void) => Promise<void>) | undefined;
        const socket = {
            on: vi.fn((event: string, listener: typeof handler) => {
                if (event === 'ping') handler = listener;
            }),
        };

        pingHandler(socket as never, { env: {} });
        const callback = vi.fn();
        await handler?.(callback);

        expect(callback).toHaveBeenCalledWith({
            v: 1,
            compatibility: {
                v: 1,
                sessionSync: expect.objectContaining({
                    currentSessionSyncProtocolVersion: 2,
                }),
                pendingInput: {
                    currentPendingInputProtocolVersion: 1,
                },
            },
        });
    });
});
