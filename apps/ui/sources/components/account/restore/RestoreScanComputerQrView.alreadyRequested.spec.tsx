import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { installRestoreScanComputerQrViewCommonModuleMocks } from './restoreScanComputerQrViewTestHelpers';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
    __DEV__?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as ReactActEnvironmentGlobal).__DEV__ = true;
type ExpoGlobalShim = NonNullable<typeof globalThis.expo>;
const expoShim = {
    EventEmitter: class {} as unknown as ExpoGlobalShim['EventEmitter'],
    SharedRef: class {} as unknown as ExpoGlobalShim['SharedRef'],
    SharedObject: class {} as unknown as ExpoGlobalShim['SharedObject'],
    NativeModule: class {} as unknown as ExpoGlobalShim['NativeModule'],
    modules: {} as ExpoGlobalShim['modules'],
} satisfies Partial<ExpoGlobalShim>;
(globalThis as typeof globalThis & { expo: ExpoGlobalShim }).expo = expoShim as ExpoGlobalShim;
process.env.EXPO_OS = 'web';

vi.mock('@/dev/reactNativeStub', async () => await import('../../../dev/reactNativeStub'));
vi.mock('@/dev/testkit/mocks/reactNative', async () => await import('../../../dev/testkit/mocks/reactNative'));
vi.mock('@/dev/testkit/mocks/router', async () => await import('../../../dev/testkit/mocks/router'));
vi.mock('@/dev/testkit/mocks/modal', async () => await import('../../../dev/testkit/mocks/modal'));
vi.mock('@/dev/testkit/mocks/text', async () => await import('../../../dev/testkit/mocks/text'));
vi.mock('@/dev/testkit/mocks/unistyles', async () => await import('../../../dev/testkit/mocks/unistyles'));
vi.mock('@/theme', async () => await import('../../../theme'));

const navigationState = vi.hoisted(() => ({
    isFocused: true,
}));

installRestoreScanComputerQrViewCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('../../../dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alertAsync: modalAlertAsyncSpy,
                prompt: vi.fn(async () => null),
            },
        }).module;
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('../../../dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    surface: '#fff',
                    text: '#000',
                    textSecondary: '#666',
                    divider: '#ddd',
                    overlay: {
                        scrim: 'rgba(0,0,0,0.3)',
                        scrimStrong: 'rgba(0,0,0,0.55)',
                        text: '#fff',
                        textSecondary: 'rgba(255,255,255,0.85)',
                    },
                },
            },
        });
    },
    reactNavigation: async () => {
        const { createReactNavigationNativeMock } = await import('../../../dev/testkit/mocks/reactNavigation');
        return {
            ...createReactNavigationNativeMock(),
            useIsFocused: () => navigationState.isFocused,
        };
    },
});

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => ({ state: 'enabled' }),
}));

const authLoginSpy = vi.hoisted(() => vi.fn(async () => {}));
const authRefreshSpy = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ login: authLoginSpy, refreshFromActiveServer: authRefreshSpy }),
}));

const modalAlertAsyncSpy = vi.fn(async () => {});

vi.mock('expo-constants', () => ({
    default: {
        deviceName: undefined,
    },
}));

const activeServerState = vi.hoisted(() => ({
    snapshot: {
        serverId: 'server-prior',
        serverUrl: 'https://stack.example.test',
        activeShareableServerUrl: null as string | null,
        generation: 1,
    },
}));
vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerUrl: () => activeServerState.snapshot.serverUrl,
}));
vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerState.snapshot,
}));

const upsertActivateAndSwitchServerSpy = vi.hoisted(() => vi.fn(async (params: { serverUrl: string }) => {
    activeServerState.snapshot = {
        serverId: 'server-target',
        serverUrl: params.serverUrl,
        activeShareableServerUrl: null,
        generation: activeServerState.snapshot.generation + 1,
    };
    return true;
}));
const setActiveServerAndSwitchSpy = vi.hoisted(() => vi.fn(async (params: { serverId: string }) => {
    activeServerState.snapshot = {
        serverId: params.serverId,
        serverUrl: params.serverId === 'server-prior' ? 'https://stack.example.test' : activeServerState.snapshot.serverUrl,
        activeShareableServerUrl: null,
        generation: activeServerState.snapshot.generation + 1,
    };
    return true;
}));
vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    normalizeServerUrl: (s: string) => s,
    upsertActivateAndSwitchServer: upsertActivateAndSwitchServerSpy,
    setActiveServerAndSwitch: setActiveServerAndSwitchSpy,
}));

let requestedServerTarget: string | null = null;
vi.mock('@/sync/domains/server/url/serverUrlOverridePolicy', () => ({
    resolveEffectiveServerUrlOverride: () => requestedServerTarget,
}));

vi.mock('@/sync/domains/server/url/serverUrlClassification', () => ({
    isLoopbackServerUrl: () => false,
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
    },
}));

let parsedPairingPayload: any = { pairId: 'pair_123', secret: 'secret_123', serverUrl: null };
vi.mock('@/auth/pairing/pairingUrl', () => ({
    buildPairingDeepLink: () => 'happier:///pair?v=1&pairId=p&secret=s',
    parsePairingDeepLink: () => parsedPairingPayload,
}));

const pairingRequestSpy = vi.fn(async () => ({ ok: false, reason: 'already_requested', status: 401 }));
const pairingClaimConsumeSpy = vi.fn(async () => ({
    ok: true,
    data: { state: 'requested', confirmCode: '123 456' },
}));
vi.mock('@/sync/api/account/apiPairingAuth', () => ({
    pairingClaimConsume: pairingClaimConsumeSpy,
    pairingRequest: pairingRequestSpy,
}));

const authQRStartSpy = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/auth/flows/qrStart', () => ({
    generateAuthKeyPair: () => ({ publicKey: new Uint8Array([1]), secretKey: new Uint8Array([2]) }),
    authQRStart: authQRStartSpy,
}));

const authQRWaitSpy = vi.hoisted(() => vi.fn(async () => null as null | { token: string; secret: Uint8Array }));
vi.mock('@/auth/flows/qrWait', () => ({
    authQRWait: authQRWaitSpy,
}));

const setCredentialsForServerUrlSpy = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        setCredentialsForServerUrl: setCredentialsForServerUrlSpy,
    },
}));

vi.mock('@/encryption/base64', () => ({
    encodeBase64: () => 'x',
}));

let lastScannerProps: any = null;
vi.mock('@/components/qr/QrCodeScannerView', () => ({
    QrCodeScannerView: (props: any) => {
        lastScannerProps = props;
        return React.createElement('QrCodeScannerView', props);
    },
}));

describe('RestoreScanComputerQrView (already requested)', () => {
    function resetPairingState() {
        navigationState.isFocused = true;
        activeServerState.snapshot = {
            serverId: 'server-prior',
            serverUrl: 'https://stack.example.test',
            activeShareableServerUrl: null,
            generation: 1,
        };
        authLoginSpy.mockReset();
        authLoginSpy.mockResolvedValue(undefined);
        authRefreshSpy.mockReset();
        authRefreshSpy.mockResolvedValue(undefined);
        authQRStartSpy.mockReset();
        authQRStartSpy.mockResolvedValue(true);
        authQRWaitSpy.mockReset();
        authQRWaitSpy.mockResolvedValue(null);
        setCredentialsForServerUrlSpy.mockReset();
        setCredentialsForServerUrlSpy.mockResolvedValue(true);
        upsertActivateAndSwitchServerSpy.mockClear();
        setActiveServerAndSwitchSpy.mockClear();
    }

    it('shows a friendly error when the pairing session already has a requested device', async () => {
        vi.resetModules();
        resetPairingState();
        modalAlertAsyncSpy.mockClear();
        parsedPairingPayload = { pairId: 'pair_123', secret: 'secret_123', serverUrl: null };
        requestedServerTarget = null;
        pairingRequestSpy.mockClear();
        pairingClaimConsumeSpy.mockClear();
        upsertActivateAndSwitchServerSpy.mockClear();
        lastScannerProps = null;

        const { RestoreScanComputerQrView } = await import('./RestoreScanComputerQrView');

        let tree: ReactTestRenderer | null = null;
        try {
            await act(async () => {
                tree = create(<RestoreScanComputerQrView />);
            });
            if (!tree) throw new Error('Expected renderer');
            expect(typeof lastScannerProps?.onScan).toBe('function');

            await act(async () => {
                await lastScannerProps.onScan('happier:///pair?v=1&pairId=pair_123&secret=secret_123');
            });

            expect(modalAlertAsyncSpy).toHaveBeenCalledWith(
                'connect.pairingAlreadyRequestedTitle',
                'connect.pairingAlreadyRequestedBody',
            );
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('consumes and polls the HTTPS claim origin without switching when authorization fails', async () => {
        vi.resetModules();
        resetPairingState();
        modalAlertAsyncSpy.mockClear();
        const claimId = `claim_${'a'.repeat(43)}`;
        parsedPairingPayload = { claimId, origin: 'https://relay.example.test' };
        requestedServerTarget = 'https://relay.example.test';
        pairingRequestSpy.mockClear();
        pairingClaimConsumeSpy.mockClear();
        upsertActivateAndSwitchServerSpy.mockClear();
        lastScannerProps = null;

        const { RestoreScanComputerQrView } = await import('./RestoreScanComputerQrView');

        let tree: ReactTestRenderer | null = null;
        try {
            await act(async () => {
                tree = create(<RestoreScanComputerQrView />);
            });
            if (!tree) throw new Error('Expected renderer');

            await act(async () => {
                await lastScannerProps.onScan(`happier:///pair?v=claim-v1&claimId=${claimId}&origin=https%3A%2F%2Frelay.example.test`);
            });

            expect(upsertActivateAndSwitchServerSpy).not.toHaveBeenCalled();
            expect(authQRStartSpy).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ serverUrl: 'https://relay.example.test' }),
            );
            expect(pairingClaimConsumeSpy).toHaveBeenCalledWith({
                claimId,
                origin: 'https://relay.example.test',
                publicKey: 'x',
                deviceLabel: undefined,
            });
            expect(pairingRequestSpy).not.toHaveBeenCalled();
            expect(JSON.stringify(pairingClaimConsumeSpy.mock.calls)).not.toContain('secret');
        } finally {
            act(() => {
            tree?.unmount();
            });
        }
    });

    it('switches exactly once only after claim authorization succeeds', async () => {
        vi.resetModules();
        resetPairingState();
        const claimId = `claim_${'b'.repeat(43)}`;
        parsedPairingPayload = { claimId, origin: 'https://relay.example.test' };
        requestedServerTarget = 'https://relay.example.test';
        pairingClaimConsumeSpy.mockClear();
        upsertActivateAndSwitchServerSpy.mockClear();
        authQRWaitSpy.mockResolvedValueOnce({ token: 'claim-token', secret: new Uint8Array([9]) });
        lastScannerProps = null;

        const { RestoreScanComputerQrView } = await import('./RestoreScanComputerQrView');
        let tree: ReactTestRenderer | null = null;
        try {
            await act(async () => {
                tree = create(<RestoreScanComputerQrView />);
            });
            await act(async () => {
                await lastScannerProps.onScan(`happier:///pair?v=claim-v1&claimId=${claimId}&origin=https%3A%2F%2Frelay.example.test`);
            });

            expect(upsertActivateAndSwitchServerSpy).toHaveBeenCalledTimes(1);
            expect(upsertActivateAndSwitchServerSpy).toHaveBeenCalledWith(expect.objectContaining({
                serverUrl: 'https://relay.example.test',
            }));
            expect(setCredentialsForServerUrlSpy).toHaveBeenCalledWith(
                { token: 'claim-token', secret: 'x' },
                'https://relay.example.test',
            );
            expect(authLoginSpy).not.toHaveBeenCalled();
            expect(authRefreshSpy).toHaveBeenCalled();
            expect(setActiveServerAndSwitchSpy).not.toHaveBeenCalled();
        } finally {
            act(() => tree?.unmount());
        }
    });

    it('ignores a second scan while the first claim operation is in flight', async () => {
        vi.resetModules();
        resetPairingState();
        const claimId = `claim_${'c'.repeat(43)}`;
        parsedPairingPayload = { claimId, origin: 'https://relay.example.test' };
        requestedServerTarget = 'https://relay.example.test';
        let resolveStart!: (value: boolean) => void;
        authQRStartSpy.mockImplementationOnce(async () => await new Promise<boolean>((resolve) => {
            resolveStart = resolve;
        }));
        lastScannerProps = null;

        const { RestoreScanComputerQrView } = await import('./RestoreScanComputerQrView');
        let tree: ReactTestRenderer | null = null;
        try {
            await act(async () => {
                tree = create(<RestoreScanComputerQrView />);
            });
            const first = lastScannerProps.onScan('first');
            const second = lastScannerProps.onScan('second');
            await Promise.resolve();
            expect(authQRStartSpy).toHaveBeenCalledTimes(1);
            resolveStart(false);
            await act(async () => {
                await Promise.all([first, second]);
            });
        } finally {
            act(() => tree?.unmount());
        }
    });

    it('does not switch or store credentials if another flow changes the active server while waiting', async () => {
        vi.resetModules();
        resetPairingState();
        const claimId = `claim_${'d'.repeat(43)}`;
        parsedPairingPayload = { claimId, origin: 'https://relay.example.test' };
        requestedServerTarget = 'https://relay.example.test';
        let resolveWait!: (value: { token: string; secret: Uint8Array }) => void;
        authQRWaitSpy.mockImplementationOnce(async () => await new Promise((resolve) => {
            resolveWait = resolve;
        }));
        lastScannerProps = null;

        const { RestoreScanComputerQrView } = await import('./RestoreScanComputerQrView');
        let tree: ReactTestRenderer | null = null;
        try {
            await act(async () => {
                tree = create(<RestoreScanComputerQrView />);
            });
            const scan = lastScannerProps.onScan('claim');
            await Promise.resolve();
            await Promise.resolve();
            activeServerState.snapshot = {
                serverId: 'external-server',
                serverUrl: 'https://external.example.test',
                activeShareableServerUrl: null,
                generation: 2,
            };
            resolveWait({ token: 'must-not-store', secret: new Uint8Array([3]) });
            await act(async () => {
                await scan;
            });

            expect(upsertActivateAndSwitchServerSpy).not.toHaveBeenCalled();
            expect(authLoginSpy).not.toHaveBeenCalled();
        } finally {
            act(() => tree?.unmount());
        }
    });

    it('does not switch when target-scoped credential storage fails', async () => {
        vi.resetModules();
        resetPairingState();
        const claimId = `claim_${'e'.repeat(43)}`;
        parsedPairingPayload = { claimId, origin: 'https://relay.example.test' };
        requestedServerTarget = 'https://relay.example.test';
        authQRWaitSpy.mockResolvedValueOnce({ token: 'claim-token', secret: new Uint8Array([4]) });
        setCredentialsForServerUrlSpy.mockResolvedValueOnce(false);
        lastScannerProps = null;

        const { RestoreScanComputerQrView } = await import('./RestoreScanComputerQrView');
        let tree: ReactTestRenderer | null = null;
        try {
            await act(async () => {
                tree = create(<RestoreScanComputerQrView />);
            });
            await act(async () => {
                await lastScannerProps.onScan('claim');
            });

            expect(upsertActivateAndSwitchServerSpy).not.toHaveBeenCalled();
            expect(setActiveServerAndSwitchSpy).not.toHaveBeenCalled();
            expect(activeServerState.snapshot.serverId).toBe('server-prior');
        } finally {
            act(() => tree?.unmount());
        }
    });

    it('rolls back an operation-owned target when the canonical switch rejects after activation', async () => {
        vi.resetModules();
        resetPairingState();
        const claimId = `claim_${'f'.repeat(43)}`;
        parsedPairingPayload = { claimId, origin: 'https://relay.example.test' };
        requestedServerTarget = 'https://relay.example.test';
        authQRWaitSpy.mockResolvedValueOnce({ token: 'claim-token', secret: new Uint8Array([5]) });
        upsertActivateAndSwitchServerSpy.mockImplementationOnce(async (params: { serverUrl: string }) => {
            activeServerState.snapshot = {
                serverId: 'server-target',
                serverUrl: params.serverUrl,
                activeShareableServerUrl: null,
                generation: 2,
            };
            throw new Error('connection-switch-failed');
        });
        lastScannerProps = null;

        const { RestoreScanComputerQrView } = await import('./RestoreScanComputerQrView');
        let tree: ReactTestRenderer | null = null;
        try {
            await act(async () => {
                tree = create(<RestoreScanComputerQrView />);
            });
            await act(async () => {
                await lastScannerProps.onScan('claim');
            });

            expect(setActiveServerAndSwitchSpy).toHaveBeenCalledWith({
                serverId: 'server-prior',
                scope: 'device',
                refreshAuth: authRefreshSpy,
            });
            expect(activeServerState.snapshot.serverId).toBe('server-prior');
        } finally {
            act(() => tree?.unmount());
        }
    });

    it('rolls back an operation-owned target when the scanner unmounts during the switch', async () => {
        vi.resetModules();
        resetPairingState();
        const claimId = `claim_${'g'.repeat(43)}`;
        parsedPairingPayload = { claimId, origin: 'https://relay.example.test' };
        requestedServerTarget = 'https://relay.example.test';
        authQRWaitSpy.mockResolvedValueOnce({ token: 'claim-token', secret: new Uint8Array([6]) });
        let resolveSwitch!: (value: boolean) => void;
        upsertActivateAndSwitchServerSpy.mockImplementationOnce(async (params: { serverUrl: string }) => {
            activeServerState.snapshot = {
                serverId: 'server-target',
                serverUrl: params.serverUrl,
                activeShareableServerUrl: null,
                generation: 2,
            };
            return await new Promise<boolean>((resolve) => {
                resolveSwitch = resolve;
            });
        });
        lastScannerProps = null;

        const { RestoreScanComputerQrView } = await import('./RestoreScanComputerQrView');
        let tree: ReactTestRenderer | null = null;
        await act(async () => {
            tree = create(<RestoreScanComputerQrView />);
        });

        const scan = lastScannerProps.onScan('claim');
        for (let attempt = 0; attempt < 10 && !resolveSwitch; attempt += 1) {
            await Promise.resolve();
        }
        expect(resolveSwitch).toBeTypeOf('function');

        await act(async () => {
            tree?.unmount();
            await Promise.resolve();
        });
        expect(setActiveServerAndSwitchSpy).toHaveBeenCalledWith({
            serverId: 'server-prior',
            scope: 'device',
            refreshAuth: authRefreshSpy,
        });

        resolveSwitch(true);
        await act(async () => {
            await scan;
        });
    });

    it('does not let a stale blurred operation roll back a newer refocused claim switch', async () => {
        vi.resetModules();
        resetPairingState();
        const claimA = `claim_${'h'.repeat(43)}`;
        const claimB = `claim_${'i'.repeat(43)}`;
        parsedPairingPayload = { claimId: claimA, origin: 'https://relay-a.example.test' };
        requestedServerTarget = 'https://relay-a.example.test';
        authQRWaitSpy.mockResolvedValue({ token: 'claim-token', secret: new Uint8Array([7]) });
        let resolveSwitchA!: (value: boolean) => void;
        let resolveSwitchB!: (value: boolean) => void;
        upsertActivateAndSwitchServerSpy
            .mockImplementationOnce(async (params: { serverUrl: string }) => {
                activeServerState.snapshot = {
                    serverId: 'server-target-a',
                    serverUrl: params.serverUrl,
                    activeShareableServerUrl: null,
                    generation: 2,
                };
                return await new Promise<boolean>((resolve) => {
                    resolveSwitchA = resolve;
                });
            })
            .mockImplementationOnce(async (params: { serverUrl: string }) => {
                activeServerState.snapshot = {
                    serverId: 'server-target-b',
                    serverUrl: params.serverUrl,
                    activeShareableServerUrl: null,
                    generation: 4,
                };
                return await new Promise<boolean>((resolve) => {
                    resolveSwitchB = resolve;
                });
            });
        lastScannerProps = null;

        const { RestoreScanComputerQrView } = await import('./RestoreScanComputerQrView');
        const FocusDrivenScanner = RestoreScanComputerQrView as React.ComponentType<{ focusVersion: number }>;
        let tree: ReactTestRenderer | null = null;
        try {
            await act(async () => {
                tree = create(<FocusDrivenScanner focusVersion={0} />);
            });
            let scanA!: Promise<void>;
            await act(async () => {
                scanA = lastScannerProps.onScan('claim-a');
                for (let attempt = 0; attempt < 10 && !resolveSwitchA; attempt += 1) {
                    await Promise.resolve();
                }
            });
            expect(resolveSwitchA).toBeTypeOf('function');

            navigationState.isFocused = false;
            await act(async () => {
                tree?.update(<FocusDrivenScanner focusVersion={1} />);
                await Promise.resolve();
            });
            expect(activeServerState.snapshot.serverId).toBe('server-prior');
            expect(setActiveServerAndSwitchSpy).toHaveBeenCalledTimes(1);

            parsedPairingPayload = { claimId: claimB, origin: 'https://relay-b.example.test' };
            requestedServerTarget = 'https://relay-b.example.test';
            navigationState.isFocused = true;
            await act(async () => {
                tree?.update(<FocusDrivenScanner focusVersion={2} />);
            });
            let scanB!: Promise<void>;
            await act(async () => {
                scanB = lastScannerProps.onScan('claim-b');
                for (let attempt = 0; attempt < 10 && !resolveSwitchB; attempt += 1) {
                    await Promise.resolve();
                }
            });
            expect(resolveSwitchB).toBeTypeOf('function');
            expect(activeServerState.snapshot.serverId).toBe('server-target-b');

            resolveSwitchA(true);
            await act(async () => {
                await scanA;
            });

            expect(activeServerState.snapshot.serverId).toBe('server-target-b');
            expect(setActiveServerAndSwitchSpy).toHaveBeenCalledTimes(1);

            resolveSwitchB(true);
            await act(async () => {
                await scanB;
            });
        } finally {
            act(() => tree?.unmount());
        }
    });
});
