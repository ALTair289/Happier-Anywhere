import { Platform } from 'react-native';
import Constants from 'expo-constants';

import { isTauriDesktop } from '@/utils/platform/tauri';

type ResolveUiClientCompatibilityDeclarationInput = Readonly<{
    platformOs: string;
    isDesktop: boolean;
    appVersion: string | null;
    nativeApplicationVersion: string | null;
    releaseChannel: string | null;
}>;

type UiClientVersionIdentity = Readonly<{
    clientKind: 'ui-web' | 'ui-ios' | 'ui-android' | 'ui-desktop';
    appVersion: string;
    releaseChannel?: string;
}>;

function resolveUiClientKind(input: Pick<ResolveUiClientCompatibilityDeclarationInput, 'platformOs' | 'isDesktop'>): UiClientVersionIdentity['clientKind'] {
    if (input.isDesktop) return 'ui-desktop';
    if (input.platformOs === 'ios') return 'ui-ios';
    if (input.platformOs === 'android') return 'ui-android';
    return 'ui-web';
}

function normalizeAppVersion(...candidates: readonly (string | null)[]): string {
    for (const candidate of candidates) {
        const value = typeof candidate === 'string' ? candidate.trim() : '';
        if (/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,95}$/.test(value)) return value;
    }
    // A declaration is mandatory for protocol-v2 transports. Unknown builds
    // declare the lowest honest comparable version so a required policy fails
    // closed into the canonical upgrade flow instead of omitting the contract.
    return '0.0.0';
}

function normalizeReleaseChannel(value: string | null): string | undefined {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return /^[a-z0-9][a-z0-9-]{0,31}$/.test(normalized) ? normalized : undefined;
}

export function resolveUiClientCompatibilityDeclaration(
    input: ResolveUiClientCompatibilityDeclarationInput,
): UiClientVersionIdentity {
    return {
        clientKind: resolveUiClientKind(input),
        appVersion: normalizeAppVersion(input.appVersion, input.nativeApplicationVersion),
        ...(normalizeReleaseChannel(input.releaseChannel)
            ? { releaseChannel: normalizeReleaseChannel(input.releaseChannel) }
            : {}),
    };
}

export function readCurrentUiClientCompatibilityDeclaration(): UiClientVersionIdentity {
    const requestHeaders = Constants.expoConfig?.updates?.requestHeaders;
    const configuredReleaseChannel = requestHeaders && typeof requestHeaders === 'object'
        ? (requestHeaders as Record<string, unknown>)['expo-channel-name']
        : null;
    return resolveUiClientCompatibilityDeclaration({
        platformOs: Platform.OS,
        isDesktop: isTauriDesktop(),
        appVersion: typeof Constants.expoConfig?.version === 'string' ? Constants.expoConfig.version : null,
        nativeApplicationVersion: null,
        releaseChannel: typeof configuredReleaseChannel === 'string'
            ? configuredReleaseChannel
            : String(process.env.EXPO_PUBLIC_APP_ENV ?? process.env.APP_ENV ?? '').trim() || null,
    });
}
