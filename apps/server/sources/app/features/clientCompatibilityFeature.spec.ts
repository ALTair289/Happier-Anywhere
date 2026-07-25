import { describe, expect, it } from 'vitest';
import { resolveClientCompatibilityFeature } from './clientCompatibilityFeature';

describe('client compatibility HTTP feature payload', () => {
    it('publishes current independently from configurable minimum', () => {
        expect(resolveClientCompatibilityFeature({
            HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_PROTOCOL_VERSION: '1',
        } as NodeJS.ProcessEnv)).toMatchObject({ capabilities: { compatibility: { sessionSync: {
            minimumSessionSyncProtocolVersion: 1,
            currentSessionSyncProtocolVersion: 2,
        }, pendingInput: {
            currentPendingInputProtocolVersion: 1,
        } } } });
    });
});
