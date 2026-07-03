import * as React from 'react';
import { ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import {
    connectedServicesModuleState,
    installConnectedServicesCommonModuleMocks,
    resetConnectedServicesCommonModuleMockState,
} from './connectedServicesTestHelpers';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installConnectedServicesCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            AppState: {
                currentState: 'active',
                addEventListener: vi.fn(() => ({ remove: vi.fn() })),
            },
            Platform: {
                OS: 'web',
                select: (options?: Readonly<{ default?: unknown }>) => (options && 'default' in options ? options.default : undefined),
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key, params) => {
                if (key === 'connectedServices.list.connectedCount') {
                    return `${(params as { count?: number } | undefined)?.count ?? 0} connected`;
                }
                return key;
            },
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

const useFeatureEnabledSpy = vi.fn<(featureId: string) => boolean>(() => false);
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => useFeatureEnabledSpy(featureId),
}));

const useProfileSpy = vi.fn(() => ({
    connectedServicesV2: [
        {
            serviceId: 'openai-codex',
            profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth' }],
        },
    ],
}));
vi.mock('@/sync/store/hooks', () => ({
    useProfile: () => useProfileSpy(),
    useSettings: () => ({
        connectedServicesDefaultProfileByServiceId: {},
        connectedServicesProfileLabelByKey: {},
    }),
    useSettingMutable: () => [undefined, vi.fn()] as const,
    useLocalSetting: () => 1,
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/sync/domains/connectedServices/connectedServiceRegistry', () => ({
    CONNECTED_SERVICES_REGISTRY: [{ serviceId: 'openai-codex', connectCommand: 'happier connect codex', supportsOauth: true }],
    getConnectedServiceRegistryEntry: (_serviceId: string) => ({ serviceId: 'openai-codex', connectCommand: 'happier connect codex', supportsOauth: true }),
}));

vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaBadges', () => ({
    useConnectedServiceQuotaBadges: () => ({}),
}));

describe('ConnectedServicesSettingsView', () => {
    beforeEach(() => {
        resetConnectedServicesCommonModuleMockState();
        connectedServicesModuleState.options.text = async () => {
            const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
            return createTextModuleMock({
                translate: (key, params) => {
                    if (key === 'connectedServices.list.connectedCount') {
                        return `${(params as { count?: number } | undefined)?.count ?? 0} connected`;
                    }
                    return key;
                },
            });
        };
        useFeatureEnabledSpy.mockReset();
        useFeatureEnabledSpy.mockReturnValue(false);
        useProfileSpy.mockReset();
        useProfileSpy.mockReturnValue({
            connectedServicesV2: [
                {
                    serviceId: 'openai-codex',
                    profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth' }],
                },
            ],
        });
    });

    it('does not expose connected services when the feature is disabled', async () => {
        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(React.createElement(ConnectedServicesSettingsView))).tree;

        const items = tree.findAllByType('Item' as any);
        expect(items.length).toBe(0);
    });

    it('opens the service detail flow for default-auth connect recovery actions', async () => {
        useFeatureEnabledSpy.mockReturnValue(true);
        useProfileSpy.mockReturnValue({
            connectedServicesV2: [
                {
                    serviceId: 'openai-codex',
                    profiles: [],
                },
            ],
        });

        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
        const { tree } = await renderScreen(React.createElement(ConnectedServicesSettingsView));

        const dropdown = tree.root.findAll((node) =>
            node.props?.itemTrigger?.itemProps?.testID === 'settings-connected-services-default-auth-codex'
        )[0];
        expect(dropdown).toBeTruthy();
        dropdown!.props.onSelect('connected-service:openai-codex:connect');

        expect(connectedServicesModuleState.routerPushSpy).toHaveBeenCalledWith({
            pathname: '/settings/connected-services/[serviceId]',
            params: { serviceId: 'openai-codex' },
        });
    });

    it('does not render empty copy beside registry provider rows on first run', async () => {
        useFeatureEnabledSpy.mockReturnValue(true);
        useProfileSpy.mockReturnValue({ connectedServicesV2: [] });

        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
        const screen = await renderScreen(React.createElement(ConnectedServicesSettingsView));

        const items = screen.tree.findAllByType('Item' as any);
        expect(items.length).toBeGreaterThan(0);
        expect(screen.getTextContent()).not.toContain('connectedServices.list.empty');
    });

    it('counts retryable refresh-failure profiles as connected on the provider summary row', async () => {
        useFeatureEnabledSpy.mockReturnValue(true);
        useProfileSpy.mockReturnValue({
            connectedServicesV2: [
                {
                    serviceId: 'openai-codex',
                    profiles: [
                        { profileId: 'connected', status: 'connected', kind: 'oauth' },
                        { profileId: 'retryable', status: 'refresh_failed_retryable', kind: 'oauth' },
                        { profileId: 'reauth', status: 'needs_reauth', kind: 'oauth' },
                    ],
                },
            ],
        });

        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
        const screen = await renderScreen(React.createElement(ConnectedServicesSettingsView));

        const row = screen.tree.findAllByType('Item' as any)
            .find((node) => node.props?.subtitle === '2 connected');
        expect(row?.props?.subtitle).toBe('2 connected');
    });

    it('opens the profile recovery flow for default-auth reauth selections', async () => {
        useFeatureEnabledSpy.mockImplementation((featureId: string) =>
            featureId === 'connectedServices' || featureId === 'connectedServices.accountGroups'
        );
        useProfileSpy.mockReturnValue({
            connectedServicesV2: [
                {
                    serviceId: 'openai-codex',
                    profiles: [{ profileId: 'work', status: 'needs_reauth', kind: 'oauth' }],
                },
            ],
        });

        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
        const { tree } = await renderScreen(React.createElement(ConnectedServicesSettingsView));

        const dropdown = tree.root.findAll((node) =>
            node.props?.itemTrigger?.itemProps?.testID === 'settings-connected-services-default-auth-codex'
        )[0];
        expect(dropdown).toBeTruthy();
        dropdown!.props.onSelect('connected-service:openai-codex:reauth:work');

        expect(connectedServicesModuleState.routerPushSpy).toHaveBeenCalledWith({
            pathname: '/settings/connected-services/profile',
            params: { serviceId: 'openai-codex', profileId: 'work' },
        });
    });
});
