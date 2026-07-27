import {
    CURRENT_SESSION_SYNC_PROTOCOL_VERSION,
    ClientCompatibilityDeclarationV1Schema,
    buildClientCompatibilityHttpHeadersV1,
    buildClientCompatibilitySocketAuthV1,
    type ClientCompatibilityDeclarationV1,
    type ClientCompatibilityHttpHeadersV1,
    type ClientCompatibilitySocketAuthV1,
} from '@happier-dev/protocol';
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

function resolveUiClientKind(input: Pick<ResolveUiClientCompatibilityDeclarationInput, 'platformOs' | 'isDesktop'>): ClientCompatibilityDeclarationV1['clientKind'] {
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
): ClientCompatibilityDeclarationV1 {
    return ClientCompatibilityDeclarationV1Schema.parse({
        v: 1,
        clientKind: resolveUiClientKind(input),
        appVersion: normalizeAppVersion(input.appVersion, input.nativeApplicationVersion),
        ...(normalizeReleaseChannel(input.releaseChannel)
            ? { releaseChannel: normalizeReleaseChannel(input.releaseChannel) }
            : {}),
        sessionSyncProtocolVersion: CURRENT_SESSION_SYNC_PROTOCOL_VERSION,
    });
}

export function readCurrentUiClientCompatibilityDeclaration(): ClientCompatibilityDeclarationV1 {
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

export function buildUiClientCompatibilityHttpHeaders(
    declaration: ClientCompatibilityDeclarationV1 = readCurrentUiClientCompatibilityDeclaration(),
): ClientCompatibilityHttpHeadersV1 {
    return buildClientCompatibilityHttpHeadersV1(declaration);
}

export function buildUiClientCompatibilitySocketAuth(
    declaration: ClientCompatibilityDeclarationV1 = readCurrentUiClientCompatibilityDeclaration(),
): ClientCompatibilitySocketAuthV1 {
    return buildClientCompatibilitySocketAuthV1(declaration);
}
