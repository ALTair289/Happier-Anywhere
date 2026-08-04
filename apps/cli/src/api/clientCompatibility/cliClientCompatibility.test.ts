import { describe, expect, it } from 'vitest';

import {
    readCliClientUpgradeRequired,
} from './cliClientCompatibility';

describe('CLI session-sync compatibility declaration', () => {
    it('recognizes the server RPC registration error envelope without weakening the strict payload schema', () => {
        expect(readCliClientUpgradeRequired({
            type: 'register',
            error: 'client-upgrade-required',
            requirement: {
                v: 1,
                clientKind: 'daemon',
                minimumAppVersion: '0.3.0',
                updateUrl: 'https://example.test/update',
            },
        })).toEqual({
            error: 'client-upgrade-required',
            requirement: {
                v: 1,
                clientKind: 'daemon',
                minimumAppVersion: '0.3.0',
                updateUrl: 'https://example.test/update',
            },
        });
    });
});
