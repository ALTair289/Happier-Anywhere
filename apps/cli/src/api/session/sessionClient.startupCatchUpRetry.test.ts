import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';
import { HttpStatusError } from '../client/httpStatusError';

import { ApiSessionClient } from './sessionClient';

function createOnlineConnectionState() {
    return {
        phase: 'online',
        reason: null,
        attempt: 0,
        nextRetryAt: null,
        lastConnectedAt: Date.now(),
        lastDisconnectedAt: null,
        lastErrorMessage: null,
    } as const;
}

describe('ApiSessionClient startup transcript catch-up retries', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('keeps retrying startup transcript catch-up after messages have already been observed', async () => {
        const client = Object.create(ApiSessionClient.prototype) as {
            closed: boolean;
            lastObservedMessageSeq: number;
            startupMessageCatchUpInitialAfterSeq: number;
            startupMessageCatchUpRetryTimer: ReturnType<typeof setTimeout> | null;
            startupMessageCatchUpRetryIndex: number;
            catchUpSessionMessages: (request: { afterSeq: number; authorization: 'startup_recovery' | 'explicit_cursor' | 'reconnect_watermark' }) => Promise<void>;
            shouldRunStartupTranscriptCatchUp: () => boolean;
            scheduleNextStartupMessageCatchUpRetry: () => void;
        };

        client.closed = false;
        client.lastObservedMessageSeq = 1;
        client.startupMessageCatchUpInitialAfterSeq = 1;
        client.startupMessageCatchUpRetryTimer = null;
        client.startupMessageCatchUpRetryIndex = 0;
        client.catchUpSessionMessages = vi.fn(async () => {});
        client.shouldRunStartupTranscriptCatchUp = vi.fn(() => true);

        client.scheduleNextStartupMessageCatchUpRetry();

        await vi.advanceTimersByTimeAsync(300);
        await Promise.resolve();

        expect(client.catchUpSessionMessages).toHaveBeenCalledTimes(1);
        expect(client.catchUpSessionMessages).toHaveBeenCalledWith({
            afterSeq: 1,
            authorization: 'startup_recovery',
        });
    });

    it('retries startup transcript catch-up from the initial afterSeq even if a local echo advances the live cursor', async () => {
        const client = Object.create(ApiSessionClient.prototype) as {
            closed: boolean;
            lastObservedMessageSeq: number;
            startupMessageCatchUpInitialAfterSeq: number;
            startupMessageCatchUpRetryTimer: ReturnType<typeof setTimeout> | null;
            startupMessageCatchUpRetryIndex: number;
            catchUpSessionMessages: (request: { afterSeq: number; authorization: 'startup_recovery' | 'explicit_cursor' | 'reconnect_watermark' }) => Promise<void>;
            shouldRunStartupTranscriptCatchUp: () => boolean;
            scheduleNextStartupMessageCatchUpRetry: () => void;
        };

        client.closed = false;
        client.lastObservedMessageSeq = 1;
        client.startupMessageCatchUpInitialAfterSeq = 0;
        client.startupMessageCatchUpRetryTimer = null;
        client.startupMessageCatchUpRetryIndex = 0;
        client.catchUpSessionMessages = vi.fn(async () => {});
        client.shouldRunStartupTranscriptCatchUp = vi.fn(() => true);

        client.scheduleNextStartupMessageCatchUpRetry();

        await vi.advanceTimersByTimeAsync(300);
        await Promise.resolve();

        expect(client.catchUpSessionMessages).toHaveBeenCalledTimes(1);
        expect(client.catchUpSessionMessages).toHaveBeenCalledWith({
            afterSeq: 0,
            authorization: 'startup_recovery',
        });
    });

    it('reports terminal auth failures from transcript catch-up into the session supervisor', async () => {
        const reportProbeResult = vi.fn();
        const authError = new HttpStatusError(401, 'expired token');
        vi.spyOn(axios, 'get').mockRejectedValueOnce(authError);

        const client = Object.create(ApiSessionClient.prototype) as {
            token: string;
            sessionId: string;
            sessionConnectionSupervisor: {
                getState: () => ReturnType<typeof createOnlineConnectionState>;
                reportProbeResult: ReturnType<typeof vi.fn>;
            };
            handleUpdate: ReturnType<typeof vi.fn>;
            catchUpSessionMessages: (request: { afterSeq: number; authorization: 'startup_recovery' | 'explicit_cursor' | 'reconnect_watermark' }) => Promise<void>;
        };

        client.token = 'expired';
        client.sessionId = 's1';
        client.sessionConnectionSupervisor = {
            getState: () => createOnlineConnectionState(),
            reportProbeResult,
        };
        client.handleUpdate = vi.fn();

        await expect(client.catchUpSessionMessages({
            afterSeq: 10,
            authorization: 'explicit_cursor',
        })).rejects.toMatchObject({
            name: 'HttpStatusError',
            code: 'not_authenticated',
            response: { status: 401 },
        });
        expect(reportProbeResult).toHaveBeenCalledWith({
            status: 'auth_failed',
            statusCode: 401,
            errorMessage: expect.stringContaining('Authentication failed during session message catch-up'),
        });
    });

    it('does not keep retrying startup transcript catch-up after terminal auth', async () => {
        const client = Object.create(ApiSessionClient.prototype) as {
            closed: boolean;
            currentConnectionState: ReturnType<typeof createOnlineConnectionState>;
            startupMessageCatchUpInitialAfterSeq: number;
            startupMessageCatchUpRetryTimer: ReturnType<typeof setTimeout> | null;
            startupMessageCatchUpRetryIndex: number;
            catchUpSessionMessages: (request: { afterSeq: number; authorization: 'startup_recovery' | 'explicit_cursor' | 'reconnect_watermark' }) => Promise<void>;
            shouldRunStartupTranscriptCatchUp: () => boolean;
            scheduleNextStartupMessageCatchUpRetry: () => void;
        };

        client.closed = false;
        client.currentConnectionState = createOnlineConnectionState();
        client.startupMessageCatchUpInitialAfterSeq = 0;
        client.startupMessageCatchUpRetryTimer = null;
        client.startupMessageCatchUpRetryIndex = 0;
        client.catchUpSessionMessages = vi.fn(async () => {
            throw new HttpStatusError(401, 'expired token');
        });
        client.shouldRunStartupTranscriptCatchUp = vi.fn(() => true);

        client.scheduleNextStartupMessageCatchUpRetry();

        await vi.advanceTimersByTimeAsync(300);
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1_200);
        await Promise.resolve();

        expect(client.catchUpSessionMessages).toHaveBeenCalledTimes(1);
    });

    it('keeps retrying startup transcript catch-up after non-auth failures', async () => {
        const client = Object.create(ApiSessionClient.prototype) as {
            closed: boolean;
            currentConnectionState: ReturnType<typeof createOnlineConnectionState>;
            startupMessageCatchUpInitialAfterSeq: number;
            startupMessageCatchUpRetryTimer: ReturnType<typeof setTimeout> | null;
            startupMessageCatchUpRetryIndex: number;
            catchUpSessionMessages: (request: { afterSeq: number; authorization: 'startup_recovery' | 'explicit_cursor' | 'reconnect_watermark' }) => Promise<void>;
            shouldRunStartupTranscriptCatchUp: () => boolean;
            scheduleNextStartupMessageCatchUpRetry: () => void;
        };

        client.closed = false;
        client.currentConnectionState = createOnlineConnectionState();
        client.startupMessageCatchUpInitialAfterSeq = 0;
        client.startupMessageCatchUpRetryTimer = null;
        client.startupMessageCatchUpRetryIndex = 0;
        client.catchUpSessionMessages = vi
            .fn()
            .mockRejectedValueOnce(new Error('temporary server failure'))
            .mockResolvedValue(undefined);
        client.shouldRunStartupTranscriptCatchUp = vi.fn(() => true);

        client.scheduleNextStartupMessageCatchUpRetry();

        await vi.advanceTimersByTimeAsync(300);
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1_200);
        await Promise.resolve();

        expect(client.catchUpSessionMessages).toHaveBeenCalledTimes(2);
        expect(client.catchUpSessionMessages).toHaveBeenNthCalledWith(1, {
            afterSeq: 0,
            authorization: 'startup_recovery',
        });
        expect(client.catchUpSessionMessages).toHaveBeenNthCalledWith(2, {
            afterSeq: 0,
            authorization: 'startup_recovery',
        });
    });
});
