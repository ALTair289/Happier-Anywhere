import { afterEach, describe, expect, it } from 'vitest';

import {
    clearSessionRealtimeTranscriptSuppression,
    enableSessionRealtimeTranscriptSuppression,
    installSessionRealtimeTranscriptSuppressionGlobal,
    isSessionRealtimeTranscriptSuppressed,
    SESSION_REALTIME_TRANSCRIPT_SUPPRESSION_GLOBAL_KEY,
} from './sessionRealtimeTranscriptSuppression';

type SuppressionGlobal = {
    suppress: (params: { sessionId: string; sourceServerId: string }) => boolean;
    clear: (params?: { sessionId?: string; sourceServerId?: string }) => number;
    isSuppressed: (params: { sessionId: string; sourceServerId: string }) => boolean;
    list: () => Array<{ sessionId: string; sourceServerId: string }>;
};

function readSuppressionGlobal(): SuppressionGlobal | undefined {
    return (globalThis as Record<string, unknown>)[SESSION_REALTIME_TRANSCRIPT_SUPPRESSION_GLOBAL_KEY] as SuppressionGlobal | undefined;
}

describe('session realtime transcript suppression fixture', () => {
    afterEach(() => {
        clearSessionRealtimeTranscriptSuppression(undefined, { isDevOrTest: true });
        delete (globalThis as Record<string, unknown>)[SESSION_REALTIME_TRANSCRIPT_SUPPRESSION_GLOBAL_KEY];
    });

    it('records only an exact session/source-server suppression', () => {
        expect(enableSessionRealtimeTranscriptSuppression({
            sessionId: 'session-1',
            sourceServerId: 'server-1',
        }, { isDevOrTest: true })).toBe(true);

        expect(isSessionRealtimeTranscriptSuppressed('session-1', 'server-1')).toBe(true);
        expect(isSessionRealtimeTranscriptSuppressed('session-2', 'server-1')).toBe(false);
        expect(isSessionRealtimeTranscriptSuppressed('session-1', 'server-2')).toBe(false);
        expect(isSessionRealtimeTranscriptSuppressed('session-1')).toBe(false);
    });

    it('keeps the mutating API inert outside dev/test', () => {
        expect(enableSessionRealtimeTranscriptSuppression({
            sessionId: 'session-1',
            sourceServerId: 'server-1',
        }, { isDevOrTest: false })).toBe(false);

        expect(isSessionRealtimeTranscriptSuppressed('session-1', 'server-1')).toBe(false);
        expect(clearSessionRealtimeTranscriptSuppression(undefined, { isDevOrTest: false })).toBe(0);
    });

    it('installs a dev/test browser command with an explicit clear operation', () => {
        installSessionRealtimeTranscriptSuppressionGlobal({ isDevOrTest: true });

        const api = readSuppressionGlobal();
        expect(api?.suppress({ sessionId: 'session-1', sourceServerId: 'server-1' })).toBe(true);
        expect(api?.isSuppressed({ sessionId: 'session-1', sourceServerId: 'server-1' })).toBe(true);
        expect(api?.list()).toEqual([{ sessionId: 'session-1', sourceServerId: 'server-1' }]);
        expect(api?.clear({ sessionId: 'session-1', sourceServerId: 'server-1' })).toBe(1);
        expect(api?.isSuppressed({ sessionId: 'session-1', sourceServerId: 'server-1' })).toBe(false);
    });

    it('does not install browser mutators outside dev/test', () => {
        installSessionRealtimeTranscriptSuppressionGlobal({ isDevOrTest: false });

        expect(readSuppressionGlobal()).toBeUndefined();
        expect(isSessionRealtimeTranscriptSuppressed('session-1', 'server-1')).toBe(false);
    });
});
