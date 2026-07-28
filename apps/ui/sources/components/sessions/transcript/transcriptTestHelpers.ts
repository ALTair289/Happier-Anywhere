import { vi } from 'vitest';

type TranscriptModuleFactory = () => unknown | Promise<unknown>;
type TranscriptImportOriginal = <T = unknown>() => Promise<T>;
type TranscriptStorageModuleFactory = (
    importOriginal: TranscriptImportOriginal,
) => unknown | Promise<unknown>;

type InstallTranscriptCommonModuleMocksOptions = Readonly<{
    legendList?: TranscriptModuleFactory;
    modal?: TranscriptModuleFactory;
    reactNative?: TranscriptModuleFactory;
    storage?: TranscriptStorageModuleFactory;
    text?: TranscriptModuleFactory;
    unistyles?: TranscriptModuleFactory;
}>;

const transcriptModuleState = vi.hoisted(() => ({
    modalMockRef: { current: null as any },
    options: {
        modal: undefined as TranscriptModuleFactory | undefined,
        legendList: undefined as TranscriptModuleFactory | undefined,
        reactNative: undefined as TranscriptModuleFactory | undefined,
        storage: undefined as TranscriptStorageModuleFactory | undefined,
        text: undefined as TranscriptModuleFactory | undefined,
        unistyles: undefined as TranscriptModuleFactory | undefined,
    },
}));
const createReanimatedMock = vi.hoisted(() => async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

export function getTranscriptModalMockRef() {
    return transcriptModuleState.modalMockRef as { current: any };
}

export function resetTranscriptCommonModuleMockState() {
    transcriptModuleState.modalMockRef.current = null;
}

export function installReanimatedModuleMocks() {
    vi.mock('react-native-reanimated', createReanimatedMock);
    vi.mock('react-native-reanimated/lib/module', createReanimatedMock);
    vi.mock('react-native-reanimated/lib/module/index', createReanimatedMock);
    vi.mock('react-native-reanimated/lib/module/index.js', createReanimatedMock);
    vi.mock('react-native-reanimated/lib/module/publicGlobals', createReanimatedMock);
    vi.mock('react-native-reanimated/lib/module/publicGlobals.js', createReanimatedMock);
}

export function installTranscriptCommonModuleMocks(
    options: InstallTranscriptCommonModuleMocksOptions = {},
) {
    installReanimatedModuleMocks();

    transcriptModuleState.options = {
        modal: options.modal,
        legendList: options.legendList,
        reactNative: options.reactNative,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = transcriptModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('@legendapp/list/react-native', async () => {
        const activeOptions = transcriptModuleState.options;
        if (activeOptions.legendList) {
            return await activeOptions.legendList();
        }
        const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
        return createCapturingLegendListMock().module;
    });

    // ChatListInternal reads session-screen navigation focus for the S-E reveal
    // revalidation; keep the transcript host suites navigation-context-free.
    vi.mock('@/components/sessions/shell/useSessionScreenIsFocused', () => ({
        useSessionScreenIsFocused: () => true,
    }));

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = transcriptModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = transcriptModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = transcriptModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        const modalMock = createModalModuleMock();
        transcriptModuleState.modalMockRef.current = modalMock;
        return modalMock.module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = transcriptModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {});
    });
}
