import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionStatus } from 'expo-modules-core';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';

const pushApiMocks = vi.hoisted(() => ({
    registerPushToken: vi.fn(async () => {}),
    deletePushToken: vi.fn(async () => {}),
}));

vi.mock('@/sync/api/session/apiPush', () => ({
    registerPushToken: pushApiMocks.registerPushToken,
    deletePushToken: pushApiMocks.deletePushToken,
}));

vi.mock('@/sync/domains/state/pushTokenRegistration', () => ({
    loadLastRegisteredExpoPushToken: () => null,
    saveLastRegisteredExpoPushToken: vi.fn(),
    clearLastRegisteredExpoPushToken: vi.fn(),
}));

vi.mock('expo-notifications', () => ({
    getPermissionsAsync: vi.fn(),
    requestPermissionsAsync: vi.fn(),
    getExpoPushTokenAsync: vi.fn(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                        Platform: {
                            OS: 'ios',
                        },
                    }
    );
});

vi.mock('expo-constants', () => ({
    default: { expoConfig: { extra: { eas: { projectId: 'test-project' } } } },
}));

vi.mock('expo-secure-store', () => {
    const store = new Map<string, string>();
    return {
        getItemAsync: async (key: string) => store.get(key) ?? null,
        setItemAsync: async (key: string, value: string) => {
            store.set(key, value);
        },
        deleteItemAsync: async (key: string) => {
            store.delete(key);
        },
    };
});

afterEach(() => {
    vi.restoreAllMocks();
    pushApiMocks.registerPushToken.mockClear();
    pushApiMocks.deletePushToken.mockClear();
    vi.clearAllMocks();
});

describe('registerPushTokenIfAvailable (multi-server)', () => {
    it('registers for all saved servers with credentials', async () => {
        const Notifications = await import('expo-notifications');
        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
            status: PermissionStatus.GRANTED,
            expires: 'never',
            granted: true,
            canAskAgain: false,
        } satisfies Awaited<ReturnType<typeof Notifications.getPermissionsAsync>>);
        vi.mocked(Notifications.requestPermissionsAsync).mockResolvedValue({
            status: PermissionStatus.GRANTED,
            expires: 'never',
            granted: true,
            canAskAgain: false,
        } satisfies Awaited<ReturnType<typeof Notifications.requestPermissionsAsync>>);
        vi.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValue({
            type: 'expo',
            data: 'ExponentPushToken[secret-token]',
        } satisfies Awaited<ReturnType<typeof Notifications.getExpoPushTokenAsync>>);

        const { upsertServerProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        const defaultServer = upsertServerProfile({ serverUrl: 'https://remote-a.example.test', name: 'Primary' });
        const company = upsertServerProfile({ serverUrl: 'https://company.example.test', name: 'Company' });

        const { TokenStorage } = await import('@/auth/storage/tokenStorage');

        setActiveServerId(defaultServer.id, { scope: 'device' });
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (_serverUrl, options) => {
            if (options?.serverId === defaultServer.id) {
                return { token: 't_primary', secret: 's' };
            }
            if (options?.serverId === company.id) {
                return { token: 't_company', secret: 's' };
            }
            return null;
        });

        const messages: string[] = [];
        const log = { log: (message: string) => messages.push(message) };

        const { registerPushTokenIfAvailable } = await import('./syncAccount');
        await registerPushTokenIfAvailable({
            credentials: { token: 't_primary', secret: 's' } satisfies AuthCredentials,
            log,
            getAccountSettings: () => ({}),
        });

        expect(pushApiMocks.registerPushToken).toHaveBeenCalledWith(
            { token: 't_primary', secret: 's' },
            'ExponentPushToken[secret-token]',
            expect.objectContaining({
                apiEndpoint: 'https://remote-a.example.test',
                clientServerUrl: 'https://remote-a.example.test',
            }),
        );
        expect(pushApiMocks.registerPushToken).toHaveBeenCalledWith(
            { token: 't_company', secret: 's' },
            'ExponentPushToken[secret-token]',
            expect.objectContaining({
                apiEndpoint: 'https://company.example.test',
                clientServerUrl: 'https://company.example.test',
            }),
        );
        expect(messages.join('\n')).not.toContain('ExponentPushToken[secret-token]');
    });

    it('does not reuse another same-origin profile credentials when only one alternate profile is authenticated', async () => {
        vi.resetModules();
        const Notifications = await import('expo-notifications');
        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
            status: PermissionStatus.GRANTED,
            expires: 'never',
            granted: true,
            canAskAgain: false,
        } satisfies Awaited<ReturnType<typeof Notifications.getPermissionsAsync>>);
        vi.mocked(Notifications.requestPermissionsAsync).mockResolvedValue({
            status: PermissionStatus.GRANTED,
            expires: 'never',
            granted: true,
            canAskAgain: false,
        } satisfies Awaited<ReturnType<typeof Notifications.requestPermissionsAsync>>);
        vi.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValue({
            type: 'expo',
            data: 'ExponentPushToken[secret-token]',
        } satisfies Awaited<ReturnType<typeof Notifications.getExpoPushTokenAsync>>);

        const state = {
            activeServerId: 'server-a',
            profiles: [
                { id: 'server-a', serverUrl: 'https://shared.example.test', name: 'Primary', createdAt: 0, updatedAt: 0, lastUsedAt: 0 },
                { id: 'server-b', serverUrl: 'https://shared.example.test', name: 'Alternate', createdAt: 0, updatedAt: 0, lastUsedAt: 0 },
            ],
        };

        vi.doMock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
            return {
                ...actual,
                listServerProfiles: () => state.profiles,
                getActiveServerSnapshot: () => ({
                    serverId: state.activeServerId,
                    serverUrl: 'https://shared.example.test',
                    generation: 1,
                }),
            };
        });

        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (_serverUrl, options) => {
            if (options?.serverId === 'server-a') {
                return { token: 't_primary', secret: 's' };
            }
            if (!options?.serverId) {
                return { token: 't_primary', secret: 's' };
            }
            return null;
        });

        const messages: string[] = [];
        const log = { log: (message: string) => messages.push(message) };

        const { registerPushTokenIfAvailable } = await import('./syncAccount');
        await registerPushTokenIfAvailable({
            credentials: { token: 't_primary', secret: 's' } satisfies AuthCredentials,
            log,
            getAccountSettings: () => ({}),
        });

        expect(pushApiMocks.registerPushToken).toHaveBeenCalledTimes(1);
        expect(pushApiMocks.registerPushToken).toHaveBeenCalledWith(
            { token: 't_primary', secret: 's' },
            'ExponentPushToken[secret-token]',
            expect.objectContaining({
                serverId: 'server-a',
                apiEndpoint: 'https://shared.example.test',
                clientServerUrl: 'https://shared.example.test',
            }),
        );
        expect(messages.join('\n')).not.toContain('ExponentPushToken[secret-token]');

        vi.doUnmock('@/sync/domains/server/serverProfiles');
    });
});
