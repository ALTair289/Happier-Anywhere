import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installConnectedServicesCommonModuleMocks } from './connectedServicesTestHelpers';
import { AGENTS_CORE } from '@happier-dev/agents';
import type { ConnectedServiceId, ConnectedServicesDefaultAuthByAgentIdV1 } from '@happier-dev/protocol';
import type { ConnectedServicesServiceBinding } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type CapturedDefaultAuthModalProps = Readonly<{
    setBindingForService: (serviceId: string, binding: ConnectedServicesServiceBinding) => void;
}> & Record<string, unknown>;

type CapturedDefaultAuthModalConfig = Readonly<{
    component: React.ComponentType<CapturedDefaultAuthModalProps>;
    props: CapturedDefaultAuthModalProps;
}>;

const modalShowMock = vi.fn((_config: CapturedDefaultAuthModalConfig) => 'default-auth-modal');
const modalUpdateMock = vi.fn((_modalId: string, _props: Record<string, unknown>) => {});

installConnectedServicesCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                show: (config: unknown) => modalShowMock(config as CapturedDefaultAuthModalConfig),
                update: (modalId: string, props: Record<string, unknown>) => modalUpdateMock(modalId, props),
            },
        }).module;
    },
});

vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaBadges', () => ({
    useConnectedServiceQuotaBadges: () => ({}),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

const narrowLayoutRef = vi.hoisted(() => ({ value: false }));
vi.mock('@/components/settings/actions/useActionSettingsNarrowLayout', () => ({
    useActionSettingsNarrowLayout: () => narrowLayoutRef.value,
}));

type SelectionListProps = Readonly<{
    selectedOptionId: string | null;
    rootStep: {
        sections: ReadonlyArray<{
            options: ReadonlyArray<{
                id: string;
                onSelect: () => void;
            }>;
        }>;
    };
}>;

function findSelectionListProps(tree: renderer.ReactTestRenderer): SelectionListProps {
    return tree.root.findByProps({
        testID: 'new-session.connected-services.selection-list',
    }).props as SelectionListProps;
}

function findSelectionOption(tree: renderer.ReactTestRenderer, optionId: string): { onSelect: () => void } {
    const listProps = findSelectionListProps(tree);
    for (const section of listProps.rootStep.sections) {
        const option = section.options.find((candidate) => candidate.id === optionId);
        if (option) return option;
    }
    throw new Error(`Selection option not found: ${optionId}`);
}

function getShownModalConfig(index: number): CapturedDefaultAuthModalConfig {
    const config = modalShowMock.mock.calls[index]?.[0];
    if (!config) {
        throw new Error(`Expected shown modal at index ${index}`);
    }
    return config;
}

function findDefaultAuthDropdown(tree: renderer.ReactTestRenderer): Record<string, any> {
    const dropdown = tree.root.findAll((node) =>
        node.props?.itemTrigger?.itemProps?.testID === 'settings-connected-services-default-auth-claude'
    )[0];
    if (!dropdown) {
        throw new Error('Expected default auth dropdown');
    }
    return dropdown.props as Record<string, any>;
}

describe('ConnectedServicesDefaultAuthRow', () => {
    beforeEach(() => {
        modalShowMock.mockClear();
        modalUpdateMock.mockClear();
        narrowLayoutRef.value = false;
    });

    async function renderClaudeNativeRow() {
        const { ConnectedServicesDefaultAuthRow } = await import('./ConnectedServicesDefaultAuthRow');
        return (await renderScreen(
            <ConnectedServicesDefaultAuthRow
                agentId="claude"
                agentTitle="Claude"
                agentCore={{ connectedServices: { supportedServiceIds: ['anthropic' as ConnectedServiceId] } }}
                connectedServicesEnabled={true}
                accountGroupsEnabled={false}
                accountProfileConnectedServicesV2={[{
                    serviceId: 'anthropic' as ConnectedServiceId,
                    profiles: [{ profileId: 'work', status: 'connected', kind: 'token', providerEmail: 'work@example.com' }],
                }]}
                settings={{
                    connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
                }}
                setDefaultAuthSettings={vi.fn()}
                onOpenConnectedServiceSettings={vi.fn()}
            />,
        )).tree;
    }

    it('on a compact layout shows the selected value in the subtitle and hides the right detail', async () => {
        narrowLayoutRef.value = true;
        const tree = await renderClaudeNativeRow();
        const dropdown = findDefaultAuthDropdown(tree);
        // Compact: the (long) selected value moves to the subtitle; the right detail
        // is suppressed so it doesn't crowd the title.
        expect(dropdown.itemTrigger.showSelectedDetail).toBe(false);
        expect(dropdown.itemTrigger.subtitle).toBe(dropdown.itemTrigger.detailFormatter(null));
    });

    it('on a wide layout keeps the selected value in the right detail, not the subtitle', async () => {
        narrowLayoutRef.value = false;
        const tree = await renderClaudeNativeRow();
        const dropdown = findDefaultAuthDropdown(tree);
        expect(dropdown.itemTrigger.showSelectedDetail).not.toBe(false);
        expect(dropdown.itemTrigger.subtitle).not.toBe(dropdown.itemTrigger.detailFormatter(null));
    });

    it('renders as a settings dropdown and writes the per-agent default binding', async () => {
        const { ConnectedServicesDefaultAuthRow } = await import('./ConnectedServicesDefaultAuthRow');
        const setDefaultAuthSettings = vi.fn();

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(
            <ConnectedServicesDefaultAuthRow
                agentId="claude"
                agentTitle="Claude"
                agentCore={{
                    connectedServices: {
                        supportedServiceIds: ['anthropic' as any],
                    },
                }}
                connectedServicesEnabled={true}
                accountGroupsEnabled={false}
                accountProfileConnectedServicesV2={[
                    {
                        serviceId: 'anthropic' as any,
                        profiles: [
                            {
                                profileId: 'work',
                                status: 'connected',
                                kind: 'token',
                                providerEmail: 'work@example.com',
                            },
                        ],
                    },
                ]}
                settings={{
                    connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
                }}
                setDefaultAuthSettings={setDefaultAuthSettings}
                onOpenConnectedServiceSettings={vi.fn()}
            />,
        )).tree;

        await act(async () => {
            const dropdown = findDefaultAuthDropdown(tree);
            expect(dropdown.selectedId).toBe('connected-service:anthropic:native');
            expect(dropdown.itemTrigger.title).toBe('Claude');
            dropdown.onSelect('connected-service:anthropic:profile:work');
        });

        expect(setDefaultAuthSettings).toHaveBeenCalledWith({
            v: 1,
            bindingsByAgentId: {
                claude: {
                    v: 1,
                    bindingsByServiceId: {
                        anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
                    },
                },
            },
        });
        expect(modalShowMock).not.toHaveBeenCalled();
    });

    it('updates the dropdown selection with the persisted binding', async () => {
        const { ConnectedServicesDefaultAuthRow } = await import('./ConnectedServicesDefaultAuthRow');
        const setDefaultAuthSettingsSpy = vi.fn();
        const anthropicServiceId = 'anthropic' as ConnectedServiceId;
        const connectedBinding = {
            source: 'connected',
            selection: 'profile',
            profileId: 'work',
        } as const;

        function Harness() {
            const [defaultAuthSettings, setDefaultAuthSettings] = React.useState<ConnectedServicesDefaultAuthByAgentIdV1>({
                v: 1,
                bindingsByAgentId: {
                    claude: {
                        v: 1,
                        bindingsByServiceId: {
                            anthropic: { source: 'native' as const },
                        },
                    },
                },
            });

            return (
                <ConnectedServicesDefaultAuthRow
                    agentId="claude"
                    agentTitle="Claude"
                    agentCore={{ connectedServices: { supportedServiceIds: [anthropicServiceId] } }}
                    connectedServicesEnabled={true}
                    accountGroupsEnabled={false}
                    accountProfileConnectedServicesV2={[
                        {
                            serviceId: anthropicServiceId,
                            profiles: [
                                {
                                    profileId: 'work',
                                    status: 'connected',
                                    kind: 'token',
                                    providerEmail: 'work@example.com',
                                },
                            ],
                        },
                    ]}
                    settings={{
                        connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                        connectedServicesDefaultProfileByServiceId: {},
                        connectedServicesDefaultAuthByAgentIdV1: defaultAuthSettings,
                    }}
                    setDefaultAuthSettings={(next) => {
                        setDefaultAuthSettingsSpy(next);
                        setDefaultAuthSettings(next);
                    }}
                    onOpenConnectedServiceSettings={vi.fn()}
                />
            );
        }

        const { tree } = await renderScreen(<Harness />);

        expect(findDefaultAuthDropdown(tree).selectedId).toBe('connected-service:anthropic:native');

        await act(async () => {
            findDefaultAuthDropdown(tree).onSelect('connected-service:anthropic:profile:work');
        });

        expect(findDefaultAuthDropdown(tree).selectedId).toBe('connected-service:anthropic:profile:work');
        expect(modalUpdateMock).not.toHaveBeenCalled();
        expect(setDefaultAuthSettingsSpy).toHaveBeenLastCalledWith({
            v: 1,
            bindingsByAgentId: {
                claude: {
                    v: 1,
                    bindingsByServiceId: {
                        anthropic: connectedBinding,
                    },
                },
            },
        });
    });

    it('stores group defaults as group bindings without a fallback profile id', async () => {
        const { ConnectedServicesDefaultAuthRow } = await import('./ConnectedServicesDefaultAuthRow');
        const setDefaultAuthSettings = vi.fn();

        const { tree } = await renderScreen(
            <ConnectedServicesDefaultAuthRow
                agentId="codex"
                agentTitle="Codex"
                agentCore={{ connectedServices: { supportedServiceIds: ['openai-codex' as any] } }}
                connectedServicesEnabled={true}
                accountGroupsEnabled={true}
                accountProfileConnectedServicesV2={[
                    {
                        serviceId: 'openai-codex' as any,
                        profiles: [{ profileId: 'fresh', status: 'connected', kind: 'oauth' }],
                        groups: [{
                            groupId: 'primary',
                            displayName: 'Primary pool',
                            activeProfileId: 'fresh',
                            memberProfileIds: ['fresh'],
                        }],
                    },
                ]}
                settings={{
                    connectedServicesProfileLabelByKey: {},
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
                }}
                setDefaultAuthSettings={setDefaultAuthSettings}
                onOpenConnectedServiceSettings={vi.fn()}
            />,
        );

        await act(async () => {
            tree.root.findAll((node) =>
                node.props?.itemTrigger?.itemProps?.testID === 'settings-connected-services-default-auth-codex'
            )[0]!.props.onSelect('connected-service:openai-codex:group:primary');
        });

        expect(setDefaultAuthSettings).toHaveBeenCalledWith({
            v: 1,
            bindingsByAgentId: {
                codex: {
                    v: 1,
                    bindingsByServiceId: {
                        'openai-codex': { source: 'connected', selection: 'group', groupId: 'primary' },
                    },
                },
            },
        });
    });

    it('renders the same effective fallback warning for stale defaults', async () => {
        const { ConnectedServicesDefaultAuthRow } = await import('./ConnectedServicesDefaultAuthRow');

        const { tree } = await renderScreen(
            <ConnectedServicesDefaultAuthRow
                agentId="codex"
                agentTitle="Codex"
                agentCore={{ connectedServices: { supportedServiceIds: ['openai-codex' as any] } }}
                connectedServicesEnabled={true}
                accountGroupsEnabled={true}
                accountProfileConnectedServicesV2={[
                    {
                        serviceId: 'openai-codex' as any,
                        profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth' }],
                        groups: [],
                    },
                ]}
                settings={{
                    connectedServicesProfileLabelByKey: {},
                    connectedServicesDefaultProfileByServiceId: { 'openai-codex': 'work' },
                    connectedServicesDefaultAuthByAgentIdV1: {
                        v: 1,
                        bindingsByAgentId: {
                            codex: {
                                v: 1,
                                bindingsByServiceId: {
                                    'openai-codex': {
                                        source: 'connected',
                                        selection: 'group',
                                        groupId: 'missing-group',
                                    },
                                },
                            },
                        },
                    },
                }}
                setDefaultAuthSettings={vi.fn()}
                onOpenConnectedServiceSettings={vi.fn()}
            />,
        );

        const dropdown = tree.root.findAll((node) =>
            node.props?.itemTrigger?.itemProps?.testID === 'settings-connected-services-default-auth-codex'
        )[0]!.props;
        expect(dropdown.itemTrigger.detailFormatter(null)).toBe('connectedServices.authChip.nativeLabel');
        expect(dropdown.itemTrigger.subtitle).toBe('connectedServices.defaultAuth.warning.connected_group_unavailable');
    });

    it('offers Claude subscription OAuth, setup-token, and Anthropic API key as selectable connected options for OpenCode', async () => {
        const { ConnectedServicesDefaultAuthRow } = await import('./ConnectedServicesDefaultAuthRow');
        const setDefaultAuthSettings = vi.fn();

        const { tree } = await renderScreen(
            <ConnectedServicesDefaultAuthRow
                agentId="opencode"
                agentTitle="OpenCode"
                agentCore={{ connectedServices: AGENTS_CORE.opencode.connectedServices }}
                connectedServicesEnabled={true}
                accountGroupsEnabled={false}
                accountProfileConnectedServicesV2={[
                    {
                        serviceId: 'claude-subscription' as ConnectedServiceId,
                        profiles: [
                            { profileId: 'claude-oauth', status: 'connected', kind: 'oauth', providerEmail: 'oauth@example.com' },
                            { profileId: 'claude-setup', status: 'connected', kind: 'token', providerEmail: 'setup@example.com' },
                        ],
                    },
                    {
                        serviceId: 'anthropic' as ConnectedServiceId,
                        profiles: [
                            { profileId: 'api', status: 'connected', kind: 'token', providerEmail: 'api@example.com' },
                        ],
                    },
                ]}
                settings={{
                    connectedServicesProfileLabelByKey: {},
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
                }}
                setDefaultAuthSettings={setDefaultAuthSettings}
                onOpenConnectedServiceSettings={vi.fn()}
            />,
        );

        const dropdown = tree.root.findAll((node) =>
            node.props?.itemTrigger?.itemProps?.testID === 'settings-connected-services-default-auth-opencode'
        )[0]!.props as Record<string, any>;
        const itemIds: string[] = dropdown.items.map((item: { id: string }) => item.id);

        // All three Anthropic auth options surface as real selectable connected profiles:
        // browser-login OAuth + setup-token (claude-subscription) and Console API key (anthropic).
        expect(itemIds).toContain('connected-service:claude-subscription:profile:claude-oauth');
        expect(itemIds).toContain('connected-service:claude-subscription:profile:claude-setup');
        expect(itemIds).toContain('connected-service:anthropic:profile:api');

        // Selecting the browser-login OAuth profile writes a real connected binding for OpenCode
        // (previously OAuth profiles surfaced only as a non-selectable setup-token guidance row).
        await act(async () => {
            dropdown.onSelect('connected-service:claude-subscription:profile:claude-oauth');
        });

        expect(setDefaultAuthSettings).toHaveBeenCalledWith({
            v: 1,
            bindingsByAgentId: {
                opencode: {
                    v: 1,
                    bindingsByServiceId: {
                        'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'claude-oauth' },
                    },
                },
            },
        });
    });
});
