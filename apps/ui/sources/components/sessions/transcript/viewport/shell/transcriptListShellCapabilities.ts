import {
    TRANSCRIPT_NATIVE_SCROLL_EVENT_THROTTLE_MS,
    TRANSCRIPT_WEB_FLASH_LIST_SCROLL_EVENT_THROTTLE_MS,
} from '@/components/sessions/transcript/_constants';

export type TranscriptListShellRenderer = 'flashList' | 'legendList';
export type TranscriptListShellDataOrder = 'oldest-first' | 'newest-first';
export type TranscriptListShellKeyboardDismissMode = 'none';
export type TranscriptListShellKeyboardShouldPersistTaps = 'handled';
export type TranscriptListShellVisibleContentMaintenance =
    | Readonly<{
        animateAutoScrollToBottom?: false;
        autoscrollToBottomThreshold?: number;
        startRenderingFromBottom: true;
    }>
    | Readonly<{
        autoscrollToTopThreshold?: number | null;
        minIndexForVisible: number;
    }>;

export type TranscriptListShellRendererOptions = Readonly<{
    browserScrollAnchoring: 'disabled' | 'native';
    continuousFollow: Readonly<{ endThresholdRatio: number }>;
    identity: Readonly<{ nativeID?: string; testID?: string }>;
    initialPlacement: Readonly<{ atEnd: boolean }>;
    interaction: Readonly<{
        keyboardDismissMode: TranscriptListShellKeyboardDismissMode;
        keyboardShouldPersistTaps: TranscriptListShellKeyboardShouldPersistTaps;
        scrollEventThrottle: number;
    }>;
    offsetCorrection?: 'active' | 'paused';
    virtualization?: Readonly<{ renderAheadDistancePx?: number }>;
    visibleContentMaintenance?: TranscriptListShellVisibleContentMaintenance;
}>;

type TranscriptListShellStreamingFollowCapability = Readonly<{
    boundedHydration?: never;
    streamingFollow: Readonly<{ kind: 'main' }>;
}>;

type TranscriptListShellBoundedHydrationCapability = Readonly<{
    boundedHydration: Readonly<{ kind: 'readOnly' | 'sidechain' }>;
    streamingFollow?: never;
}>;

type TranscriptListShellMainCapability = TranscriptListShellStreamingFollowCapability & Readonly<{
    catchUpIndicator: true;
    entryRestore: true;
    jumpToSeq: true;
    kind: 'main';
    olderPagination: true;
    selection: true;
}>;

type TranscriptListShellSidechainCapability = TranscriptListShellBoundedHydrationCapability & Readonly<{
    catchUpIndicator: true;
    composerVisible: false;
    initialBottomPin: true;
    jumpToMessage: true;
    kind: 'sidechain';
    localHeightChangeRestore: true;
    nativeOlderLoadEdgeRead: true;
    olderPagination: true;
    prependGrowthRestore: true;
    readOnlyForkContext: false;
    webOlderLoadObservation: true;
}>;

export type TranscriptListShellReadOnlyCapability = TranscriptListShellBoundedHydrationCapability & Readonly<{
    accessKind: 'public';
    bottomNoticeVisible: boolean;
    canApprovePermissions: false;
    canSendMessages: false;
    catchUpIndicator: false;
    composerVisible: false;
    flashListStartsFromBottom: true;
    kind: 'readOnly';
    permissionDisabledReason: 'public';
    toolNavigationDisabled: true;
}>;

export type TranscriptListShellCapability =
    | TranscriptListShellMainCapability
    | TranscriptListShellSidechainCapability
    | TranscriptListShellReadOnlyCapability;

export type TranscriptListShellFrame = Readonly<{
    capability:
        | TranscriptListShellMainCapability
        | TranscriptListShellSidechainCapability
        | TranscriptListShellReadOnlyCapability;
    dataOrder: TranscriptListShellDataOrder;
    platform: 'native' | 'web';
    rendererOptions: TranscriptListShellRendererOptions;
}>;

const TRANSCRIPT_NATIVE_DRAW_DISTANCE_DEFAULT_MIN_PX = 600;
const TRANSCRIPT_NATIVE_DRAW_DISTANCE_DEFAULT_MAX_PX = 1200;
const TRANSCRIPT_LEGEND_MAINTAIN_SCROLL_AT_END_THRESHOLD_DEFAULT = 0.1;
const TRANSCRIPT_LIST_SHELL_KEYBOARD_DISMISS_MODE = 'none' as const;
const TRANSCRIPT_LIST_SHELL_KEYBOARD_SHOULD_PERSIST_TAPS = 'handled' as const;
const TRANSCRIPT_MAIN_LIST_TEST_ID = 'transcript-chat-list' as const;

function resolveNativeTranscriptListShellDrawDistance(params: Readonly<{
    configuredDrawDistance?: unknown;
    listLayoutHeight?: number;
}>): number {
    const configured = params.configuredDrawDistance;
    if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
        return Math.trunc(configured);
    }

    return Math.min(
        TRANSCRIPT_NATIVE_DRAW_DISTANCE_DEFAULT_MAX_PX,
        Math.max(
            TRANSCRIPT_NATIVE_DRAW_DISTANCE_DEFAULT_MIN_PX,
            Math.ceil(Number.isFinite(params.listLayoutHeight) ? (params.listLayoutHeight ?? 0) : 0),
        ),
    );
}

function resolveLegendMaintainScrollAtEndThreshold(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : TRANSCRIPT_LEGEND_MAINTAIN_SCROLL_AT_END_THRESHOLD_DEFAULT;
}

export function resolveMainTranscriptListShellFrame(params: Readonly<{
    configuredDrawDistance?: unknown;
    legendInitialScrollAtEnd?: boolean;
    listLayoutHeight?: number;
    maintainScrollAtEndThreshold?: number;
    maintainVisibleContentPosition?: TranscriptListShellVisibleContentMaintenance;
    nativeID?: string;
    pauseOffsetCorrection?: boolean;
    platformOS: string;
    rendererKind?: TranscriptListShellRenderer;
}>): TranscriptListShellFrame {
    const nativeFlashList = params.platformOS !== 'web';
    const rendererKind = params.rendererKind ?? 'legendList';
    return {
        capability: {
            catchUpIndicator: true,
            entryRestore: true,
            kind: 'main',
            jumpToSeq: true,
            olderPagination: true,
            selection: true,
            streamingFollow: { kind: 'main' },
        },
        dataOrder: nativeFlashList ? 'newest-first' : 'oldest-first',
        platform: nativeFlashList ? 'native' : 'web',
        rendererOptions: {
            browserScrollAnchoring: nativeFlashList ? 'native' : 'disabled',
            continuousFollow: {
                endThresholdRatio: resolveLegendMaintainScrollAtEndThreshold(
                    params.maintainScrollAtEndThreshold,
                ),
            },
            identity: {
                nativeID: params.nativeID,
                testID: TRANSCRIPT_MAIN_LIST_TEST_ID,
            },
            initialPlacement: { atEnd: params.legendInitialScrollAtEnd !== false },
            interaction: {
                keyboardDismissMode: TRANSCRIPT_LIST_SHELL_KEYBOARD_DISMISS_MODE,
                keyboardShouldPersistTaps: TRANSCRIPT_LIST_SHELL_KEYBOARD_SHOULD_PERSIST_TAPS,
                scrollEventThrottle:
                    params.platformOS === 'web'
                        ? TRANSCRIPT_WEB_FLASH_LIST_SCROLL_EVENT_THROTTLE_MS
                        : TRANSCRIPT_NATIVE_SCROLL_EVENT_THROTTLE_MS,
            },
            ...(rendererKind === 'flashList' ? {
                offsetCorrection: params.pauseOffsetCorrection === true ? 'paused' as const : 'active' as const,
                virtualization: {
                    renderAheadDistancePx: nativeFlashList
                        ? resolveNativeTranscriptListShellDrawDistance({
                            configuredDrawDistance: params.configuredDrawDistance,
                            listLayoutHeight: params.listLayoutHeight,
                        })
                        : undefined,
                },
                visibleContentMaintenance: params.maintainVisibleContentPosition,
            } : {}),
        },
    };
}

export function resolveReadOnlyTranscriptListShellFrame(params: Readonly<{
    accessKind: 'public';
    bottomNoticeVisible: boolean;
    platformOS: string;
    rendererKind?: TranscriptListShellRenderer;
}>): TranscriptListShellFrame {
    const nativeFlashList = params.platformOS !== 'web';
    const rendererKind = params.rendererKind ?? 'legendList';
    return {
        capability: {
            accessKind: params.accessKind,
            boundedHydration: { kind: 'readOnly' },
            bottomNoticeVisible: params.bottomNoticeVisible,
            canApprovePermissions: false,
            canSendMessages: false,
            catchUpIndicator: false,
            composerVisible: false,
            flashListStartsFromBottom: true,
            kind: 'readOnly',
            permissionDisabledReason: 'public',
            streamingFollow: undefined,
            toolNavigationDisabled: true,
        },
        dataOrder: nativeFlashList ? 'newest-first' : 'oldest-first',
        platform: nativeFlashList ? 'native' : 'web',
        rendererOptions: {
            browserScrollAnchoring: nativeFlashList ? 'native' : 'disabled',
            continuousFollow: {
                endThresholdRatio: TRANSCRIPT_LEGEND_MAINTAIN_SCROLL_AT_END_THRESHOLD_DEFAULT,
            },
            identity: {},
            initialPlacement: { atEnd: true },
            interaction: {
                keyboardDismissMode: TRANSCRIPT_LIST_SHELL_KEYBOARD_DISMISS_MODE,
                keyboardShouldPersistTaps: TRANSCRIPT_LIST_SHELL_KEYBOARD_SHOULD_PERSIST_TAPS,
                scrollEventThrottle:
                    params.platformOS === 'web'
                        ? TRANSCRIPT_WEB_FLASH_LIST_SCROLL_EVENT_THROTTLE_MS
                        : TRANSCRIPT_NATIVE_SCROLL_EVENT_THROTTLE_MS,
            },
            ...(rendererKind === 'flashList' ? {
                offsetCorrection: 'active' as const,
                virtualization: {},
                visibleContentMaintenance: { startRenderingFromBottom: true as const },
            } : {}),
        },
    };
}

export function resolveSidechainTranscriptListShellFrame(params: Readonly<{
    platformOS: string;
    rendererKind?: TranscriptListShellRenderer;
}>): TranscriptListShellFrame {
    const nativeFlashList = params.platformOS !== 'web';
    const rendererKind = params.rendererKind ?? 'legendList';
    return {
        capability: {
            boundedHydration: { kind: 'sidechain' },
            catchUpIndicator: true,
            composerVisible: false,
            initialBottomPin: true,
            jumpToMessage: true,
            kind: 'sidechain',
            localHeightChangeRestore: true,
            nativeOlderLoadEdgeRead: true,
            olderPagination: true,
            prependGrowthRestore: true,
            readOnlyForkContext: false,
            streamingFollow: undefined,
            webOlderLoadObservation: true,
        },
        dataOrder: nativeFlashList ? 'newest-first' : 'oldest-first',
        platform: nativeFlashList ? 'native' : 'web',
        rendererOptions: {
            browserScrollAnchoring: nativeFlashList ? 'native' : 'disabled',
            continuousFollow: {
                endThresholdRatio: TRANSCRIPT_LEGEND_MAINTAIN_SCROLL_AT_END_THRESHOLD_DEFAULT,
            },
            identity: {},
            initialPlacement: { atEnd: true },
            interaction: {
                keyboardDismissMode: TRANSCRIPT_LIST_SHELL_KEYBOARD_DISMISS_MODE,
                keyboardShouldPersistTaps: TRANSCRIPT_LIST_SHELL_KEYBOARD_SHOULD_PERSIST_TAPS,
                scrollEventThrottle:
                    params.platformOS === 'web'
                        ? TRANSCRIPT_WEB_FLASH_LIST_SCROLL_EVENT_THROTTLE_MS
                        : TRANSCRIPT_NATIVE_SCROLL_EVENT_THROTTLE_MS,
            },
            ...(rendererKind === 'flashList' ? {
                offsetCorrection: 'active' as const,
                virtualization: {},
            } : {}),
        },
    };
}
