import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppPaneProvider, useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const routerPushSpy = vi.fn();
const flashListCompatMockState = vi.hoisted(() => ({
    mappingKeyCalls: [] as Array<Readonly<{ index: number; itemKey: string | number | bigint }>>,
}));

vi.mock('@/utils/platform/responsive', () => ({
  useDeviceType: () => 'tablet',
}));

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', () => ({
    useMappingHelper: () => ({
        getMappingKey: (itemKey: string | number | bigint, index: number) => {
            flashListCompatMockState.mappingKeyCalls.push({ itemKey, index });
            return index;
        },
    }),
}));

vi.hoisted(async () => {
    const { installProjectFileLinkPickerCommonModuleMocks } = await import('./projectPicker/projectFileLinkPickerTestHelpers');

    installProjectFileLinkPickerCommonModuleMocks({
        reactNative: async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeWebMock({
                useWindowDimensions: () => ({ width: 1400, height: 900 }),
            });
        },
        router: async () => {
            const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
            const expoRouterMock = createExpoRouterMock({
                router: { push: routerPushSpy },
            });
            return expoRouterMock.module;
        },
        storage: async () => {
            const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
            return createStorageModuleStub({
                useLocalSetting: (key: string) => {
                    if (key === 'uiMultiPanePanelsEnabled') return true;
                    if (key === 'detailsPaneTabsBehavior') return 'preview';
                    return undefined;
                },
            });
        },
    });

    return null;
});

describe('LinkedWorkspaceFilesRow', () => {
    beforeEach(() => {
        flashListCompatMockState.mappingKeyCalls = [];
        routerPushSpy.mockClear();
    });

    it('routes linked file chip keys through the FlashList mapping helper', async () => {
        const { LinkedWorkspaceFilesRow } = await import('./LinkedWorkspaceFilesRow');

        await renderScreen(
            <AppPaneProvider>
                <LinkedWorkspaceFilesRow
                    sessionId="s1"
                    paths={['src/api.ts', 'src/ui.ts']}
                    fileOpenEnabled
                />
            </AppPaneProvider>,
        );

        expect(flashListCompatMockState.mappingKeyCalls).toEqual([
            { itemKey: 'src/api.ts', index: 0 },
            { itemKey: 'src/ui.ts', index: 1 },
        ]);
    });

    it('opens details tab when multi-pane is available', async () => {
        const { LinkedWorkspaceFilesRow } = await import('./LinkedWorkspaceFilesRow');

        let observedState: any = null;
        const Probe = () => {
            const { state } = useAppPaneContext();
            observedState = state;
            return null;
        };

        const screen = await renderScreen(
            <AppPaneProvider>
                <LinkedWorkspaceFilesRow sessionId="s1" paths={['src/api.ts']} fileOpenEnabled />
                <Probe />
            </AppPaneProvider>,
        );

        const fileChip = screen.findByTestId('linked-workspace-file:src/api.ts');
        expect(fileChip).toBeTruthy();
        await pressTestInstanceAsync(fileChip!, 'linked-workspace-file:src/api.ts');

        expect(routerPushSpy).not.toHaveBeenCalled();
        const scope = observedState?.scopes?.['session:s1'];
        expect(scope?.details?.isOpen).toBe(true);
        expect(scope?.details?.tabs?.[0]?.key).toBe('file:src/api.ts');
        expect(scope?.details?.activeTabKey).toBe('file:src/api.ts');
    });

    it('renders linked files as inert metadata when file opening is not granted', async () => {
        const { LinkedWorkspaceFilesRow } = await import('./LinkedWorkspaceFilesRow');

        const screen = await renderScreen(
            <AppPaneProvider>
                <LinkedWorkspaceFilesRow
                    sessionId="public-session"
                    paths={['src/api.ts']}
                    fileOpenEnabled={false}
                />
            </AppPaneProvider>,
        );

        const fileChip = screen.findByTestId('linked-workspace-file:src/api.ts');
        expect(fileChip?.type).toBe('View');
        expect(fileChip?.props.accessibilityRole).toBe('text');
        expect(fileChip?.props.onPress).toBeUndefined();
        expect(routerPushSpy).not.toHaveBeenCalled();
    });
});
