import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { installAccountCommonModuleMocks } from '../../account/accountTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 0 as any);
vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});

const clipboardMocks = vi.hoisted(() => ({
    setStringAsync: vi.fn(async (_value: string) => {}),
}));
const modalMocks = vi.hoisted(() => ({
    alertAsync: vi.fn(async () => undefined),
}));

installAccountCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: modalMocks,
        }).module;
    },
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('expo-clipboard', () => clipboardMocks);

vi.mock('@/components/qr/QRCode', () => ({
    QRCode: 'QRCode',
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: 'RoundButton',
}));

const AUTH_FIXTURE = Object.freeze({
    isAuthenticated: true,
    credentials: Object.freeze({ token: 't', secret: 's' }),
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => AUTH_FIXTURE,
}));

let featureState: 'enabled' | 'disabled' | 'unknown' = 'enabled';
vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => ({ state: featureState }),
}));

vi.mock('@/platform/cryptoRandom', () => ({
    getRandomBytes: () => new Uint8Array(32).fill(7),
}));

vi.mock('@/platform/digest', () => ({
    digest: vi.fn(async () => new Uint8Array(32).fill(1)),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerUrl: () => activeServerUrl,
}));

let activeServerUrl = 'https://stack.example.test';
vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'srv-test', serverUrl: activeServerUrl, generation: 0 }),
}));

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getCachedServerFeaturesSnapshot: () => null,
}));

const CLAIM_ID = `claim_${'a'.repeat(43)}`;
const futureExpiresAt = () => new Date(Date.now() + 60_000).toISOString();
const serverFetchSpy = vi.fn(async (path: string, init?: any, _options?: any) => {
    if (path === '/v1/auth/pairing/claim/start') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        return {
            ok: true,
            status: 200,
            json: async () => ({
                protocol: 'claim-v1',
                claimId: CLAIM_ID,
                origin: body.origin,
                expiresAt: futureExpiresAt(),
            }),
        } as any;
    }
    if (path === '/v1/auth/pairing/start') {
        return {
            ok: true,
            status: 200,
            json: async () => ({ pairId: 'pair_123', expiresAt: futureExpiresAt() }),
        } as any;
    }
    if (path.startsWith('/v1/auth/pairing/status')) {
        return pairingStatusResponse;
    }
    throw new Error(`Unexpected serverFetch path: ${path}`);
});

let pairingStatusResponse: any = {
    ok: true,
    status: 200,
    json: async () => ({ state: 'pending', pairId: 'pair_123', expiresAt: futureExpiresAt() }),
} as any;

vi.mock('@/sync/http/client', () => ({
    serverFetch: (path: string, init?: any, options?: any) => serverFetchSpy(path, init, options),
}));

describe('AddPhoneSettingsView', () => {
    it('renders a pairing QR code after starting a session', async () => {
        featureState = 'enabled';
        activeServerUrl = 'https://stack.example.test';
        pairingStatusResponse = {
            ok: true,
            status: 200,
            json: async () => ({ state: 'pending', pairId: 'pair_123', expiresAt: futureExpiresAt() }),
        } as any;
        const { AddPhoneSettingsView } = await import('./AddPhoneSettingsView');

        const screen = await renderScreen(<AddPhoneSettingsView />);
        const qrContainer = screen.findByTestId('add-phone-qr');
        if (!qrContainer) throw new Error('Expected QR container');
        const qr = qrContainer.findByType('QRCode');
        expect(String(qr.props.data)).toContain('happier:///pair?v=1');
        expect(String(qr.props.data)).toContain('pairId=pair_123');
        expect(String(qr.props.data)).toContain('secret=');
        expect(screen.getTextContent()).toContain('connect.pairingCompatibleModeTitle');
        expect(screen.getTextContent()).toContain('connect.pairingSecureModeBody');
    });

    it('copies the pairing deep link with inline feedback', async () => {
        featureState = 'enabled';
        activeServerUrl = 'https://stack.example.test';
        pairingStatusResponse = {
            ok: true,
            status: 200,
            json: async () => ({ state: 'pending', pairId: 'pair_123', expiresAt: futureExpiresAt() }),
        } as any;
        clipboardMocks.setStringAsync.mockClear();
        modalMocks.alertAsync.mockClear();

        const { AddPhoneSettingsView } = await import('./AddPhoneSettingsView');

        const screen = await renderScreen(<AddPhoneSettingsView />);
        await screen.pressByTestIdAsync('add-phone-pairing-link');

        expect(clipboardMocks.setStringAsync).toHaveBeenCalledWith(expect.stringContaining('happier:///pair?v=1'));
        expect(clipboardMocks.setStringAsync.mock.calls.at(-1)?.[0]).toContain('secret=');
        expect(modalMocks.alertAsync).not.toHaveBeenCalledWith('common.success', 'common.copied');
        expect(screen.findByTestId('add-phone-pairing-link-copied')).toBeTruthy();
    });

    it('generates claim-v1 only after the explicit secure action', async () => {
        featureState = 'enabled';
        activeServerUrl = 'https://stack.example.test';
        pairingStatusResponse = {
            ok: true,
            status: 200,
            json: async () => ({ state: 'pending', pairId: CLAIM_ID, expiresAt: futureExpiresAt() }),
        } as any;
        const { AddPhoneSettingsView } = await import('./AddPhoneSettingsView');

        const screen = await renderScreen(<AddPhoneSettingsView />);
        await act(async () => {
            await screen.findByTestId('add-phone-generate-secure-qr')?.props.action();
        });

        const qr = screen.findByTestId('add-phone-qr')?.findByType('QRCode');
        expect(String(qr?.props.data)).toContain('happier:///pair?v=claim-v1');
        expect(String(qr?.props.data)).toContain(`claimId=${CLAIM_ID}`);
        expect(String(qr?.props.data)).not.toContain('secret=');
        expect(screen.getTextContent()).toContain('connect.pairingSecureModeTitle');
        expect(screen.getTextContent()).toContain('connect.pairingSecureModeBody');
    });

    it('clears the QR code when the pairing session expires', async () => {
        featureState = 'enabled';
        activeServerUrl = 'https://stack.example.test';
        pairingStatusResponse = {
            ok: false,
            status: 404,
            json: async () => ({ error: 'not_found' }),
        } as any;
        const { AddPhoneSettingsView } = await import('./AddPhoneSettingsView');

        const screen = await renderScreen(<AddPhoneSettingsView />);
        await flushHookEffects({ cycles: 1 });

        const qrContainer = screen.findByTestId('add-phone-qr');
        expect(qrContainer?.findAllByType('QRCode') ?? []).toHaveLength(0);

        const textContent = screen.getTextContent();
        expect(textContent).toContain('connect.pairingQrExpired');
    });

    it('does not show a sign-in prompt when the feature is disabled', async () => {
        featureState = 'disabled';
        activeServerUrl = 'https://stack.example.test';
        pairingStatusResponse = {
            ok: true,
            status: 200,
            json: async () => ({ state: 'pending', pairId: 'pair_123', expiresAt: futureExpiresAt() }),
        } as any;
        const { AddPhoneSettingsView } = await import('./AddPhoneSettingsView');

        const screen = await renderScreen(<AddPhoneSettingsView />);

        const textContent = screen.getTextContent();
        expect(textContent).toContain('common.unavailable');
        expect(textContent).not.toContain('modals.pleaseSignInFirst');
    });

    it('shows a server reachability hint when the QR code cannot embed localhost', async () => {
        featureState = 'enabled';
        activeServerUrl = 'http://localhost:53288';
        pairingStatusResponse = {
            ok: true,
            status: 200,
            json: async () => ({ state: 'pending', pairId: 'pair_123', expiresAt: futureExpiresAt() }),
        } as any;
        const { AddPhoneSettingsView } = await import('./AddPhoneSettingsView');

        const screen = await renderScreen(<AddPhoneSettingsView />);

        const textContent = screen.getTextContent();
        expect(textContent).toContain('connect.serverUrlNotEmbeddedTitle');
        expect(textContent).toContain('connect.serverUrlNotEmbeddedBody');
    });
});
