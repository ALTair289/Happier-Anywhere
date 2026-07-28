import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/http/client', () => ({
    abortServerFetches: vi.fn(),
}));

vi.mock('@/sync/sync', () => ({
    syncSwitchServer: vi.fn(async () => {}),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentials: vi.fn(async () => null),
        getCredentialsForServerUrl: vi.fn(async () => null),
    },
}));

function randomScope(): string {
    return `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function stubWebRuntime(origin: string) {
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, String(value)),
        removeItem: (key: string) => void store.delete(key),
        clear: () => void store.clear(),
    });
    vi.stubGlobal('window', { location: { origin } });
    vi.stubGlobal('document', {});
}

async function importFreshServerModules() {
    vi.resetModules();
    const [profiles, switches] = await Promise.all([
        import('./serverProfiles'),
        import('./activeServerSwitch'),
    ]);
    return { profiles, switches };
}

describe('activeServerSwitch device scope', () => {
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;

    afterEach(() => {
        vi.unstubAllGlobals();
        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
    });

    it('promotes the current tab active server to the device active server by id', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        stubWebRuntime('https://origin.example.test');

        const { profiles, switches } = await importFreshServerModules();
        const deviceProfile = profiles.upsertServerProfile({
            serverUrl: 'https://device.example.test',
            name: 'Device',
        });
        const tabProfile = profiles.upsertServerProfile({
            serverUrl: 'https://tab.example.test',
            name: 'Tab',
        });
        profiles.setActiveServerId(deviceProfile.id, { scope: 'device' });
        profiles.setActiveServerId(tabProfile.id, { scope: 'tab' });

        const switched = await switches.setActiveServerAndSwitch({
            serverId: tabProfile.id,
            scope: 'device',
        });

        expect(switched).toBe(true);
        expect(profiles.getTabActiveServerId()).toBeNull();
        expect(profiles.getDeviceDefaultServerId()).toBe(tabProfile.id);
        expect(profiles.getActiveServerId()).toBe(tabProfile.id);
    });

    it('promotes the current tab active server to the device active server by url', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        stubWebRuntime('https://origin.example.test');

        const { profiles, switches } = await importFreshServerModules();
        const deviceProfile = profiles.upsertServerProfile({
            serverUrl: 'https://device.example.test',
            name: 'Device',
        });
        const tabProfile = profiles.upsertServerProfile({
            serverUrl: 'https://tab.example.test',
            name: 'Tab',
        });
        profiles.setActiveServerId(deviceProfile.id, { scope: 'device' });
        profiles.setActiveServerId(tabProfile.id, { scope: 'tab' });

        const switched = await switches.upsertActivateAndSwitchServer({
            serverUrl: tabProfile.serverUrl,
            source: 'url',
            scope: 'device',
        });

        expect(switched).toBe(true);
        expect(profiles.getTabActiveServerId()).toBeNull();
        expect(profiles.getDeviceDefaultServerId()).toBe(tabProfile.id);
        expect(profiles.getActiveServerUrl()).toBe('https://tab.example.test');
    });

    it('skips a device switch when the durable target id already resolves to the device default profile', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        stubWebRuntime('https://origin.example.test');

        const { profiles, switches } = await importFreshServerModules();
        const profile = profiles.upsertServerProfile({
            serverUrl: 'https://relay.example.test',
            name: 'Relay',
        });
        profiles.setActiveServerId(profile.id, { scope: 'device' });
        profiles.setServerProfileIdentityForUrl(profile.serverUrl, 'srv_identity_same_server');

        const syncModule = await import('@/sync/sync');
        const syncSwitchServer = vi.mocked(syncModule.syncSwitchServer);
        syncSwitchServer.mockClear();

        const switched = await switches.setActiveServerAndSwitch({
            serverId: 'srv_identity_same_server',
            scope: 'device',
        });

        expect(switched).toBe(false);
        expect(syncSwitchServer).not.toHaveBeenCalled();
        expect(profiles.getTabActiveServerId()).toBeNull();
        expect(profiles.getDeviceDefaultServerId()).toBe(profile.id);
        expect(profiles.getActiveServerId()).toBe('srv_identity_same_server');
    });

    it('can re-establish connection and auth even when bootstrap already activated the target url', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        stubWebRuntime('https://origin.example.test');

        const { profiles, switches } = await importFreshServerModules();
        const profile = profiles.upsertServerProfile({
            serverUrl: 'https://relay.example.test',
            name: 'Relay',
        });
        profiles.setActiveServerId(profile.id, { scope: 'device' });
        const syncModule = await import('@/sync/sync');
        const syncSwitchServer = vi.mocked(syncModule.syncSwitchServer);
        syncSwitchServer.mockClear();
        const refreshAuth = vi.fn(async () => undefined);

        const switched = await switches.upsertActivateAndSwitchServer({
            serverUrl: profile.serverUrl,
            scope: 'device',
            refreshAuth,
            ensureConnection: true,
        });

        expect(switched).toBe(false);
        expect(syncSwitchServer).toHaveBeenCalledTimes(1);
        expect(refreshAuth).toHaveBeenCalledTimes(1);
    });
});
