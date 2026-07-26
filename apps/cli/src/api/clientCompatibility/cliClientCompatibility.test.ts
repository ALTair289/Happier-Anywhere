import { describe, expect, it } from 'vitest';

import {
    buildCliClientCompatibilityHttpHeaders,
    buildCliClientCompatibilitySocketAuth,
    readCliClientUpgradeRequired,
    resolveCliClientCompatibilityDeclaration,
} from './cliClientCompatibility';

describe('CLI session-sync compatibility declaration', () => {
    it('builds one protocol-owned declaration for CLI, daemon, and session-runner transports', () => {
        for (const clientKind of ['cli', 'daemon', 'session-runner'] as const) {
            const declaration = resolveCliClientCompatibilityDeclaration({
                clientKind,
                appVersion: '0.2.10',
                releaseChannel: 'preview',
            });
            expect(declaration).toEqual({
                v: 1,
                clientKind,
                appVersion: '0.2.10',
                releaseChannel: 'preview',
                sessionSyncProtocolVersion: 2,
            });
            expect(buildCliClientCompatibilitySocketAuth(declaration)).toEqual({ clientCompatibility: declaration });
            expect(buildCliClientCompatibilityHttpHeaders(declaration)).toMatchObject({
                'x-happier-client-kind': clientKind,
                'x-happier-session-sync-protocol': '2',
            });
        }
    });

    it('fails closed to version 0.0.0 and omits malformed release channels', () => {
        expect(resolveCliClientCompatibilityDeclaration({
            clientKind: 'session-runner',
            appVersion: ' bad version ',
            releaseChannel: 'Preview!',
        })).toEqual({
            v: 1,
            clientKind: 'session-runner',
            appVersion: '0.0.0',
            sessionSyncProtocolVersion: 2,
        });
    });

    it('recognizes the server RPC registration error envelope without weakening the strict payload schema', () => {
        expect(readCliClientUpgradeRequired({
            type: 'register',
            error: 'client-upgrade-required',
            requirement: {
                v: 1,
                minimumSessionSyncProtocolVersion: 2,
                clientKind: 'daemon',
                minimumAppVersion: '0.3.0',
                updateUrl: 'https://example.test/update',
            },
        })).toEqual({
            error: 'client-upgrade-required',
            requirement: {
                v: 1,
                minimumSessionSyncProtocolVersion: 2,
                clientKind: 'daemon',
                minimumAppVersion: '0.3.0',
                updateUrl: 'https://example.test/update',
            },
        });
    });
});
