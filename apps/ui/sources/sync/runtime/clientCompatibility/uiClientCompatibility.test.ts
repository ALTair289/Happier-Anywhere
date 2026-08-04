import { describe, expect, it } from 'vitest';

import { resolveUiClientCompatibilityDeclaration } from './uiClientCompatibility';

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
            clientKind,
            appVersion: '0.2.10',
            releaseChannel: 'preview',
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
            clientKind: 'ui-web',
            appVersion: '0.2.11',
        });
    });
});
