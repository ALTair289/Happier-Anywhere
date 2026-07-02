import { vi } from 'vitest';

type FlashListChatListHarnessModuleFactory = () => unknown | Promise<unknown>;
type FlashListChatListHarnessImportOriginal = <T = unknown>() => Promise<T>;
type FlashListChatListHarnessStorageModuleFactory = (
    importOriginal: FlashListChatListHarnessImportOriginal,
) => unknown | Promise<unknown>;

type InstallFlashListChatListCommonModuleMocksOptions = Readonly<{
    flashList?: FlashListChatListHarnessModuleFactory;
    reactNative?: FlashListChatListHarnessModuleFactory;
    storage?: FlashListChatListHarnessStorageModuleFactory;
    unistyles?: FlashListChatListHarnessModuleFactory;
}>;

const flashListChatListHarnessModuleState = vi.hoisted(() => ({
    options: {
        flashList: undefined as FlashListChatListHarnessModuleFactory | undefined,
        reactNative: undefined as FlashListChatListHarnessModuleFactory | undefined,
        storage: undefined as FlashListChatListHarnessStorageModuleFactory | undefined,
        unistyles: undefined as FlashListChatListHarnessModuleFactory | undefined,
    },
}));

export function installFlashListChatListCommonModuleMocks(
    options: InstallFlashListChatListCommonModuleMocksOptions = {},
) {
    flashListChatListHarnessModuleState.options = {
        flashList: options.flashList,
        reactNative: options.reactNative,
        storage: options.storage,
        unistyles: options.unistyles,
    };

    vi.mock('@shopify/flash-list', async () => {
        const activeOptions = flashListChatListHarnessModuleState.options;
        if (activeOptions.flashList) {
            return await activeOptions.flashList();
        }

        return {
            FlashList: () => null,
        };
    });

    vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', async () => {
        const activeOptions = flashListChatListHarnessModuleState.options;
        if (activeOptions.flashList) {
            return await activeOptions.flashList();
        }

        const { createFlashListChatListModuleMock } = await import('@/dev/testkit/harness/chatListHarness');
        return createFlashListChatListModuleMock();
    });

    vi.mock('react-native', async () => {
        const activeOptions = flashListChatListHarnessModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createFlashListChatListReactNativeMock } = await import('@/dev/testkit/harness/chatListHarness');
        return createFlashListChatListReactNativeMock();
    });

    vi.mock('@/utils/platform/responsive', () => ({
        useHeaderHeight: () => 0,
    }));

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = flashListChatListHarnessModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('react-native-safe-area-context', () => ({
        useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    }));

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = flashListChatListHarnessModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createFlashListChatListStorageMock } = await import('@/dev/testkit/harness/chatListHarness');
        return createFlashListChatListStorageMock(importOriginal);
    });

    vi.mock('@/sync/domains/state/storageStore', async (importOriginal) => {
        const { createFlashListChatListStorageStoreMock } = await import('@/dev/testkit/harness/chatListHarness');
        return createFlashListChatListStorageStoreMock(importOriginal);
    });

    vi.mock('@/sync/store/hooks', async (importOriginal) => {
        const actual = await importOriginal<typeof import('@/sync/store/hooks')>();
        const { flashListChatListHarnessState } = await import('@/dev/testkit/harness/chatListHarness');
        return {
            ...actual,
            useActiveServerAccountScope: () => flashListChatListHarnessState.activeServerAccountScope,
        };
    });
}
