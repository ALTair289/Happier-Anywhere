import { describe, expect, it } from 'vitest';

import {
    buildUiClientCompatibilityHttpHeaders,
    buildUiClientCompatibilitySocketAuth,
    resolveUiClientCompatibilityDeclaration,
} from './uiClientCompatibility';

describe('UI session-sync compatibility declaration', () => {
    it.each([
        ['web', false, 'ui-web'],
        ['ios', false, 'ui-ios'],
        ['android', false, 'ui-android'],
        ['web', true, 'ui-desktop'],
    ] as const)('maps platform %s desktop=%s to %s', (platformOs, isDesktop, clientKind) => {
        expect(resolveUiClientCompatibilityDeclaration({
            platformOs,
            isDesktop,
            appVersion: '0.2.10',
            nativeApplicationVersion: null,
            releaseChannel: 'preview',
        })).toMatchObject({
            v: 1,
            clientKind,
            appVersion: '0.2.10',
            releaseChannel: 'preview',
            sessionSyncProtocolVersion: 2,
        });
    });

    it('prefers the native binary version and canonicalizes unsupported platform/channel values', () => {
        expect(resolveUiClientCompatibilityDeclaration({
            platformOs: 'windows',
            isDesktop: false,
            appVersion: null,
            nativeApplicationVersion: '0.2.11',
            releaseChannel: 'Preview Channel',
        })).toEqual({
            v: 1,
            clientKind: 'ui-web',
            appVersion: '0.2.11',
            sessionSyncProtocolVersion: 2,
        });
    });

    it('uses one declaration for HTTP and Socket.IO auth', () => {
        const declaration = resolveUiClientCompatibilityDeclaration({
            platformOs: 'web',
            isDesktop: false,
            appVersion: '0.2.10',
            nativeApplicationVersion: null,
            releaseChannel: 'production',
        });

        expect(buildUiClientCompatibilityHttpHeaders(declaration)).toEqual({
            'x-happier-client-kind': 'ui-web',
            'x-happier-client-version': '0.2.10',
            'x-happier-client-release-channel': 'production',
            'x-happier-session-sync-protocol': '2',
        });
        expect(buildUiClientCompatibilitySocketAuth(declaration)).toEqual({
            clientCompatibility: declaration,
        });
    });
});
