import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import {
    connectedServicesModuleState,
    installConnectedServicesCommonModuleMocks,
} from '../connectedServicesTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flushAsyncHandlers() {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
}

const modalSpies = vi.hoisted(() => ({
    prompt: vi.fn(),
    confirm: vi.fn(),
    alert: vi.fn(),
}));
const textSpies = vi.hoisted(() => ({
    translate: vi.fn((key: string, _params?: Record<string, unknown>) => key),
}));

const authGroupApiSpies = vi.hoisted(() => ({
    listConnectedServiceAuthGroupsV3: vi.fn(),
    addConnectedServiceAuthGroupMemberV3: vi.fn(),
    patchConnectedServiceAuthGroupV3: vi.fn(),
    patchConnectedServiceAuthGroupMemberV3: vi.fn(),
    removeConnectedServiceAuthGroupMemberV3: vi.fn(),
    setConnectedServiceAuthGroupActiveProfileV3: vi.fn(),
    deleteConnectedServiceAuthGroupV3: vi.fn(),
}));

const syncSpies = vi.hoisted(() => ({
    refreshProfile: vi.fn(),
}));

const authState = vi.hoisted(() => ({
    credentials: { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } as
        | { token: string; secret: string }
        | null,
}));

const featureEnabledById = vi.hoisted(() => new Map<string, boolean>());
const profileState = vi.hoisted(() => ({
    current: {
        connectedServicesV2: [
            {
                serviceId: 'openai-codex',
                profiles: [
                    { profileId: 'work', status: 'connected', providerEmail: 'work@example.com' },
                    { profileId: 'backup', status: 'connected', providerEmail: 'backup@example.com' },
                ],
            },
        ],
    },
}));

const settingsState = vi.hoisted(() => ({
    current: {
        connectedServicesDefaultProfileByServiceId: { 'openai-codex': 'work' },
        connectedServicesProfileLabelByKey: {} as Record<string, string>,
        connectedServicesQuotaPinnedMeterIdsByKey: {},
        connectedServicesQuotaSummaryStrategyByKey: {},
    },
}));

const authoritativeGroupState = vi.hoisted(() => ({
    groups: [] as unknown[],
}));

// AccountBlock is owned by another lane; render a passthrough that surfaces the
// props this view wires so behaviour (variant/enable/order/actions) is asserted
// without pulling the quota-snapshot hook + Reanimated body.
vi.mock('@/components/settings/connectedServices/account/AccountBlock', () => {
    const ReactModule = require('react');
    return {
        AccountBlock: (props: Record<string, unknown>) => ReactModule.createElement('AccountBlock', props),
    };
});

vi.mock('react-native-worklets', () => ({
    scheduleOnRN: (fn: (...args: unknown[]) => void, ...args: unknown[]) => fn(...args),
}));

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock();
});

function createAuthoritativeGroup(overrides: Record<string, unknown> = {}) {
    return {
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'primary',
        displayName: 'Team pool',
        policy: {
            v: 1,
            strategy: 'priority',
            autoSwitch: false,
            switchOn: {
                usageLimit: true,
                authExpired: true,
                accountChanged: true,
                refreshFailure: false,
            },
            cooldownMs: 30_000,
            honorProviderResetsAt: true,
            autoRestorePrimaryWhenReset: false,
            maxSwitchesPerTurn: 1,
            maxSwitchesPerSessionHour: 3,
            softSwitchRemainingPercent: 15,
            probeIfSnapshotOlderThanMs: 300_000,
            recoveryMode: 'switch_or_wait',
        },
        activeProfileId: 'work',
        generation: 2,
        state: { status: 'ready' },
        createdAt: 1,
        updatedAt: 2,
        members: [
            {
                v: 1,
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'work',
                priority: 100,
                enabled: true,
                state: {},
                createdAt: 1,
                updatedAt: 2,
            },
            {
                v: 1,
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'backup',
                priority: 200,
                enabled: true,
                state: {},
                createdAt: 1,
                updatedAt: 2,
            },
        ],
        ...overrides,
    };
}

function createStructuredConnectedServiceError(
    code: string,
    fields: Readonly<{ status?: number; generation?: number }> = {},
): Error & { code: string; status?: number; generation?: number } {
    const error = new Error(code) as Error & { code: string; status?: number; generation?: number };
    error.name = 'ConnectedServiceApiError';
    error.code = code;
    error.status = fields.status;
    error.generation = fields.generation;
    return error;
}

installConnectedServicesCommonModuleMocks({
    searchParams: { serviceId: 'openai-codex', groupId: 'primary' },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                prompt: modalSpies.prompt,
                confirm: modalSpies.confirm,
                alert: modalSpies.alert,
            },
        }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: textSpies.translate });
    },
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => authState,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureEnabledById.get(featureId) ?? true,
}));

vi.mock('@/sync/store/hooks', async () => {
    const actual = await vi.importActual<typeof import('@/sync/store/hooks')>('@/sync/store/hooks');
    return {
        ...actual,
        useProfile: () => profileState.current,
        useSettings: () => settingsState.current,
    };
});

vi.mock('@/sync/sync', () => ({
    sync: { refreshProfile: syncSpies.refreshProfile },
}));

vi.mock('@/sync/api/account/apiConnectedServiceAuthGroupsV3', () => authGroupApiSpies);

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => {
    const ReactModule = require('react');
    return {
        DropdownMenu: (props: Record<string, unknown>) => ReactModule.createElement('DropdownMenu', props),
    };
});

type ReorderGesture = {
    __kind: string;
    __config: Record<string, unknown>;
    __handlers: Record<string, (...args: any[]) => void>;
};

type AccountBlockNodeProps = {
    profileId: string;
    title?: string;
    identityLabel?: string | null;
    variant?: string;
    enabled?: boolean;
    onToggleEnabled?: (next: boolean) => void;
    isDefault?: boolean;
    isActive?: boolean;
    onSetActive?: () => void;
    actions?: ReadonlyArray<{ id: string; disabled?: boolean; onPress?: () => void }>;
    reorderGesture?: ReorderGesture | null;
};

/**
 * Pull the inline-reorder pan gesture wired to a member row. `AccountBlock` now
 * receives the gesture directly (it renders the `GestureDetector` INLINE itself,
 * mirroring SessionItem), so a present `reorderGesture` of `__kind: 'pan'` proves
 * the drag handle is actually wired on this row.
 */
function getMemberReorderGesture(
    screen: Awaited<ReturnType<typeof renderPoolDetail>>,
    profileId: string,
): ReorderGesture {
    const block = findMemberBlocks(screen).find((candidate) => candidate.profileId === profileId);
    const gesture = block?.reorderGesture;
    if (!gesture) throw new Error(`expected a bound reorder gesture for member "${profileId}"`);
    return gesture;
}

async function renderPoolDetail() {
    const { PoolDetailView } = await import('./PoolDetailView');
    const screen = await renderScreen(<PoolDetailView />);
    await flushAsyncHandlers();
    return screen;
}

function findMemberBlocks(screen: Awaited<ReturnType<typeof renderPoolDetail>>): AccountBlockNodeProps[] {
    return screen.tree.root
        .findAllByType('AccountBlock' as never)
        .map((node) => node.props as AccountBlockNodeProps);
}

function findDropdown(screen: Awaited<ReturnType<typeof renderPoolDetail>>, testID: string) {
    return screen.tree.root
        .findAllByType('DropdownMenu' as never)
        .find((node) => node.props.itemTrigger?.itemProps?.testID === testID);
}

/** Expand the "Advanced" disclosure so its lesser-used controls render. */
async function expandAdvanced(screen: Awaited<ReturnType<typeof renderPoolDetail>>) {
    await act(async () => {
        screen.findByTestId('connected-services-pool-detail:advanced:header')?.props.onPress?.();
        await flushAsyncHandlers();
    });
}

beforeEach(() => {
    modalSpies.prompt.mockReset();
    modalSpies.confirm.mockReset();
    modalSpies.alert.mockReset();
    textSpies.translate.mockClear();
    syncSpies.refreshProfile.mockReset();
    syncSpies.refreshProfile.mockResolvedValue(undefined);
    connectedServicesModuleState.searchParams = { serviceId: 'openai-codex', groupId: 'primary' };
    featureEnabledById.clear();
    settingsState.current = {
        connectedServicesDefaultProfileByServiceId: { 'openai-codex': 'work' },
        connectedServicesProfileLabelByKey: {},
        connectedServicesQuotaPinnedMeterIdsByKey: {},
        connectedServicesQuotaSummaryStrategyByKey: {},
    };
    profileState.current = {
        connectedServicesV2: [
            {
                serviceId: 'openai-codex',
                profiles: [
                    { profileId: 'work', status: 'connected', providerEmail: 'work@example.com' },
                    { profileId: 'backup', status: 'connected', providerEmail: 'backup@example.com' },
                ],
            },
        ],
    };
    authState.credentials = { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') };
    authoritativeGroupState.groups = [createAuthoritativeGroup()];
    authGroupApiSpies.listConnectedServiceAuthGroupsV3.mockReset();
    authGroupApiSpies.listConnectedServiceAuthGroupsV3.mockImplementation(async () => authoritativeGroupState.groups);
    authGroupApiSpies.addConnectedServiceAuthGroupMemberV3.mockReset();
    authGroupApiSpies.addConnectedServiceAuthGroupMemberV3.mockImplementation(async () => createAuthoritativeGroup({ generation: 3 }));
    authGroupApiSpies.patchConnectedServiceAuthGroupV3.mockReset();
    authGroupApiSpies.patchConnectedServiceAuthGroupV3.mockImplementation(async () => createAuthoritativeGroup());
    authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3.mockReset();
    authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3.mockImplementation(async () => createAuthoritativeGroup({ generation: 3 }));
    authGroupApiSpies.removeConnectedServiceAuthGroupMemberV3.mockReset();
    authGroupApiSpies.removeConnectedServiceAuthGroupMemberV3.mockImplementation(async () => createAuthoritativeGroup({
        generation: 3,
        members: [createAuthoritativeGroup().members[0]],
    }));
    authGroupApiSpies.setConnectedServiceAuthGroupActiveProfileV3.mockReset();
    authGroupApiSpies.setConnectedServiceAuthGroupActiveProfileV3.mockImplementation(async () => createAuthoritativeGroup({ activeProfileId: 'backup' }));
    authGroupApiSpies.deleteConnectedServiceAuthGroupV3.mockReset();
    authGroupApiSpies.deleteConnectedServiceAuthGroupV3.mockImplementation(async () => true);
});

describe('PoolDetailView', () => {
    it('adds a connected profile to a freshly-created empty pool with the current generation', async () => {
        authoritativeGroupState.groups = [createAuthoritativeGroup({
            activeProfileId: null,
            generation: 2,
            members: [],
        })];
        const screen = await renderPoolDetail();

        await screen.pressByTestIdAsync('connected-services-pool-detail:add-member');
        const pickerButtons = modalSpies.alert.mock.calls[0]?.[2] as
            | ReadonlyArray<{ text?: string; onPress?: () => void }>
            | undefined;
        const backupOption = pickerButtons?.find((button) => button.text?.includes('backup'));
        expect(backupOption).toBeTruthy();

        await act(async () => {
            backupOption?.onPress?.();
            await flushAsyncHandlers();
        });

        expect(authGroupApiSpies.addConnectedServiceAuthGroupMemberV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'backup',
                priority: 100,
                enabled: true,
                expectedGeneration: 2,
            },
        );
    });

    it('allows retryable refresh-failure profiles to be added to a pool', async () => {
        authoritativeGroupState.groups = [createAuthoritativeGroup({
            activeProfileId: null,
            generation: 2,
            members: [],
        })];
        profileState.current = {
            connectedServicesV2: [
                {
                    serviceId: 'openai-codex',
                    profiles: [
                        { profileId: 'retryable', status: 'refresh_failed_retryable', providerEmail: 'retryable@example.com' },
                    ],
                },
            ],
        };
        const screen = await renderPoolDetail();

        await screen.pressByTestIdAsync('connected-services-pool-detail:add-member');
        const pickerButtons = modalSpies.alert.mock.calls[0]?.[2] as
            | ReadonlyArray<{ text?: string; onPress?: () => void }>
            | undefined;
        const retryableOption = pickerButtons?.find((button) => button.text?.includes('retryable'));
        expect(retryableOption).toBeTruthy();

        await act(async () => {
            retryableOption?.onPress?.();
            await flushAsyncHandlers();
        });

        expect(authGroupApiSpies.addConnectedServiceAuthGroupMemberV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            expect.objectContaining({
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'retryable',
                expectedGeneration: 2,
            }),
        );
    });

    it('removes an existing member after confirmation with the current generation', async () => {
        modalSpies.confirm.mockResolvedValueOnce(true);
        const screen = await renderPoolDetail();
        const backup = findMemberBlocks(screen).find((block) => block.profileId === 'backup');
        const remove = backup?.actions?.find((action) => action.id.endsWith(':remove'));
        expect(remove).toBeTruthy();

        await act(async () => {
            remove?.onPress?.();
            await flushAsyncHandlers();
        });

        expect(modalSpies.confirm).toHaveBeenCalledTimes(1);
        expect(authGroupApiSpies.removeConnectedServiceAuthGroupMemberV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'backup',
                expectedGeneration: 2,
            },
        );
    });

    it('does not render pool-not-found while the first authoritative group load is pending', async () => {
        let resolveGroups: ((groups: unknown[]) => void) | undefined;
        authGroupApiSpies.listConnectedServiceAuthGroupsV3.mockImplementationOnce(
            () => new Promise((resolve) => {
                resolveGroups = resolve;
            }),
        );

        const { PoolDetailView } = await import('./PoolDetailView');
        const screen = await renderScreen(<PoolDetailView />);

        expect(screen.getTextContent()).not.toContain('connectedServices.detail.groupDetail.missingTitle');
        expect(screen.findAllByTestId('connected-services-pool-detail')).toHaveLength(0);

        await act(async () => {
            resolveGroups?.([createAuthoritativeGroup()]);
            await flushAsyncHandlers();
        });

        expect(screen.findByTestId('connected-services-pool-detail')).toBeTruthy();
    });

    it('renders members as pool-member AccountBlocks in fallback (priority) order', async () => {
        const screen = await renderPoolDetail();

        const blocks = findMemberBlocks(screen);
        expect(blocks.map((block) => block.profileId)).toEqual(['work', 'backup']);
        expect(blocks.every((block) => block.variant === 'poolMember')).toBe(true);
        // The active member is marked active in-list via the radio (`isActive`).
        expect(blocks.find((block) => block.profileId === 'work')?.isActive).toBe(true);
        expect(blocks.find((block) => block.profileId === 'backup')?.isActive).toBe(false);

        expect(screen.findByTestId('connected-services-pool-detail:summary')).toBeTruthy();
    });

    it('keeps stable profile ids visible for labelled pool members with provider email', async () => {
        settingsState.current.connectedServicesProfileLabelByKey = {
            'openai-codex/work': 'batiplus',
        };

        const screen = await renderPoolDetail();
        const work = findMemberBlocks(screen).find((block) => block.profileId === 'work');

        expect(work).toMatchObject({
            title: 'batiplus',
            identityLabel: 'work@example.com · work',
        });
    });

    it('toggles a member enable Switch through the member patch API with the generation', async () => {
        const screen = await renderPoolDetail();
        const backup = findMemberBlocks(screen).find((block) => block.profileId === 'backup');

        await act(async () => {
            backup?.onToggleEnabled?.(false);
            await flushAsyncHandlers();
        });

        expect(authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'backup',
                patch: { enabled: false, expectedGeneration: 2 },
            },
        );
    });

    it('reorders members via the Move up/down accessible fallback, writing spaced priorities with the generation', async () => {
        const screen = await renderPoolDetail();
        const backupBlock = findMemberBlocks(screen).find((block) => block.profileId === 'backup');
        const moveUp = backupBlock?.actions?.find((action) => action.id.endsWith(':move-up'));
        expect(moveUp).toBeTruthy();
        expect(moveUp?.disabled).toBe(false);

        await act(async () => {
            moveUp?.onPress?.();
            await flushAsyncHandlers();
        });

        // backup moves to the front -> it takes priority step 100, work moves to 200.
        expect(authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'backup',
                patch: { priority: 100, expectedGeneration: 2 },
            },
        );
        // Second patch threads the bumped generation returned by the first patch.
        expect(authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'work',
                patch: { priority: 200, expectedGeneration: 3 },
            },
        );
    });

    it('binds an inline pan reorder gesture to every member row in a multi-member pool', async () => {
        // The handle is rendered INLINE by AccountBlock (the proven web-safe
        // pattern), so PoolDetailView hands each row its pan gesture directly.
        // A present `__kind: 'pan'` gesture proves the drag handle is wired on web.
        const screen = await renderPoolDetail();
        const blocks = findMemberBlocks(screen);
        expect(blocks.length).toBeGreaterThanOrEqual(2);
        for (const block of blocks) {
            expect(block.reorderGesture?.__kind).toBe('pan');
        }
    });

    it('renders the single list-level drop overlay (blue insertion line) for the members list', async () => {
        const screen = await renderPoolDetail();
        expect(screen.findByTestId('connected-services-pool-detail:drop-overlay')).toBeTruthy();
    });

    it('commits a drag reorder (start -> update past a row -> end) with spaced priorities and the threaded generation', async () => {
        const screen = await renderPoolDetail();
        const gesture = getMemberReorderGesture(screen, 'backup');

        // Drive the bound pan gesture: drag `backup` up past `work` (fallback row
        // height 56 -> a -60 translation crosses `work`'s midpoint), then release.
        await act(async () => {
            gesture.__handlers.onStart?.({});
            gesture.__handlers.onUpdate?.({ translationY: -60 });
            gesture.__handlers.onEnd?.({});
            await flushAsyncHandlers();
        });

        // backup -> front (priority step 100, gen 2); work -> 200 threading gen 3.
        expect(authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'backup',
                patch: { priority: 100, expectedGeneration: 2 },
            },
        );
        expect(authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'work',
                patch: { priority: 200, expectedGeneration: 3 },
            },
        );
    });

    it('applies the dropped order optimistically before the priority patches resolve', async () => {
        // Hold the first member patch pending so we can observe the pre-persistence
        // state. Before the fix, the order only changed as each sequential patch
        // resolved + re-upserted (a chaotic reshuffle through priority ties); the
        // row first snapped back to its old slot. The reorder must instead be
        // reflected in ONE atomic optimistic update on drop.
        let resolveFirstPatch: (() => void) | undefined;
        authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3
            .mockImplementationOnce(
                () => new Promise((resolve) => {
                    resolveFirstPatch = () => resolve(createAuthoritativeGroup({ generation: 3 }));
                }),
            )
            .mockImplementation(async () => createAuthoritativeGroup({ generation: 4 }));

        const screen = await renderPoolDetail();
        // Initial fallback order is [work, backup] (priorities 100, 200).
        expect(findMemberBlocks(screen).map((block) => block.profileId)).toEqual(['work', 'backup']);

        const gesture = getMemberReorderGesture(screen, 'backup');
        await act(async () => {
            gesture.__handlers.onStart?.({});
            gesture.__handlers.onUpdate?.({ translationY: -60 });
            gesture.__handlers.onEnd?.({});
            await flushAsyncHandlers();
        });

        // The dropped order is reflected immediately even though the first patch is
        // still pending — no snap-back, no per-patch reshuffle.
        expect(findMemberBlocks(screen).map((block) => block.profileId)).toEqual(['backup', 'work']);

        // Let the held patch settle so the commit completes cleanly.
        await act(async () => {
            resolveFirstPatch?.();
            await flushAsyncHandlers();
            await flushAsyncHandlers();
        });
    });

    it('omits the drag gesture for a single-member pool (nothing to reorder)', async () => {
        authoritativeGroupState.groups = [createAuthoritativeGroup({
            members: [createAuthoritativeGroup().members[0]],
        })];

        const screen = await renderPoolDetail();
        const block = findMemberBlocks(screen).find((candidate) => candidate.profileId === 'work');
        expect(block).toBeTruthy();
        expect(block?.reorderGesture == null).toBe(true);
    });

    it('disables Move up on the first member and Move down on the last member', async () => {
        const screen = await renderPoolDetail();
        const blocks = findMemberBlocks(screen);
        const work = blocks.find((block) => block.profileId === 'work');
        const backup = blocks.find((block) => block.profileId === 'backup');

        expect(work?.actions?.find((action) => action.id.endsWith(':move-up'))?.disabled).toBe(true);
        expect(work?.actions?.find((action) => action.id.endsWith(':move-down'))?.disabled).toBe(false);
        expect(backup?.actions?.find((action) => action.id.endsWith(':move-down'))?.disabled).toBe(true);
    });

    it('refetches the group and retries the reorder on a generation conflict', async () => {
        authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3
            .mockRejectedValueOnce(createStructuredConnectedServiceError('connect_group_generation_conflict', { status: 409 }))
            .mockImplementation(async () => createAuthoritativeGroup({ generation: 7 }));
        // After the conflict, the refetch returns a fresh group at a new generation.
        authGroupApiSpies.listConnectedServiceAuthGroupsV3
            .mockImplementationOnce(async () => authoritativeGroupState.groups)
            .mockImplementation(async () => [createAuthoritativeGroup({ generation: 5 })]);

        const screen = await renderPoolDetail();
        const backupBlock = findMemberBlocks(screen).find((block) => block.profileId === 'backup');

        await act(async () => {
            backupBlock?.actions?.find((action) => action.id.endsWith(':move-up'))?.onPress?.();
            await flushAsyncHandlers();
        });

        // The retried patch threads the refetched generation (5).
        expect(authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'backup',
                patch: { priority: 100, expectedGeneration: 5 },
            },
        );
        expect(modalSpies.alert).not.toHaveBeenCalled();
    });

    it('surfaces every Behavior control including the two previously-hidden knobs', async () => {
        const screen = await renderPoolDetail();
        await expandAdvanced(screen);

        // Carried-over controls (top-level + Advanced).
        expect(screen.findByTestId('connected-services-pool-detail:auto-switch')).toBeTruthy();
        expect(findDropdown(screen, 'connected-services-pool-detail:strategy')).toBeTruthy();
        expect(screen.findByTestId('connected-services-pool-detail:soft-switch-threshold')).toBeTruthy();
        expect(screen.findByTestId('connected-services-pool-detail:stale-probe-after')).toBeTruthy();
        expect(screen.findByTestId('connected-services-pool-detail:switch-budget')).toBeTruthy();
        expect(findDropdown(screen, 'connected-services-pool-detail:recovery-mode')).toBeTruthy();
        expect(screen.findByTestId('connected-services-pool-detail:recovery-prompt')).toBeTruthy();

        // The two newly-surfaced knobs.
        expect(screen.findByTestId('connected-services-pool-detail:auto-restore-primary')).toBeTruthy();
        expect(screen.findByTestId('connected-services-pool-detail:switch-on:usageLimit')).toBeTruthy();
        expect(screen.findByTestId('connected-services-pool-detail:switch-on:authExpired')).toBeTruthy();
        expect(screen.findByTestId('connected-services-pool-detail:switch-on:accountChanged')).toBeTruthy();
        expect(screen.findByTestId('connected-services-pool-detail:switch-on:refreshFailure')).toBeTruthy();
    });

    it('patches autoRestorePrimaryWhenReset through the group policy patch API', async () => {
        const screen = await renderPoolDetail();
        await expandAdvanced(screen);

        await act(async () => {
            screen.findByTestId('connected-services-pool-detail:auto-restore-primary:toggle')?.props.onValueChange?.(true);
            await flushAsyncHandlers();
        });

        expect(authGroupApiSpies.patchConnectedServiceAuthGroupV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'openai-codex',
                groupId: 'primary',
                patch: { policy: { autoRestorePrimaryWhenReset: true }, expectedGeneration: 2 },
            },
        );
    });

    it('patches a switchOn.* trigger through the group policy patch API, preserving the other flags', async () => {
        const screen = await renderPoolDetail();
        await expandAdvanced(screen);

        await act(async () => {
            screen.findByTestId('connected-services-pool-detail:switch-on:refreshFailure:toggle')?.props.onValueChange?.(true);
            await flushAsyncHandlers();
        });

        expect(authGroupApiSpies.patchConnectedServiceAuthGroupV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'openai-codex',
                groupId: 'primary',
                patch: {
                    policy: {
                        switchOn: {
                            usageLimit: true,
                            authExpired: true,
                            accountChanged: true,
                            refreshFailure: true,
                        },
                    },
                    expectedGeneration: 2,
                },
            },
        );
    });

    it('deletes the pool after confirmation (danger action)', async () => {
        modalSpies.confirm.mockResolvedValueOnce(true);
        const screen = await renderPoolDetail();

        await screen.pressByTestIdAsync('connected-services-pool-detail:delete');

        expect(modalSpies.confirm).toHaveBeenCalledTimes(1);
        expect(authGroupApiSpies.deleteConnectedServiceAuthGroupV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            { serviceId: 'openai-codex', groupId: 'primary' },
        );
    });

    it('skips delete when the danger confirmation is cancelled', async () => {
        modalSpies.confirm.mockResolvedValueOnce(false);
        const screen = await renderPoolDetail();

        await screen.pressByTestIdAsync('connected-services-pool-detail:delete');

        expect(modalSpies.confirm).toHaveBeenCalledTimes(1);
        expect(authGroupApiSpies.deleteConnectedServiceAuthGroupV3).not.toHaveBeenCalled();
    });

    it('disables fallback Behavior controls when account fallback is unsupported by the runtime', async () => {
        connectedServicesModuleState.searchParams = { serviceId: 'github', groupId: 'primary' };
        profileState.current = {
            connectedServicesV2: [
                {
                    serviceId: 'github',
                    profiles: [
                        { profileId: 'work', status: 'connected', providerEmail: 'work@example.com' },
                        { profileId: 'backup', status: 'connected', providerEmail: 'backup@example.com' },
                    ],
                },
            ],
        };
        authoritativeGroupState.groups = [createAuthoritativeGroup({ serviceId: 'github' })];

        const screen = await renderPoolDetail();

        const autoSwitch = screen.tree.root.find((node) =>
            node.props?.testID === 'connected-services-pool-detail:auto-switch');
        expect(autoSwitch.props.disabled).toBe(true);

        const autoSwitchToggle = screen.findByTestId('connected-services-pool-detail:auto-switch:toggle');
        await act(async () => {
            autoSwitchToggle?.props.onValueChange?.(true);
            await flushAsyncHandlers();
        });
        expect(authGroupApiSpies.patchConnectedServiceAuthGroupV3).not.toHaveBeenCalled();
    });

    it('fails closed and shows the disabled message when account groups are disabled', async () => {
        featureEnabledById.set('connectedServices.accountGroups', false);

        const screen = await renderPoolDetail();

        expect(screen.findAllByType('AccountBlock' as never).length).toBe(0);
        expect(screen.getTextContent()).toContain('settings.connectedAccountsDisabled');
    });
});
