import * as React from 'react';
import {
    getStorage,
    useForkedTranscriptSnapshot,
    useSessionChatFooterState,
    useSessionActionDrafts,
    useSessionLatestThinkingMessageId,
    useSessionLatestThinkingMessageActivityAtMs,
    useSessionMessages,
    useSessionMessagesById,
    useSessionPendingMessages,
    useSessionTranscriptIds,
    useSetting,
} from '@/sync/domains/state/storage';
import { Dimensions, PixelRatio, Platform, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useCallback } from 'react';
import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import { buildSessionMessageRouteId } from '@/sync/domains/messages/messageRouteIds';
import { Metadata, Session } from '@/sync/domains/state/storageTypes';
import { buildSessionMetadataStabilitySignatureValue, buildStableJsonSignature } from '@/sync/domains/session/metadata/sessionMetadataStability';
import { buildSessionTranscriptRenderSignature } from '@/sync/domains/session/transcriptRenderSignature';
import { buildPendingSessionRequestsSourceSignature } from '@/sync/domains/session/pending/listPendingSessionRequests';
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import { ChatListMessageRow, TranscriptRowShell } from './ChatListRows';
import { ChatFooter, type ChatFooterDirectControlState } from './ChatFooter';
import { buildChatListItems, buildChatListItemsCached, type ChatListItem, type ChatListItemsBuildCache } from '@/components/sessions/chatListItems';
import { buildForkAwareMessageDescriptors } from '@/components/sessions/transcript/forkContext/buildForkAwareMessageDescriptors';
import { deriveReadOnlyTranscriptInteraction } from '@/components/sessions/transcript/forkContext/deriveReadOnlyTranscriptInteraction';
import { insertForkDividersIntoTranscriptItems, type ForkDividerTranscriptItem } from '@/components/sessions/transcript/forkContext/insertForkDividersIntoTranscriptItems';
import { ForkDividerRow } from '@/components/sessions/transcript/forkContext/ForkDividerRow';
import { PendingMessagesTranscriptBlock, type PendingMessageEditRequest } from '@/components/sessions/pending/PendingMessagesTranscriptBlock';
import { SessionActionDraftCard } from '@/components/sessions/actions/SessionActionDraftCard';
import { UserActionPromptCard } from '@/components/tools/shell/userActions/UserActionPromptCard';
import { sync, type SessionViewportAnchorSnapshot } from '@/sync/sync';
import { useActiveServerAccountScope, useSessionCatchingUpNewer } from '@/sync/store/hooks';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { buildTranscriptTurnsCached, type TranscriptTurnsBuildCache } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurns';
import { buildTranscriptTurnUnits } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurnUnits';
import { TurnViewWithSessionCommon } from '@/components/sessions/transcript/turns/TurnView';
import { ToolCallsGroupRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/ToolCallsGroupRow';
import { ToolCallsGroupUnitHeaderRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/units/ToolCallsGroupUnitHeaderRow';
import { ToolCallsGroupUnitExpandRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/units/ToolCallsGroupUnitExpandRow';
import { ToolCallsGroupUnitToolRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/units/ToolCallsGroupUnitToolRow';
import { ToolCallsGroupUnitFooterRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/units/ToolCallsGroupUnitFooterRow';
import { shouldAutoExpandToolCallsGroupForShortTranscript } from '@/components/sessions/transcript/toolCalls/resolveToolCallsGroupAutoExpandPolicy';
import { TranscriptMotionProvider } from '@/components/sessions/transcript/motion/TranscriptMotionProvider';
import { resolveTranscriptMotionConfig } from '@/components/sessions/transcript/motion/resolveTranscriptMotionConfig';
import { TranscriptEnterWrapper } from '@/components/sessions/transcript/motion/TranscriptEnterWrapper';
import { SyncPerformanceReactProfiler } from '@/components/ui/performance/SyncPerformanceReactProfiler';
import { TranscriptFirstPaintPlaceholder } from '@/components/sessions/transcript/TranscriptFirstPaintPlaceholder';
import { resolveTranscriptToolCallsCollapsedPreviewCount } from '@/sync/domains/settings/transcriptToolCallsCollapsedPreviewCount';
import { JumpToBottomButton } from '@/components/sessions/transcript/scroll/JumpToBottomButton';
import { resolveJumpToBottomAffordanceState } from '@/components/sessions/transcript/scroll/jumpToBottomAffordanceState';
import { resolveNextJumpToBottomDistanceVisibilityState } from '@/components/sessions/transcript/scroll/jumpToBottomVisibilityDistanceState';
import { subscribeToFlashListOffsetCorrections } from '@/components/sessions/transcript/scroll/flashListOffsetCorrectionHook';
import {
    resolveTranscriptRowContentCount,
    resolveTranscriptRowViewportRelation,
} from '@/components/sessions/transcript/scroll/transcriptRowEvidence';
import {
    configureTranscriptViewportTelemetryFromTuning,
    recordTranscriptViewportTelemetryEvent,
    resolveTranscriptViewportTelemetryPlatform,
    transcriptViewportTelemetry,
    type TranscriptViewportTelemetryEvent,
    type TranscriptViewportTelemetryObservationReason,
    type TranscriptViewportTelemetryBlankAreaSource,
    type TranscriptViewportTelemetryBottomFollowMode,
    type TranscriptViewportTelemetryLayoutCacheClearReason,
    type TranscriptViewportTelemetryLayoutCacheClearState,
    type TranscriptViewportTelemetryMvcpPolicy,
    type TranscriptViewportTelemetryNativeBlankWindowSignature,
    type TranscriptViewportTelemetryScrollReason,
    type TranscriptViewportTelemetryScrollToIndexFailureState,
    type TranscriptViewportTelemetryTransactionState,
    type TranscriptViewportTelemetryVisibleRangeReadStatus,
    type TranscriptViewportTelemetryVisibleWindowSource,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import {
    createTranscriptViewportCommandController,
    type TranscriptViewportCommandController,
} from '@/components/sessions/transcript/viewport/createTranscriptViewportCommandController';
import {
    createTranscriptViewportLifecycle,
    type TranscriptViewportLifecycle,
    type TranscriptViewportLifecycleEffect,
    type TranscriptViewportLifecycleEvent,
} from '@/components/sessions/transcript/viewport/lifecycle/lifecycle';
import {
    createTranscriptLifecycleHost,
    type TranscriptLifecycleHost,
    type TranscriptLifecycleHostContentGrowthLiveTailCommandPlan,
    type TranscriptLifecycleHostExplicitJumpPlan,
    type TranscriptLifecycleHostExplicitReturnPlan,
    type TranscriptLifecycleHostFollowBottomIntentPlan,
    type TranscriptLifecycleHostLocalInteractionPlan,
    type TranscriptLifecycleHostMeasuredNativePinPlan,
    type TranscriptLifecycleHostNativeGestureTakeoverPlan,
    type TranscriptLifecycleHostNativeMountSettlePendingPinFlushPlan,
    type TranscriptLifecycleHostNativeOffsetEscapeReleasePlan,
    type TranscriptLifecycleHostNativeTouchIntentPlan,
    type TranscriptLifecycleHostNativeTouchReleasePlan,
    type TranscriptLifecycleHostNativeUserScrollTakeoverPlan,
    type TranscriptLifecycleHostSessionEntryPlan,
    type TranscriptLifecycleHostScrollObservationPlan,
    type NativeEntrySettleConfirmationEffect,
    type NativeExplicitJumpConfirmationEffect,
} from '@/components/sessions/transcript/viewport/lifecycle/lifecycleHost';
import {
    planBottomFollowWriteSchedulerEvent,
    type BottomFollowAutomaticWriter,
    type BottomFollowScheduledWrite,
    type BottomFollowWriteSchedulerEffect,
    type BottomFollowWriteSchedulerState,
} from '@/components/sessions/transcript/viewport/bottomFollow/writeScheduler';
import { useExplicitJumpWriteBarrier } from '@/components/sessions/transcript/viewport/bottomFollow/explicitJumpWriteBarrier';
import {
    applyTranscriptLifecycleScrollObservationPlan,
    type TranscriptLifecycleScrollObservationPlanContinuationInput,
} from '@/components/sessions/transcript/viewport/lifecycle/lifecycleHostScrollObservationApplier';
import {
    observeTranscriptScrollIngress,
    type TranscriptScrollIngressCallbacks,
    type TranscriptScrollIngressPlatform,
} from '@/components/sessions/transcript/viewport/lifecycle/scrollIngressObservation';
import {
    applyTranscriptContentSizeObservation,
    applyTranscriptLayoutObservation,
    type TranscriptContentSizeObservationApplierEffects,
    type TranscriptLayoutObservationApplierEffects,
} from '@/components/sessions/transcript/viewport/lifecycle/layoutContentSizeObservationApplier';
import {
    resolveNativeTrustedBottomArrivalEffects,
    type NativeTrustedBottomArrivalEffect,
} from '@/components/sessions/transcript/viewport/lifecycle/nativeTrustedBottomArrival';
import {
    resolveNativeReturnToLiveTailApplyEffects,
    type NativeReturnToLiveTailApplyEffect,
    type NativeSettledReturnToLiveTailDrainEffect,
    type NativeSettledReturnToLiveTailReturnEffect,
} from '@/components/sessions/transcript/viewport/lifecycle/nativeReturnToLiveTail';
import {
    resolveNativeMomentumSettleAwayReleaseStateEffects,
    type NativeMomentumSettleAwayReleaseStateEffect,
} from '@/components/sessions/transcript/viewport/lifecycle/nativeMomentumSettleAwayRelease';
import {
    resolveNativeBottomFollowRearmAdoptionDecision,
    type NativeBottomFollowRearmAdoptionEffect,
} from '@/components/sessions/transcript/viewport/lifecycle/nativeBottomFollowRearmAdoption';
import {
    resolveNativeBottomFollowRearmResetEffects,
    type NativeBottomFollowRearmResetEffect,
} from '@/components/sessions/transcript/viewport/lifecycle/nativeBottomFollowRearmReset';
import {
    resolveWebUserScrollIntentTimestampApplyEffects,
    resolveWebUserScrollTakeoverApplyEffects,
    type WebUserScrollIntentTimestampApplyEffect,
    type WebUserScrollTakeoverApplyEffect,
} from '@/components/sessions/transcript/viewport/lifecycle/webUserScrollIntent';
import {
    resolveWebImmediateReleaseLiveTailApplyEffects,
    type WebImmediateReleaseLiveTailApplyEffect,
} from '@/components/sessions/transcript/viewport/lifecycle/webImmediateReleaseLiveTail';
import {
    resolveNativeDragActiveMirrorApplyEffects,
    resolveNativeMomentumActiveMirrorApplyEffects,
    type NativeDragActiveMirrorApplyEffect,
    type NativeMomentumActiveMirrorApplyEffect,
} from '@/components/sessions/transcript/viewport/lifecycle/nativeActiveMirror';
import {
    type TranscriptViewportTransactionOutcome,
} from '@/components/sessions/transcript/viewport/transcriptViewportOwnership';
import type {
    TranscriptViewportAnchorIdentity,
    TranscriptViewportCommand,
    TranscriptViewportControllerInput,
    TranscriptViewportJumpAlignment,
    TranscriptViewportMode,
} from '@/components/sessions/transcript/viewport/transcriptViewportTypes';
import { createNativeInvertedFlashListFactSource } from '@/components/sessions/transcript/viewport/driver/nativeInvertedFlashListFacts';
import type { TranscriptViewportFactSource } from '@/components/sessions/transcript/viewport/driver/transcriptViewportFacts';
import {
    createTranscriptViewportCommandHost,
} from '@/components/sessions/transcript/viewport/driver/commandHost';
import type { TranscriptViewportDriverDeps } from '@/components/sessions/transcript/viewport/driver/types';
import { resolveTranscriptInitialFillTuning } from '@/components/sessions/transcript/scroll/resolveTranscriptInitialFillTuning';
import {
    createSessionOpenLatch,
    type SessionOpenLatch,
} from '@/components/sessions/transcript/viewport/sessionOpen/sessionOpenLatch';
import { resolveSessionOpenWebInitialPinRetryPlan } from '@/components/sessions/transcript/viewport/sessionOpen/webInitialPinRetryPlan';
import type {
    SessionOpenArmResetPlan,
    SessionOpenDisposeResetPlan,
    SessionOpenEntryKind,
    SessionOpenLatchEffect,
} from '@/components/sessions/transcript/viewport/sessionOpen/types';
import { resolveSessionEntryViewportState } from '@/components/sessions/transcript/scroll/resolveSessionEntryBottomFollow';
import type { LastNativeRestoreIndexCommand, ScrollableChatListRef } from '@/components/sessions/transcript/viewport/transcriptScrollableListTypes';
import { readNativeAbsoluteScrollOffset } from '@/components/sessions/transcript/viewport/driver/readNativeAbsoluteScrollOffset';
import { createWebDomScrollObservation, type WebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import {
    canAutoFollowTranscriptBottom,
    isExplicitTranscriptBottomFollowCommand,
    resolveTranscriptAutoFollowPinWaitMs,
} from '@/components/sessions/transcript/scroll/transcriptAutoFollowGate';
import {
    resolveTranscriptScrollPinStateUpdate,
    type TranscriptBottomFollowModeState,
    type TranscriptScrollPinEvent,
    type TranscriptScrollPinState,
} from '@/components/sessions/transcript/scroll/transcriptBottomFollowMode';
import {
    TranscriptListShell,
    type TranscriptListShellPlatformInteractionProps,
    type TranscriptListShellRef,
} from '@/components/sessions/transcript/viewport/shell/TranscriptListShell';
import { resolveMainTranscriptRendererFrameHost } from '@/components/sessions/transcript/viewport/shell/mainTranscriptRendererFrameHost';
import { resolveTranscriptListShellEdgeSlots } from '@/components/sessions/transcript/viewport/shell/transcriptListShellEdgeSlots';
import {
    resolveOlderNeighborRenderedIndex,
    resolveTranscriptListPresentation,
    type TranscriptListOrientation,
} from '@/components/sessions/transcript/listOrientation';
import {
    resolveTranscriptEdgePrefetchThresholdPx,
    TRANSCRIPT_EDGE_PREFETCH_FALLBACK_VIEWPORT_RATIO,
    TRANSCRIPT_EDGE_PREFETCH_MAX_PX,
    TRANSCRIPT_EDGE_PREFETCH_MIN_PX,
} from '@/components/sessions/transcript/scroll/resolveTranscriptEdgePrefetchThresholdPx';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import {
    isEnrichedMarkdownRuntimePreloaded,
    preloadEnrichedMarkdownRuntime,
} from '@/components/markdown/enriched/preloadEnrichedMarkdownRuntime';
import { resolveActiveThinkingMessageId } from '@/components/sessions/transcript/thinking/resolveActiveThinkingMessageId';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { deriveTranscriptInteractionFromSession, type TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { listPendingUserActionRequests } from '@/utils/sessions/sessionUtils';
import { buildChatListNativeId } from './chatListNativeId';
import {
    TranscriptMessageSelectionBoundary,
    useOptionalTranscriptSelectionState,
} from '@/components/sessions/transcript/messageSelection/TranscriptMessageSelectionContext';
import { resolveNativeInvertedColdScrollIndex } from '@/components/sessions/transcript/segments/resolveWebHotColdScrollDecision';
import { TranscriptHotTail } from '@/components/sessions/transcript/segments/TranscriptHotTail';
import {
    isMessageRolledBack,
    readSessionRollbackRangesV1,
    resolveTranscriptRollbackActions,
    type TranscriptRollbackAction,
    type SessionRollbackRangeV1,
} from '@/sync/domains/sessionRollback/rollbackUiSupport';
import {
    getWebTranscriptDistanceFromBottom,
    isWebTranscriptScrollable,
    resolveWebTranscriptMaxScrollTop,
    resolveWebTranscriptScrollMetrics,
    type WebTranscriptScrollMetrics,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import {
    TRANSCRIPT_WEB_HOT_TAIL_ITEM_TEST_ID_PREFIX,
    WebTranscriptSplitFooter,
} from '@/components/sessions/transcript/web/WebTranscriptSplitFooter';
import {
    ComposerKeyboardFloatingInset,
    ComposerKeyboardScrollInset,
} from '@/components/sessions/keyboardAvoidance';
import {
    captureWebTranscriptPrependAnchor,
    captureWebTranscriptViewportAnchor,
    refreshWebTranscriptPrependAnchor,
    resolveWebTranscriptViewportAnchorAlignment,
    TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX,
    TRANSCRIPT_WEB_TOOL_CALL_PREPEND_ANCHOR_TEST_ID_PREFIX,
    TRANSCRIPT_WEB_TOOL_GROUP_PREPEND_ANCHOR_TEST_ID_PREFIX,
    type WebTranscriptPrependAnchor,
    type WebTranscriptPrependRestoreResult,
    type WebTranscriptViewportAnchor,
    type WebTranscriptViewportAnchorRestoreResult,
} from '@/components/sessions/transcript/viewport/prepend/webTranscriptPrependAnchor';
import {
    captureNativeTranscriptViewportAnchor,
    resolveNativeTranscriptViewportAnchorRestoreObservation,
} from '@/components/sessions/transcript/viewport/driver/transcriptNativeViewportAnchor';
import {
    resolveTranscriptViewportAnchorDescriptor,
    resolveTranscriptViewportAnchorFocusOffsetPx,
    resolveTranscriptViewportAnchorIndex,
} from '@/components/sessions/transcript/viewport/entryRestore/transcriptViewportAnchorResolution';
import {
    resolveTranscriptJumpSeqIndex,
    resolveTranscriptJumpTargetIndex,
} from '@/components/sessions/transcript/viewport/jump/resolveTranscriptJumpTargetIndex';
import type {
    TranscriptJumpResult,
    TranscriptJumpTarget,
    TranscriptJumpTargetIndexResult,
    TranscriptJumpTargetRole,
} from '@/components/sessions/transcript/viewport/jump/transcriptJumpTargetTypes';
import {
    executeTranscriptTargetWindowJump,
    isTranscriptSeqMountedInWebRenderedWindow,
    resolveTranscriptJumpTargetRequest,
    resolveTranscriptNavigationJumpPlan,
    resolveTranscriptNavigationPaneJumpRequest,
    resolveTranscriptRouteJumpSeqPlan,
    resolveTranscriptTargetWindowLoadTarget,
} from '@/components/sessions/transcript/viewport/window/useTranscriptTargetWindowHostAdapter';
import {
    resolveTranscriptRenderWindowProjection,
    type TranscriptRenderWindowProjection,
} from '@/components/sessions/transcript/viewport/window/resolveTranscriptRenderWindowProjection';
import {
    clearStreamingSessionUiTelemetryMarks,
    readSessionUiTelemetryNowMs,
    recordSessionOpenPaintForSessionUiTelemetry,
    recordStreamingVisibleUpdateForSessionUiTelemetry,
} from '@/sync/runtime/performance/sessionUiTelemetry';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import {
    TRANSCRIPT_TOP_GUTTER_PX,
    TRANSCRIPT_VISUAL_UPDATE_FALLBACK_TIMEOUT_MS,
} from '@/components/sessions/transcript/_constants';
import { CatchUpProgressOverlay } from '@/components/sessions/transcript/CatchUpProgressOverlay';
import { OlderLoadProgressOverlay } from '@/components/sessions/transcript/OlderLoadProgressOverlay';
import {
    useTranscriptOlderPagination,
    type TranscriptOlderPaginationSnapshot,
} from '@/components/sessions/transcript/pagination/useTranscriptOlderPagination';
import { waitForNextTranscriptVisualUpdate } from '@/components/sessions/transcript/pagination/waitForNextTranscriptVisualUpdate';
import { waitForVisualUpdateWithTimeout } from '@/components/sessions/transcript/pagination/waitForVisualUpdateWithTimeout';
import {
    readPersistedSessionMessagePins,
    savePersistedSessionMessagePins,
} from '@/sync/domains/state/sessionMessagePinsPersistence';
import {
    buildTranscriptNavigationLoadedMessages,
    createTranscriptNavigationLoadedMessagesCache,
    deriveTranscriptNavigationEntriesWithLoadedMessageCache,
} from '@/components/sessions/transcript/navigation/buildTranscriptNavigationLoadedMessages';
import { deriveTranscriptNavigationRailLayout } from '@/components/sessions/transcript/navigation/deriveTranscriptNavigationRailLayout';
import {
    deriveTranscriptNavigationRemoteUserTurns,
    resolveTranscriptNavigationRemoteUserTurnBeforeSeq,
} from '@/components/sessions/transcript/navigation/transcriptNavigationRemoteUserTurns';
import { TranscriptNavigationRail } from '@/components/sessions/transcript/navigation/TranscriptNavigationRail';
import { transcriptNavigationPaneStore, useTranscriptNavigationPaneOpen } from '@/components/sessions/transcript/navigation/transcriptNavigationPaneStore';
import type {
    TranscriptNavigationEntry,
    TranscriptNavigationJumpRequest,
} from '@/components/sessions/transcript/navigation/transcriptNavigationTypes';
import { deriveNativeTranscriptVisibleAnchorFacts } from '@/components/sessions/transcript/viewport/visibility/nativeTranscriptVisibleAnchorFacts';
import {
    createTranscriptBlankRecoveryState,
    planTranscriptBlankRecoveryObservation,
    type TranscriptBlankRecoveryEffect,
} from '@/components/sessions/transcript/viewport/visibility/blankRecoveryOwner';
import {
    deriveTranscriptNavigationRuntimeAnchors,
    type TranscriptNavigationRenderedAnchorSource,
    type TranscriptNavigationRuntimeAnchor,
} from '@/components/sessions/transcript/viewport/visibility/transcriptNavigationRuntimeAnchors';
import {
    clearTranscriptNavigationVisibilityStore,
    getTranscriptNavigationVisibilityStore,
    useTranscriptNavigationVisibilitySnapshot,
} from '@/components/sessions/transcript/viewport/visibility/transcriptNavigationVisibilityStore';
import {
    hasAnyWebTranscriptDataTestId,
    resolveFirstVisibleWebAnchorTestId,
    scheduleWebTranscriptNavigationVisibilityObservation,
} from '@/components/sessions/transcript/viewport/visibility/webTranscriptNavigationVisibilityObserver';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { useUserMessageHistoryRemoteEntries } from '@/hooks/session/useUserMessageHistory';
import {
    toggleSessionMessagePin,
    type PersistedSessionMessagePinV1,
} from '@/sync/domains/messages/pins/sessionMessagePins';
import {
    createNativePrependOwner,
    type NativePrependBeginInput,
    type NativePrependObservationInput,
    type NativePrependOwner,
    type NativePrependOwnerEffect,
} from '@/components/sessions/transcript/viewport/prepend/nativePrependOwner';
import {
    createWebPrependOwner,
    type WebPrependOwner,
    type WebPrependOwnerEffect,
} from '@/components/sessions/transcript/viewport/prepend/webPrependOwner';
import { LruMap } from '@/utils/cache/lruMap';
import type { TranscriptMeasurementReconciler } from '@/components/sessions/transcript/measurement/transcriptMeasurementReconciler';
import {
    createTranscriptMeasurementHost,
    type TranscriptMeasurementHostEffect,
} from '@/components/sessions/transcript/measurement/transcriptMeasurementHost';
import type { TranscriptRowLayoutMutation } from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';
import {
    buildTranscriptRowShellSignature,
    resolveTranscriptItemActiveThinkingMessageId,
    resolveTranscriptRowItemType,
    type TranscriptRowShellItem,
} from '@/components/sessions/transcript/measurement/transcriptRowShellSignature';
import {
    collectTranscriptNavigationMessageIdsForItem,
    resolveTranscriptLiveTailAnchor,
    transcriptNavigationRoleForMessage,
    type TranscriptLiveTailAnchorReason,
} from '@/components/sessions/transcript/viewport/lifecycle/transcriptRowClassification';
import type { TranscriptMountSettleTuning } from '@/components/sessions/transcript/viewport/lifecycle/mountSettle';
import {
    type TranscriptSessionCommonProps,
    useTranscriptSessionCommon,
} from '@/components/sessions/transcript/transcriptSessionCommon';
import {
    hasTranscriptWarmStablePaint,
    rememberTranscriptWarmStablePaint,
} from '@/components/sessions/transcript/paint/transcriptWarmPaintCache';
import {
    resolveNativeBottomFollowPreviousFollow,
    resolveNativeContentMaterializationAutoPin,
    resolveNativeInitialFollowBottomDecision,
    resolveNativeMountSettleIntervalDecision,
    resolveNativeMountSettleBottomPinRetention,
    resolveNativeMountSettlePassiveDriftRepinDistanceDecision,
    resolveNativeMountSettlePassiveDriftRepinEffects,
    resolveNativeMountSettlePassiveDriftRepinPreflightDecision,
    resolveNativeMountSettlePendingFlushTriggerDecision,
    type NativeContentMaterializationAutoPin,
    type NativeContentMaterializationAutoPinPostSuccessDecision,
    type NativeInitialFollowBottomDecision,
    type NativeMountSettleIntervalDecision,
    type NativeMountSettlePassiveDriftRepinEffect,
    type NativeMountSettlePendingFlushTriggerDecision,
    type NativeStreamAppendPinContentVersion,
    type NativeSuccessfulBottomPinRecords,
    type NativeSuccessfulBottomPinInitialViewportEffects,
} from '@/components/sessions/transcript/viewport/nativeBottomFollowObservationPolicy';
import { resolveNativeSliceEntryObservation } from '@/components/sessions/transcript/viewport/nativeEntryRestoreObservationPolicy';
import {
    createEntryRestoreOwner,
    type EntryRestoreOwner,
    type EntryRestoreOwnerAnchor,
    type EntryRestoreOwnerEffect,
} from '@/components/sessions/transcript/viewport/entryRestore/entryRestoreOwner';
import type { EntryRestoreSliceTarget } from '@/components/sessions/transcript/viewport/entryRestore/resolveEntryRestoreTarget';
import { resolveJumpSeqViewportPromotion, resolveJumpSeqViewportPromotionState } from '@/components/sessions/transcript/viewport/entryRestore/jumpSeqViewportPromotion';
import { stampViewportAnchorForEmit as stampViewportAnchorForEmitState } from '@/components/sessions/transcript/viewport/entryRestore/stampViewportAnchorForEmit';
import {
    shouldIgnoreNativeInvalidScrollObservation as resolveShouldIgnoreNativeInvalidScrollObservation,
} from '@/components/sessions/transcript/viewport/nativePassiveScrollPolicy';
function didWebViewportAnchorRestoreSucceed(
    result: WebTranscriptViewportAnchorRestoreResult,
): boolean {
    return result.status === 'restored' || result.status === 'already_aligned';
}

type ChatTranscriptListItem = TranscriptRowShellItem;

type ContentGrowthLiveTailCommandApplyEffect =
    NonNullable<TranscriptLifecycleHostContentGrowthLiveTailCommandPlan['contentGrowthLiveTailCommandEffect']>;
type SessionEntryRenderResetEffects = TranscriptLifecycleHostSessionEntryPlan['renderResetEffects'];
type SessionEntryViewportApplyEffect = TranscriptLifecycleHostSessionEntryPlan['viewportEffects'][number];
type ExplicitJumpTakeoverApplyEffect = TranscriptLifecycleHostExplicitJumpPlan['explicitJumpTakeoverEffects'][number];
type ExplicitReturnToLiveTailViewportEffect = TranscriptLifecycleHostExplicitReturnPlan['viewportEffects'][number];
type FollowBottomIntentTakeoverApplyEffect =
    TranscriptLifecycleHostFollowBottomIntentPlan['followBottomIntentTakeoverEffects'][number];
type LocalTranscriptInteractionAutoPinDeferralApplyEffect =
    TranscriptLifecycleHostLocalInteractionPlan['localInteractionAutoPinDeferralEffects'][number];
type NativeMeasuredPinPlan = TranscriptLifecycleHostMeasuredNativePinPlan;
type NativeMeasuredPinIssuePlan = Extract<NativeMeasuredPinPlan, { type: 'issue-command' }>;
type NativeMeasuredBottomPinCommandResultPlan = NativeMeasuredPinIssuePlan['commandPlan'];
type NativeMeasuredBottomPinCommandResultPostSuccessPlan =
    NativeMeasuredBottomPinCommandResultPlan['postSuccess'];
type NativeInvertedFollowBottomPinDecision =
    NativeMeasuredPinIssuePlan['invertedFollowBottomDecision'];
type NativeMeasuredBottomPinPreAutoFollowDecision =
    NativeMeasuredPinIssuePlan['preAutoFollowDecision'];
type NativeAutomaticPinSameOffsetDecision =
    NativeMeasuredPinIssuePlan['sameOffsetDecision'];
type NativeStreamAppendContentVersionDecision =
    NativeMeasuredPinIssuePlan['streamAppendDecision'];
type NativeMountSettlePendingPinFlushPlan =
    TranscriptLifecycleHostNativeMountSettlePendingPinFlushPlan;
type NativeGestureTakeoverPlan = TranscriptLifecycleHostNativeGestureTakeoverPlan;
type NativeOffsetReleaseLiveTailStateEffect =
    TranscriptLifecycleHostNativeOffsetEscapeReleasePlan['nativeOffsetReleaseLiveTailStateEffects'][number];
type ScrollObservationPlan = TranscriptLifecycleHostScrollObservationPlan;
type WebPassiveLiveTailCorrectionEffect =
    NonNullable<ScrollObservationPlan['webPassiveLiveTailCorrectionEffect']>;
type NativeScrollAcceptedViewportPaintEffect =
    ScrollObservationPlan['acceptedViewportPaintEffects'][number];
type GenericScrollObservationViewportStateEffect =
    Extract<TranscriptViewportLifecycleEffect, { type: 'apply-generic-observed-viewport-state' }>;
type GenericScrollObservationReadOnlyVisibleBottomEffect =
    Extract<TranscriptViewportLifecycleEffect, { type: 'apply-generic-read-only-visible-bottom-state' }>;
type GenericScrollObservationSuppressionEffect =
    Extract<TranscriptViewportLifecycleEffect, { type: 'suppress-generic-scroll-observation' }>;
type GenericScrollObservationAnchorCaptureCancellationEffect =
    Extract<TranscriptViewportLifecycleEffect, { type: 'cancel-scheduled-viewport-anchor-capture' }>;
type NativeTouchIntentApplyEffect =
    TranscriptLifecycleHostNativeTouchIntentPlan['nativeTouchIntentEffects'][number];
type NativeTouchReleaseLiveTailStateEffect =
    TranscriptLifecycleHostNativeTouchReleasePlan['nativeTouchReleaseStateEffects'][number];
type NativeUserScrollTakeoverApplyEffect =
    TranscriptLifecycleHostNativeUserScrollTakeoverPlan['nativeUserScrollTakeoverEffects'][number];


function measureTranscriptDerivation<T>(
    name: string,
    buildFields: () => Record<string, number>,
    fn: () => T,
): T {
    if (!syncPerformanceTelemetry.isEnabled()) return fn();
    return syncPerformanceTelemetry.measure(name, buildFields(), fn);
}

type NativeVisibleWindowSnapshot = Readonly<{
    blankAreaPx: number;
    blankAreaSource: TranscriptViewportTelemetryBlankAreaSource;
    firstVisibleItemId?: string;
    hasVisibleRows: boolean;
    lastVisibleItemId?: string;
    lastKnownFirstVisibleItemId?: string;
    lastKnownLastVisibleItemId?: string;
    visibleWindowStale?: boolean;
    visibleWindowSource: TranscriptViewportTelemetryVisibleWindowSource;
    visibleRangeReadStatus?: TranscriptViewportTelemetryVisibleRangeReadStatus;
    visibleRenderedStartIndex?: number;
    visibleRenderedEndIndex?: number;
    firstVisibleRenderedIndex?: number;
}>;

type NativeViewableTranscriptItem = Readonly<{
    index?: number | null;
    isViewable?: boolean;
    item?: ChatTranscriptListItem | null;
}>;

type ScheduledPinToBottom = BottomFollowScheduledWrite<WebTranscriptScrollMetrics> & {
    id: any;
};

const EMPTY_MESSAGES_BY_ID: Readonly<Record<string, Message>> = Object.freeze({});
const TRANSCRIPT_SCROLL_AUTO_REPIN_THROTTLE_MS = 200;
const TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS = 250;
const TRANSCRIPT_SCROLL_USER_INTENT_RECENT_MS = 500;
// Plan E3: consecutive same-direction non-programmatic web scroll frames required before the
// movement heuristic treats it as user intent (scrollbar drag / keyboard scrolling, which fire
// no wheel/pointer/touch handlers). A single frame can be virtualization height-churn noise.
const TRANSCRIPT_WEB_NON_PROGRAMMATIC_SCROLL_SUSTAIN_FRAMES = 2;
const TRANSCRIPT_NATIVE_ENTRY_SLICE_HEAD_OFFSET_TOLERANCE_PX = 2;
const TRANSCRIPT_NATIVE_ENTRY_RESTORE_PAINT_RELEASE_DELAY_MS = 32;
const TRANSCRIPT_WEB_PREPEND_INDEX_RECOVERY_RETRY_MS = 16;
const TRANSCRIPT_NATIVE_TOUCH_ESCAPE_MOVE_THRESHOLD_PX = 12;
const TRANSCRIPT_SCROLL_JUMP_TO_BOTTOM_REVEAL_VIEWPORT_RATIO_MAX = 4;
const TRANSCRIPT_DERIVED_ITEMS_CACHE_FALLBACK_MAX_SESSIONS = 16;
const TRANSCRIPT_ROW_WIDTH_BUCKET_PX = 64;

function resolveNativeScrollEventMetric(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
}

function canUseWriteFreeEntrySliceForAnchorOffset(itemOffsetPx: number): boolean {
    return (
        Number.isFinite(itemOffsetPx) &&
        Math.abs(itemOffsetPx) <= TRANSCRIPT_NATIVE_ENTRY_SLICE_HEAD_OFFSET_TOLERANCE_PX
    );
}

function normalizeRestoreAnchorIdentity(
    anchor: Pick<SessionViewportAnchorSnapshot, 'kind' | 'itemId' | 'messageId'>,
): TranscriptViewportAnchorIdentity | null {
    if (typeof anchor.itemId !== 'string' || anchor.itemId.length === 0) return null;
    return {
        kind: anchor.kind,
        itemId: anchor.itemId,
        messageId: anchor.messageId ?? null,
    };
}

function normalizeDurableViewportSeq(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const seq = Math.trunc(value);
    return seq > 0 ? seq : null;
}

function readFiniteTelemetryNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readTelemetryBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function readNativeTouchPageY(event: unknown): number | null {
    const nativeEvent = (event as { nativeEvent?: unknown } | null | undefined)?.nativeEvent as Record<string, unknown> | undefined;
    if (!nativeEvent) return null;
    const candidates = [
        nativeEvent.pageY,
        nativeEvent.locationY,
        Array.isArray(nativeEvent.touches)
            ? (nativeEvent.touches[0] as Record<string, unknown> | undefined)?.pageY
            : undefined,
        Array.isArray(nativeEvent.changedTouches)
            ? (nativeEvent.changedTouches[0] as Record<string, unknown> | undefined)?.pageY
            : undefined,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'number' && Number.isFinite(candidate)) {
            return candidate;
        }
    }
    return null;
}

type TranscriptDerivedItemsCacheEntry = {
    linearItemsCache: ChatListItemsBuildCache | null;
    turnsCache: TranscriptTurnsBuildCache | null;
};

const transcriptDerivedItemsCacheBySessionId = new LruMap<string, TranscriptDerivedItemsCacheEntry>({
    maxEntries: TRANSCRIPT_DERIVED_ITEMS_CACHE_FALLBACK_MAX_SESSIONS,
});

function resolveTranscriptDerivedItemsCacheMaxSessions(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return TRANSCRIPT_DERIVED_ITEMS_CACHE_FALLBACK_MAX_SESSIONS;
    }
    return Math.max(1, Math.min(64, Math.trunc(value)));
}

function readTranscriptDerivedItemsCacheEntry(
    sessionId: string,
    maxSessions: number,
): TranscriptDerivedItemsCacheEntry {
    transcriptDerivedItemsCacheBySessionId.setMaxEntries(maxSessions);
    const existing = transcriptDerivedItemsCacheBySessionId.get(sessionId);
    if (existing) return existing;
    const entry: TranscriptDerivedItemsCacheEntry = {
        linearItemsCache: null,
        turnsCache: null,
    };
    transcriptDerivedItemsCacheBySessionId.set(sessionId, entry);
    return entry;
}

function writeTranscriptDerivedItemsCacheEntry(
    sessionId: string,
    maxSessions: number,
    patch: Partial<TranscriptDerivedItemsCacheEntry>,
): void {
    transcriptDerivedItemsCacheBySessionId.setMaxEntries(maxSessions);
    const existing = transcriptDerivedItemsCacheBySessionId.get(sessionId) ?? {
        linearItemsCache: null,
        turnsCache: null,
    };
    transcriptDerivedItemsCacheBySessionId.set(sessionId, {
        ...existing,
        ...patch,
    });
}

type LoadOlderOptions = Readonly<{
    loadingIndicatorDelayMs?: number;
    preservePrependViewport?: boolean;
    showLoadingIndicator?: boolean;
}>;

type SyncLoadOlderOptions = Readonly<{
    limit: number;
}>;

export type ChatListBottomNotice = {
    title: string;
    body: string;
};

function readSessionViewportForEntry(sessionId: string) {
    return typeof sync.getSessionViewport === 'function' ? sync.getSessionViewport(sessionId) : null;
}

function buildRollbackActionsInputSignature(params: Readonly<{
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
}>): string {
    let signature = '';
    for (const messageId of params.messageIdsOldestFirst) {
        const message = params.messagesById[messageId];
        if (!message) {
            signature += `${messageId}:missing|`;
            continue;
        }
        const seq = typeof message.seq === 'number' && Number.isFinite(message.seq) ? Math.trunc(message.seq) : '';
        signature += `${message.id}:${message.kind}:${seq}`;
        if (message.kind === 'user-text') {
            signature += `:${message.text}`;
        }
        signature += '|';
    }
    return signature;
}

function useStableValueBySignature<T>(value: T, signature: string): T {
    const ref = React.useRef<{ signature: string; value: T }>({ signature, value });
    if (ref.current.signature !== signature) {
        ref.current = { signature, value };
    }
    return ref.current.value;
}

function resolveTranscriptRowWidthBucket(width: unknown): string {
    const normalizedWidth = typeof width === 'number' && Number.isFinite(width)
        ? Math.max(1, Math.trunc(width))
        : 1;
    const bucket = Math.max(
        TRANSCRIPT_ROW_WIDTH_BUCKET_PX,
        Math.ceil(normalizedWidth / TRANSCRIPT_ROW_WIDTH_BUCKET_PX) * TRANSCRIPT_ROW_WIDTH_BUCKET_PX,
    );
    return `width:${bucket}`;
}

function resolveInitialTranscriptRowWidthBucket(): string {
    return resolveTranscriptRowWidthBucket(Dimensions.get('window')?.width);
}

function resolveFontScaleKey(): string {
    const fontScale = typeof PixelRatio.getFontScale === 'function'
        ? PixelRatio.getFontScale()
        : Dimensions.get('window')?.fontScale;
    const normalized = typeof fontScale === 'number' && Number.isFinite(fontScale)
        ? Math.max(0.5, fontScale)
        : 1;
    return `font:${Math.round(normalized * 100)}`;
}

function resolveTranscriptMountSettleTuning(): TranscriptMountSettleTuning {
    const tuning = sync.getSyncTuning();
    return {
        quiescentWindowMs: tuning.transcriptMountSettleQuiescentWindowMs,
        dimensionNoiseFloorPx: tuning.transcriptMountSettleDimensionNoiseFloorPx,
        bottomDistanceNoiseFloorPx: tuning.transcriptMountSettleBottomDistanceNoiseFloorPx,
    };
}

export type TranscriptViewportChangeState = Readonly<{
    isPinned: boolean;
    offsetY: number;
    shouldRestoreViewport: boolean;
    anchor?: SessionViewportAnchorSnapshot | null;
}>;

type PendingJumpSeqViewportPromotion = Readonly<{
    emitViewportChange: ((state: TranscriptViewportChangeState) => void) | undefined;
    seq: number;
    sessionId: string;
}>;

type PromotedJumpSeqViewportProtection = Readonly<{
    promotedAtMs: number;
    seq: number;
    sessionId: string;
}>;

type ChatListProps = Readonly<{
    session: Session;
    bottomNotice?: ChatListBottomNotice | null;
    controlledByUserOverride?: boolean;
    controlSwitchTo?: 'remote' | null;
    onRequestSwitchToRemote?: () => void;
    directControlFooter?: ChatFooterDirectControlState;
    approvalRequests?: readonly OpenApprovalArtifactForSession[];
    jumpToSeq?: number | null;
    followBottomIntentKey?: string | number | null;
    onJumpLanded?: (result: Extract<TranscriptJumpResult, { status: 'scrolled' | 'window-rendered' }>) => void;
    onViewportChange?: (state: TranscriptViewportChangeState) => void;
    onEditPendingMessage?: (request: PendingMessageEditRequest) => void | Promise<void>;
    isWarmKeepAliveInstance?: boolean;
    routeHydrationPending?: boolean;
}>;

function areChatListSessionRelevantPropsEqual(left: Session, right: Session): boolean {
    return buildSessionTranscriptRenderSignature(left) === buildSessionTranscriptRenderSignature(right);
}

function areChatListNonSessionPropsEqual(left: ChatListProps, right: ChatListProps): boolean {
    return left.bottomNotice === right.bottomNotice
        && left.controlledByUserOverride === right.controlledByUserOverride
        && left.controlSwitchTo === right.controlSwitchTo
        && left.onRequestSwitchToRemote === right.onRequestSwitchToRemote
        && left.directControlFooter === right.directControlFooter
        && left.approvalRequests === right.approvalRequests
        && left.jumpToSeq === right.jumpToSeq
        && left.followBottomIntentKey === right.followBottomIntentKey
        && left.onJumpLanded === right.onJumpLanded
        && left.onViewportChange === right.onViewportChange
        && left.onEditPendingMessage === right.onEditPendingMessage
        && left.isWarmKeepAliveInstance === right.isWarmKeepAliveInstance
        && left.routeHydrationPending === right.routeHydrationPending;
}

function areChatListPropsEqual(left: ChatListProps, right: ChatListProps): boolean {
    if (!areChatListNonSessionPropsEqual(left, right)) return false;
    if (left.session === right.session) return true;
    return areChatListSessionRelevantPropsEqual(left.session, right.session);
}

function requestSessionOpenInitialFill(): void {
    fireAndForget(preloadEnrichedMarkdownRuntime(), { tag: 'ChatList.preloadEnrichedMarkdownRuntime' });
}

export const ChatList = React.memo(function ChatList(props: ChatListProps) {
    const fork = useForkedTranscriptSnapshot(props.session.id);
    const { ids: childMessageIdsOldestFirst, isLoaded } = useSessionTranscriptIds(props.session.id);
    const childMessagesById = useSessionMessagesById(props.session.id);
    const forkedTranscriptEnabled = fork != null;
    const swrFallbackCandidateEnabled = !forkedTranscriptEnabled && childMessageIdsOldestFirst.length === 0;
    const { messages: swrCommittedMessages } = useSessionMessages(props.session.id, { enabled: swrFallbackCandidateEnabled });
    const { messages: pendingMessages, discarded: discardedPendingMessages } = useSessionPendingMessages(props.session.id);
    const actionDrafts = useSessionActionDrafts(props.session.id);
    const transcriptGroupingMode = useSetting('transcriptGroupingMode');
    const transcriptGroupToolCalls = useSetting('transcriptGroupToolCalls');
    const transcriptTurnToolCallsGroupStrategy = useSetting('transcriptTurnToolCallsGroupStrategy');
    const transcriptSessionCommon = useTranscriptSessionCommon(props.session.id);
    const toolViewTimelineChromeMode = transcriptSessionCommon.toolChrome.toolViewTimelineChromeMode;

    const swrFallbackEnabled = !forkedTranscriptEnabled
        && childMessageIdsOldestFirst.length === 0
        && swrCommittedMessages.length > 0;
    const swrFallbackMessageIdsOldestFirst = React.useMemo(() => {
        if (!swrFallbackEnabled) return childMessageIdsOldestFirst;
        return swrCommittedMessages.map((message) => message.id);
    }, [childMessageIdsOldestFirst, swrCommittedMessages, swrFallbackEnabled]);
    const swrFallbackMessagesById = React.useMemo(() => {
        if (!swrFallbackEnabled) return childMessagesById;
        const out: Record<string, Message> = {};
        for (const message of swrCommittedMessages) {
            out[message.id] = message;
        }
        return out;
    }, [childMessagesById, swrCommittedMessages, swrFallbackEnabled]);

    const forkContextNeedsPrefetch = React.useMemo(() => {
        if (!fork) return false;
        return fork.segments.some((seg) =>
            seg.isReadOnlyContext === true &&
            typeof seg.cutoffSeqInclusive === 'number' &&
            Number.isFinite(seg.cutoffSeqInclusive) &&
            seg.cutoffSeqInclusive >= 0 &&
            (seg.messageIdsOldestFirst?.length ?? 0) === 0
        );
    }, [fork]);

    React.useEffect(() => {
        if (!forkContextNeedsPrefetch) return;
        fireAndForget(sync.prefetchForkedTranscriptContext(props.session.id), { tag: 'ChatList.prefetchForkedTranscriptContext' });
    }, [forkContextNeedsPrefetch, props.session.id]);

    const forkAwareMessageDescriptors = React.useMemo(() => {
        if (!forkedTranscriptEnabled || !fork) return null;
        return buildForkAwareMessageDescriptors(fork);
    }, [fork, forkedTranscriptEnabled]);
    const messageIdsOldestFirst = React.useMemo(() => {
        if (forkAwareMessageDescriptors) {
            return forkAwareMessageDescriptors.messageIdsOldestFirst as string[];
        }
        return swrFallbackMessageIdsOldestFirst;
    }, [forkAwareMessageDescriptors, swrFallbackMessageIdsOldestFirst]);
    const messagesById = React.useMemo(() => {
        if (forkAwareMessageDescriptors) {
            return forkAwareMessageDescriptors.messagesById as Record<string, Message>;
        }
        return swrFallbackMessagesById;
    }, [forkAwareMessageDescriptors, swrFallbackMessagesById]);
    const activeServerAccountScope = useActiveServerAccountScope();
    const [messagePinsRevision, bumpMessagePinsRevision] = React.useReducer((value: number) => value + 1, 0);
    const sessionMessagePins = React.useMemo(
        () => readPersistedSessionMessagePins(props.session.id, activeServerAccountScope),
        [activeServerAccountScope, messagePinsRevision, props.session.id],
    );
    const transcriptNavigationLoadedMessagesCacheRef = React.useRef<ReturnType<typeof createTranscriptNavigationLoadedMessagesCache> | null>(null);
    if (!transcriptNavigationLoadedMessagesCacheRef.current) {
        transcriptNavigationLoadedMessagesCacheRef.current = createTranscriptNavigationLoadedMessagesCache();
    }
    const transcriptNavigationLoadedMessagesCache = transcriptNavigationLoadedMessagesCacheRef.current;
    const togglePersistedSessionMessagePin = React.useCallback((pin: PersistedSessionMessagePinV1) => {
        const currentPins = readPersistedSessionMessagePins(props.session.id, activeServerAccountScope);
        const nextPins = toggleSessionMessagePin(currentPins, pin);
        savePersistedSessionMessagePins(props.session.id, nextPins, activeServerAccountScope);
        bumpMessagePinsRevision();
    }, [activeServerAccountScope, props.session.id]);
    const transcriptNavigationLoadedMessages = React.useMemo(() => (
        buildTranscriptNavigationLoadedMessages({
            cache: transcriptNavigationLoadedMessagesCache,
            messageIdsOldestFirst,
            messagesById,
            sessionId: props.session.id,
        })
    ), [messageIdsOldestFirst, messagesById, props.session.id, transcriptNavigationLoadedMessagesCache]);
    const transcriptNavigationRemoteBeforeSeq = React.useMemo(
        () => resolveTranscriptNavigationRemoteUserTurnBeforeSeq(transcriptNavigationLoadedMessages),
        [transcriptNavigationLoadedMessages],
    );
    const transcriptNavigationRemoteHistory = useUserMessageHistoryRemoteEntries({
        autoLoad: transcriptNavigationRemoteBeforeSeq !== null,
        enabled: !forkedTranscriptEnabled && transcriptNavigationRemoteBeforeSeq !== null,
        initialBeforeSeq: transcriptNavigationRemoteBeforeSeq,
        sessionId: props.session.id,
    });
    const transcriptNavigationRemoteUserTurns = React.useMemo(() => (
        deriveTranscriptNavigationRemoteUserTurns({
            sessionId: props.session.id,
            beforeSeq: transcriptNavigationRemoteBeforeSeq,
            entries: transcriptNavigationRemoteHistory.entries,
        })
    ), [props.session.id, transcriptNavigationRemoteBeforeSeq, transcriptNavigationRemoteHistory.entries]);
    const transcriptNavigationEntries = React.useMemo<TranscriptNavigationEntry[]>(() => {
        return deriveTranscriptNavigationEntriesWithLoadedMessageCache({
            cache: transcriptNavigationLoadedMessagesCache,
            sessionId: props.session.id,
            mode: 'all',
            loadedMessages: transcriptNavigationLoadedMessages,
            remoteUserTurns: transcriptNavigationRemoteUserTurns,
            pins: sessionMessagePins,
        });
    }, [props.session.id, sessionMessagePins, transcriptNavigationLoadedMessages, transcriptNavigationLoadedMessagesCache, transcriptNavigationRemoteUserTurns]);
    const committedMessagesForPendingRequests = React.useMemo(() => (
        messageIdsOldestFirst
            .map((messageId) => messagesById[messageId])
            .filter((message): message is Message => Boolean(message))
    ), [messageIdsOldestFirst, messagesById]);
    const pendingRequestsSessionSignature = React.useMemo(
        () => buildPendingSessionRequestsSourceSignature(props.session),
        [
            props.session.active,
            props.session.agentState,
            props.session.id,
            props.session.pendingPermissionRequestCount,
            props.session.pendingRequestObservedAt,
            props.session.pendingUserActionRequestCount,
        ],
    );
    const pendingRequestsSession = useStableValueBySignature(props.session, pendingRequestsSessionSignature);
    const pendingUserActionRequests = React.useMemo(
        () => listPendingUserActionRequests(pendingRequestsSession, committedMessagesForPendingRequests),
        [committedMessagesForPendingRequests, pendingRequestsSession],
    );
    const sessionMetadataSignature = React.useMemo(
        () => buildStableJsonSignature(buildSessionMetadataStabilitySignatureValue(props.session.metadata ?? null)),
        [props.session.metadata],
    );
    const stableSessionMetadata = useStableValueBySignature(props.session.metadata, sessionMetadataSignature);

    const groupingMode = transcriptGroupingMode === 'turns' ? 'turns' : 'linear';
    const groupToolCalls =
        transcriptGroupToolCalls === true &&
        toolViewTimelineChromeMode === 'activity_feed';
    const toolCallsGroupStrategy =
        transcriptTurnToolCallsGroupStrategy === 'all_tools_in_turn' ? 'all_tools_in_turn' : 'consecutive_tools';

    const syncTuning = sync.getSyncTuning();
    const derivedItemsCacheMaxSessions = resolveTranscriptDerivedItemsCacheMaxSessions(
        syncTuning.transcriptDerivedItemsCacheMaxSessions,
    );
    const transcriptMaxTurnEntriesPerListItem = syncTuning.transcriptMaxTurnEntriesPerListItem;
    const derivedItemsCacheEntry = readTranscriptDerivedItemsCacheEntry(
        props.session.id,
        derivedItemsCacheMaxSessions,
    );
    const turnsCache = React.useMemo(() => {
        if (groupingMode !== 'turns') return null;
        return measureTranscriptDerivation('ui.sessions.transcript.derived.turns', () => ({
            cacheProvided: derivedItemsCacheEntry.turnsCache ? 1 : 0,
            forked: forkAwareMessageDescriptors ? 1 : 0,
            groupToolCalls: groupToolCalls ? 1 : 0,
            messageCount: messageIdsOldestFirst.length,
        }), () => {
            return buildTranscriptTurnsCached({
                cache: derivedItemsCacheEntry.turnsCache,
                messageIdsOldestFirst,
                messagesById,
                pendingMessages,
                discardedMessages: discardedPendingMessages,
                groupToolCalls,
                toolCallsGroupStrategy,
                forkBoundaryBeforeMessageIds: forkAwareMessageDescriptors?.forkBoundaryBeforeMessageIds,
                forkBoundarySignature: forkAwareMessageDescriptors?.forkBoundarySignature,
                forkMetadataByMessageId: forkAwareMessageDescriptors?.metadataByMessageId,
            });
        });
    }, [forkAwareMessageDescriptors, groupingMode, messageIdsOldestFirst, messagesById, pendingMessages, discardedPendingMessages, groupToolCalls, toolCallsGroupStrategy]);

    React.useEffect(() => {
        if (groupingMode !== 'turns' || !turnsCache) return;
        writeTranscriptDerivedItemsCacheEntry(props.session.id, derivedItemsCacheMaxSessions, {
            turnsCache,
        });
    }, [derivedItemsCacheMaxSessions, groupingMode, props.session.id, turnsCache]);

    const linearCache = React.useMemo(() => {
        if (groupingMode === 'turns') return null;
        return measureTranscriptDerivation('ui.sessions.transcript.derived.linearItems', () => ({
            actionDraftCount: actionDrafts.length,
            cacheProvided: derivedItemsCacheEntry.linearItemsCache ? 1 : 0,
            discardedPendingCount: discardedPendingMessages?.length ?? 0,
            forked: forkAwareMessageDescriptors ? 1 : 0,
            groupToolCalls: groupToolCalls ? 1 : 0,
            messageCount: messageIdsOldestFirst.length,
            pendingCount: pendingMessages.length,
            pendingUserActionCount: pendingUserActionRequests.length,
        }), () => {
            return buildChatListItemsCached({
                cache: derivedItemsCacheEntry.linearItemsCache,
                messageIdsOldestFirst,
                messagesById,
                pendingMessages,
                discardedMessages: discardedPendingMessages,
                pendingUserActionRequests,
                actionDrafts,
                groupConsecutiveToolCalls: groupToolCalls,
                forkBoundaryBeforeMessageIds: forkAwareMessageDescriptors?.forkBoundaryBeforeMessageIds,
                forkBoundarySignature: forkAwareMessageDescriptors?.forkBoundarySignature,
                forkMetadataByMessageId: forkAwareMessageDescriptors?.metadataByMessageId,
            });
        });
    }, [actionDrafts, forkAwareMessageDescriptors, groupingMode, groupToolCalls, messageIdsOldestFirst, messagesById, pendingMessages, discardedPendingMessages, pendingUserActionRequests]);

    React.useEffect(() => {
        if (groupingMode === 'turns' || !linearCache) return;
        writeTranscriptDerivedItemsCacheEntry(props.session.id, derivedItemsCacheMaxSessions, {
            linearItemsCache: linearCache.cache,
        });
    }, [derivedItemsCacheMaxSessions, groupingMode, linearCache, props.session.id]);

    const groupedItems = React.useMemo<ChatTranscriptListItem[]>(() => {
        return measureTranscriptDerivation('ui.sessions.transcript.derived.groupedItems', () => ({
            actionDraftCount: actionDrafts.length,
            forked: forkedTranscriptEnabled && fork ? 1 : 0,
            messageCount: messageIdsOldestFirst.length,
            modeTurns: groupingMode === 'turns' ? 1 : 0,
            pendingCount: pendingMessages.length + (discardedPendingMessages?.length ?? 0),
            pendingUserActionCount: pendingUserActionRequests.length,
        }), () => {
            if (groupingMode !== 'turns') {
                const base = linearCache?.items ?? buildChatListItems({ messageIdsOldestFirst, messagesById, pendingMessages, discardedMessages: discardedPendingMessages, pendingUserActionRequests, actionDrafts });
                if (!forkedTranscriptEnabled || !fork) return base;
                return insertForkDividersIntoTranscriptItems({ items: base, fork }) as ChatTranscriptListItem[];
            }

            const trailing = buildChatListItems({
                messageIdsOldestFirst,
                messagesById,
                pendingMessages,
                discardedMessages: discardedPendingMessages,
                pendingUserActionRequests,
                actionDrafts,
                includeCommittedMessages: false,
            });

            // N2c: turn items are emitted UNDECOMPOSED here; per-unit decomposition for
            // flash_v2 happens inside ChatListInternal where tool-group expansion state lives.
            const turns = turnsCache?.turns ?? [];
            const turnItems: ForkDividerTranscriptItem[] = turns.map((t) => ({ kind: 'turn', id: t.id, turn: t }));
            const base: ForkDividerTranscriptItem[] = [...turnItems, ...trailing];
            if (!forkedTranscriptEnabled || !fork) return base;
            return insertForkDividersIntoTranscriptItems({ items: base, fork }) as ChatTranscriptListItem[];
        });
    }, [actionDrafts, fork, forkedTranscriptEnabled, groupingMode, linearCache, messageIdsOldestFirst, messagesById, pendingMessages, discardedPendingMessages, pendingUserActionRequests, turnsCache]);

    const latestCommittedActivityKey =
        messageIdsOldestFirst.length > 0 ? messageIdsOldestFirst[messageIdsOldestFirst.length - 1]! : null;
    const rollbackRanges = React.useMemo(
        () => readSessionRollbackRangesV1((stableSessionMetadata as Record<string, unknown> | null | undefined) ?? null),
        [sessionMetadataSignature, stableSessionMetadata],
    );
    const rollbackActionsInputSignature = React.useMemo(
        () => buildRollbackActionsInputSignature({ messageIdsOldestFirst, messagesById }),
        [messageIdsOldestFirst, messagesById],
    );
    const rollbackActionsByMessageId = React.useMemo(
        () => resolveTranscriptRollbackActions({
            session: props.session,
            messageIdsOldestFirst,
            messagesById,
            rollbackRanges,
        }),
        [
            props.session.accessLevel,
            props.session.active,
            props.session.sessionTurns,
            sessionMetadataSignature,
            rollbackActionsInputSignature,
            rollbackRanges,
        ],
    );

    const latestThinkingMessageId = useSessionLatestThinkingMessageId(props.session.id);
    const latestThinkingMessageActivityAtMs = useSessionLatestThinkingMessageActivityAtMs(props.session.id);
    const transcriptThinkingPulseStaleMs = useSetting('transcriptThinkingPulseStaleMs');
    const staleMs = typeof transcriptThinkingPulseStaleMs === 'number' && Number.isFinite(transcriptThinkingPulseStaleMs)
        ? transcriptThinkingPulseStaleMs
        : settingsDefaults.transcriptThinkingPulseStaleMs;
    const [thinkingPulseNow, setThinkingPulseNow] = React.useState(() => Date.now());

    React.useEffect(() => {
        if (props.session.thinking !== true) return;
        if (typeof latestThinkingMessageActivityAtMs !== 'number') return;
        if (typeof staleMs !== 'number' || !Number.isFinite(staleMs) || staleMs <= 0) return;

        const staleAt = latestThinkingMessageActivityAtMs + staleMs;
        const delayMs = staleAt - Date.now();
        if (delayMs <= 0) return;

        const t = setTimeout(() => setThinkingPulseNow(Date.now()), delayMs);
        return () => clearTimeout(t);
    }, [latestThinkingMessageActivityAtMs, props.session.thinking, staleMs]);

    const activeThinkingMessageId = React.useMemo(() => {
        return resolveActiveThinkingMessageId({
            sessionThinking: props.session.thinking === true,
            latestThinkingMessageId,
            latestCommittedMessageId: latestCommittedActivityKey,
            latestThinkingMessageActivityAtMs,
            nowMs: thinkingPulseNow,
            staleMs,
        });
    }, [latestCommittedActivityKey, latestThinkingMessageActivityAtMs, latestThinkingMessageId, props.session.thinking, staleMs, thinkingPulseNow]);

    const interaction = React.useMemo(() => {
        return deriveTranscriptInteractionFromSession({
            accessLevel: props.session.accessLevel,
            canApprovePermissions: props.session.canApprovePermissions,
            active: props.session.active,
            presence: props.session.presence,
        });
    }, [props.session.accessLevel, props.session.canApprovePermissions, props.session.active, props.session.presence]);
    const internalMessagesById = forkedTranscriptEnabled ? messagesById : EMPTY_MESSAGES_BY_ID;

    return (
        <TranscriptMessageSelectionBoundary
            key={props.session.id}
            sessionId={props.session.id}
            eligibleMessageIdsInOrder={messageIdsOldestFirst}
            enabled={transcriptSessionCommon.messageDisplay.transcriptMessageSelectionEnabled === true}
        >
            <SyncPerformanceReactProfiler id="sessions.transcript.chatList">
                <ChatListInternal
                    metadata={stableSessionMetadata}
                sessionId={props.session.id}
                sessionActive={props.session.active === true}
                sessionThinking={props.session.thinking === true}
                groupingMode={groupingMode}
                forkedTranscriptEnabled={forkedTranscriptEnabled}
                items={groupedItems}
                maxTurnEntriesPerListItem={transcriptMaxTurnEntriesPerListItem}
                transcriptNavigationEntries={transcriptNavigationEntries}
                messagePins={sessionMessagePins}
                onToggleMessagePin={togglePersistedSessionMessagePin}
                messagesById={internalMessagesById}
                forkMessageMetadataById={forkAwareMessageDescriptors?.metadataByMessageId ?? null}
                committedMessagesCount={messageIdsOldestFirst.length}
                latestCommittedActivityKey={latestCommittedActivityKey}
                activeThinkingMessageId={activeThinkingMessageId}
                rollbackRanges={rollbackRanges}
                rollbackActionsByMessageId={rollbackActionsByMessageId}
                isLoaded={isLoaded}
                bottomNotice={props.bottomNotice}
                controlledByUserOverride={props.controlledByUserOverride}
                controlSwitchTo={props.controlSwitchTo ?? null}
                onRequestSwitchToRemote={props.onRequestSwitchToRemote}
                directControlFooter={props.directControlFooter}
                approvalRequests={props.approvalRequests}
                interaction={interaction}
                jumpToSeq={props.jumpToSeq ?? null}
                followBottomIntentKey={props.followBottomIntentKey ?? null}
                onJumpLanded={props.onJumpLanded}
                onViewportChange={props.onViewportChange}
                onEditPendingMessage={props.onEditPendingMessage}
                isWarmKeepAliveInstance={props.isWarmKeepAliveInstance === true}
                routeHydrationPending={props.routeHydrationPending === true}
                forkCommon={transcriptSessionCommon.fork}
                messageDisplayCommon={transcriptSessionCommon.messageDisplay}
                toolChromeCommon={transcriptSessionCommon.toolChrome}
                    toolRouteCommon={transcriptSessionCommon.toolRoute}
                />
            </SyncPerformanceReactProfiler>
        </TranscriptMessageSelectionBoundary>
    );
}, areChatListPropsEqual);

const ListHeader = React.memo(() => {
    return (
        <View>
            <View style={{ height: TRANSCRIPT_TOP_GUTTER_PX }} />
        </View>
    );
});

const ListFooter = React.memo((props: {
    sessionId: string;
    bottomNotice?: ChatListBottomNotice | null;
    controlledByUserOverride?: boolean;
    controlSwitchTo?: 'remote' | null;
    onRequestSwitchToRemote?: () => void;
    directControl?: ChatFooterDirectControlState;
}) => {
    const footerState = useSessionChatFooterState(props.sessionId);
    if (!footerState) {
        return null;
    }
    return (
        <ChatFooter
            controlledByUser={props.controlledByUserOverride ?? footerState.controlledByUser}
            localControl={footerState.localControl}
            permissionsInUiWhileLocal={footerState.permissionsInUiWhileLocal}
            notice={props.bottomNotice ?? null}
            controlSwitchTo={props.controlSwitchTo ?? null}
            onRequestSwitchToRemote={props.onRequestSwitchToRemote}
            directControl={props.directControl ?? null}
        />
    )
});

const ChatListFooterWithKeyboardInset = React.memo((props: {
    sessionId: string;
    bottomNotice?: ChatListBottomNotice | null;
    controlledByUserOverride?: boolean;
    controlSwitchTo?: 'remote' | null;
    onRequestSwitchToRemote?: () => void;
    directControl?: ChatFooterDirectControlState;
    onComposerInsetHeightChange?: (height: number) => void;
}) => {
    return (
        <View>
            <ListFooter
                sessionId={props.sessionId}
                bottomNotice={props.bottomNotice}
                controlledByUserOverride={props.controlledByUserOverride}
                controlSwitchTo={props.controlSwitchTo ?? null}
                onRequestSwitchToRemote={props.onRequestSwitchToRemote}
                directControl={props.directControl ?? null}
            />
            <ComposerKeyboardScrollInset
                testID="transcript-composer-keyboard-inset"
                onHeightChange={props.onComposerInsetHeightChange}
            />
        </View>
    );
});

/**
 * C1: a structural (shrink-capable) signature delta warrants resetting the per-item floor and is the
 * only thing that may drive a whole-list invalidation. A pure streaming append (rowState stays
 * streaming, only the content revision grew) is NOT structural — the per-row onLayout channel absorbs
 * growth. This generalizes (and replaces) the old streaming-specific suppression band-aid.
 */
const ChatListInternal = React.memo((props: {
    metadata: Metadata | null,
    sessionId: string,
    sessionActive: boolean,
    sessionThinking: boolean,
    groupingMode: string,
    forkedTranscriptEnabled: boolean,
    items: ChatTranscriptListItem[],
    maxTurnEntriesPerListItem: number,
    transcriptNavigationEntries: readonly TranscriptNavigationEntry[],
    messagePins: readonly PersistedSessionMessagePinV1[],
    onToggleMessagePin: (pin: PersistedSessionMessagePinV1) => void,
    messagesById: Readonly<Record<string, Message>>,
    forkMessageMetadataById: Readonly<Record<string, { originSessionId: string; isReadOnlyContext: boolean }>> | null,
    committedMessagesCount: number,
    latestCommittedActivityKey: string | null,
    activeThinkingMessageId: string | null,
    rollbackRanges: readonly SessionRollbackRangeV1[],
    rollbackActionsByMessageId: Readonly<Record<string, TranscriptRollbackAction>>,
    isLoaded: boolean,
    bottomNotice?: ChatListBottomNotice | null,
    controlledByUserOverride?: boolean;
    controlSwitchTo?: 'remote' | null;
    onRequestSwitchToRemote?: () => void,
    directControlFooter?: ChatFooterDirectControlState;
    approvalRequests?: readonly OpenApprovalArtifactForSession[];
    interaction: TranscriptInteraction;
    jumpToSeq?: number | null;
    followBottomIntentKey?: string | number | null;
    onJumpLanded?: (result: Extract<TranscriptJumpResult, { status: 'scrolled' | 'window-rendered' }>) => void;
    onViewportChange?: (state: TranscriptViewportChangeState) => void;
    onEditPendingMessage?: (request: PendingMessageEditRequest) => void | Promise<void>;
    isWarmKeepAliveInstance?: boolean;
    routeHydrationPending?: boolean;
} & TranscriptSessionCommonProps) => {
    const transcriptMessageSelection = useOptionalTranscriptSelectionState();
    const transcriptContentMaxWidth = useLayoutMaxWidth();
    const [isLoadingOlder, setIsLoadingOlder] = React.useState(false);
    const [nativePrependTransactionRevision, bumpNativePrependTransactionRevision] = React.useReducer(
        (value: number) => value + 1,
        0,
    );
    const [hasMoreOlder, setHasMoreOlder] = React.useState<boolean | null>(null);
    const [listLayoutHeight, setListLayoutHeight] = React.useState(0);
    const [listLayoutWidthPx, setListLayoutWidthPx] = React.useState(() => {
        const width = Dimensions.get('window')?.width;
        return typeof width === 'number' && Number.isFinite(width) && width > 0 ? Math.round(width) : 0;
    });
    const [listLayoutWidthBucket, setListLayoutWidthBucket] = React.useState(resolveInitialTranscriptRowWidthBucket);
    const [listContentHeight, setListContentHeight] = React.useState(0);
    const [webMarkdownRuntimeReady, setWebMarkdownRuntimeReady] = React.useState(isEnrichedMarkdownRuntimePreloaded);
    const [nativeMountSettleStable, setNativeMountSettleStable] = React.useState(false);
    const [nativeMountSettleDeadlineReached, setNativeMountSettleDeadlineReached] = React.useState(false);
    const [nativeInitialViewportPendingObservation, setNativeInitialViewportPendingObservation] = React.useState(false);
    const nativeMountSettleDeadlineReachedRef = React.useRef(false);
    const nativeMountSettleAutoPinSuppressedRef = React.useRef(false);
    const loadOlderInFlight = React.useRef(false);
    const hasMoreOlderRef = React.useRef<boolean | null>(null);
    const olderLoadSpinnerDelayTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const nativeFirstPaintFallbackReleaseTimeoutRef = React.useRef<{
        sessionId: string;
        timeoutId: ReturnType<typeof setTimeout>;
    } | null>(null);
    const sessionOpenWebInitialPinRetryTimeoutRef = React.useRef<{
        deadlineAtMs: number;
        retryIndex: number;
        sessionId: string;
        timeoutId: ReturnType<typeof setTimeout>;
    } | null>(null);
    const sessionOpenWebInitialPinRetryArmAtMsRef = React.useRef(Date.now());
    const scheduleFirstSessionOpenWebInitialPinRetryRef = React.useRef<(() => void) | null>(null);
    const nativeEntryRestorePaintReleaseTimeoutRef = React.useRef<{
        issuedAtMs: number;
        sessionId: string;
        timeoutId: ReturnType<typeof setTimeout>;
    } | null>(null);
    const listRef = React.useRef<ScrollableChatListRef | null>(null);
    const pendingJumpSeqViewportPromotionRef = React.useRef<PendingJumpSeqViewportPromotion | null>(null);
    const promotedJumpSeqViewportProtectionRef = React.useRef<PromotedJumpSeqViewportProtection | null>(null);
    const lastRouteJumpProtectionClearingWebMovementAtMsRef = React.useRef(Number.NEGATIVE_INFINITY);
    const flushPendingJumpSeqViewportPromotionForExitRef = React.useRef<() => void>(() => {});
    const flushViewportAnchorCaptureRef = React.useRef<(options?: Readonly<{ deferEmit?: boolean }>) => void>(() => {});
    const flushExitLiveTailIntentRef = React.useRef<(options?: Readonly<{ deferEmit?: boolean }>) => void>(() => {});
    // Render-safe handle for session-exit/unmount disposal of an open entry-restore
    // transaction (mirror of invalidateNativePrependOwnerRef): the lifecycle fn is
    // defined after the command seam in source order.
    const disposeEntryRestoreTransactionForExitRef = React.useRef<() => void>(() => {});
    const currentSessionIdRef = React.useRef(props.sessionId);
    if (currentSessionIdRef.current !== props.sessionId) {
        flushPendingJumpSeqViewportPromotionForExitRef.current();
        pendingJumpSeqViewportPromotionRef.current = null;
        promotedJumpSeqViewportProtectionRef.current = null;
        lastRouteJumpProtectionClearingWebMovementAtMsRef.current = Number.NEGATIVE_INFINITY;
        // Session exit (plan A3): capture the debounced anchor synchronously while the previous
        // session's list/data refs are still mounted and the current-session ref still points at
        // the exiting session; the emit itself is deferred off the render phase.
        flushViewportAnchorCaptureRef.current({ deferEmit: true });
        // Session exit (plan P3): if the viewport visibly sits at the bottom, persist live-tail
        // intent deterministically — the B8 arrival emission may not have fired (passive
        // arrival / swallowed momentum frames). Runs AFTER the anchor flush so the live-tail
        // report is the final persisted state for the exiting session.
        flushExitLiveTailIntentRef.current({ deferEmit: true });
    }
    currentSessionIdRef.current = props.sessionId;
    const viewportCommandControllerRef = React.useRef<TranscriptViewportCommandController | null>(null);
    if (viewportCommandControllerRef.current === null) {
        viewportCommandControllerRef.current = createTranscriptViewportCommandController();
    }
    const viewportCommandController = viewportCommandControllerRef.current;
    viewportCommandController.setCurrentSessionId(props.sessionId);
    const viewportLifecycleRef = React.useRef<TranscriptViewportLifecycle | null>(null);
    if (viewportLifecycleRef.current === null) {
        viewportLifecycleRef.current = createTranscriptViewportLifecycle();
    }
    const viewportLifecycle = viewportLifecycleRef.current;
    const viewportLifecycleHostRef = React.useRef<TranscriptLifecycleHost | null>(null);
    if (viewportLifecycleHostRef.current === null) {
        viewportLifecycleHostRef.current = createTranscriptLifecycleHost({
            lifecycle: viewportLifecycle,
            mountSettleTuning: resolveTranscriptMountSettleTuning(),
        });
    }
    const lifecycleHost = viewportLifecycleHostRef.current;
    const entryRestoreOwnerRef = React.useRef<EntryRestoreOwner | null>(null);
    if (entryRestoreOwnerRef.current === null) {
        entryRestoreOwnerRef.current = createEntryRestoreOwner();
    }
    const entryRestoreOwner = entryRestoreOwnerRef.current;
    const applyEntryRestoreOwnerEffectsRef = React.useRef<(effects: readonly EntryRestoreOwnerEffect[]) => void>(() => {});
    const sessionOpenLatchRef = React.useRef<SessionOpenLatch | null>(null);
    if (sessionOpenLatchRef.current === null) {
        sessionOpenLatchRef.current = createSessionOpenLatch();
    }
    const sessionOpenLatch = sessionOpenLatchRef.current;
    const applySessionOpenLatchEffectsRef = React.useRef<(effects: readonly SessionOpenLatchEffect[]) => void>(() => {});
    const usesNativeFlashListBottomMaintenance =
        Platform.OS !== 'web';
    const nativePrependOwnerRef = React.useRef<NativePrependOwner | null>(null);
    if (nativePrependOwnerRef.current === null) {
        nativePrependOwnerRef.current = createNativePrependOwner();
    }
    const nativePrependOwner = nativePrependOwnerRef.current;
    const applyNativePrependOwnerEffectsRef = React.useRef<(effects: readonly NativePrependOwnerEffect[]) => void>(() => {});
    const webPrependOwnerRef = React.useRef<WebPrependOwner | null>(null);
    if (webPrependOwnerRef.current === null) {
        webPrependOwnerRef.current = createWebPrependOwner();
    }
    const webPrependOwner = webPrependOwnerRef.current;
    const applyWebPrependOwnerEffectsRef = React.useRef<(effects: readonly WebPrependOwnerEffect[]) => void>(() => {});
    React.useLayoutEffect(() => {
        viewportCommandController.setActive(true);
        return () => {
            viewportCommandController.setActive(false);
        };
    }, [viewportCommandController]);
    const closeViewportOwnershipTransaction = React.useCallback((
        owner: 'entry' | 'prepend',
        outcome: TranscriptViewportTransactionOutcome,
    ) => {
        if (viewportCommandController.activeOwner() !== owner) return;
        viewportCommandController.closeTransaction(owner, outcome);
    }, [viewportCommandController]);
    const closeEntryViewportOwnership = React.useCallback((outcome: TranscriptViewportTransactionOutcome) => {
        closeViewportOwnershipTransaction('entry', outcome);
    }, [closeViewportOwnershipTransaction]);
    /**
     * Trusted user takeover during entry (plan A2: touch-escape semantics). Closes the
     * entry-restore transaction as preempted when one is open; when none was created yet,
     * suppresses this entry permanently and releases the entry ownership phase.
     */
    const preemptEntryRestoreTransaction = React.useCallback(() => {
        applyEntryRestoreOwnerEffectsRef.current(entryRestoreOwner.preempt({
            reason: 'trusted-scroll',
            sessionId: props.sessionId,
        }));
    }, [entryRestoreOwner, props.sessionId]);
    const itemsRef = React.useRef<readonly ChatTranscriptListItem[]>(props.items);
    const listDataRef = React.useRef<readonly ChatTranscriptListItem[]>(props.items);
    const canonicalWindowedItemsRef = React.useRef<readonly ChatTranscriptListItem[]>(props.items);
    const renderWindowIndexMapRef = React.useRef<TranscriptRenderWindowProjection<ChatTranscriptListItem>['indexMap'] | null>(null);
    const nativeHotEdgeVisibleRowsRef = React.useRef<{
        firstItemId: string | null;
        firstSourceIndex: number | null;
        lastItemId: string | null;
        lastSourceIndex: number | null;
    } | null>(null);
    // Pre-decomposition source (turn / tool-calls-group shapes) for visitors that must
    // not see per-unit rows (auto-expand policy scan).
    const preDecompositionItemsRef = React.useRef<ChatTranscriptListItem[]>(props.items);
    const toolRouteCommonRef = React.useRef(props.toolRouteCommon);
    toolRouteCommonRef.current = props.toolRouteCommon;
    const lastJumpSeqRef = React.useRef<number | null>(null);
    const inFlightJumpSeqRef = React.useRef<number | null>(null);
    const listLayoutHeightRef = React.useRef<number>(0);
    const listLayoutWidthPxRef = React.useRef<number>(listLayoutWidthPx);
    const listLayoutWidthBucketRef = React.useRef<string>(listLayoutWidthBucket);
    const listContentHeightRef = React.useRef<number>(0);
    const measurementHost = React.useMemo(
        () => createTranscriptMeasurementHost(),
        [],
    );
    const measurementReconciler = measurementHost.reconciler;
    const recordListLayoutWidth = React.useCallback((width: unknown) => {
        if (typeof width !== 'number' || !Number.isFinite(width)) return;
        if (width > 0) {
            const nextWidthPx = Math.round(width);
            if (listLayoutWidthPxRef.current !== nextWidthPx) {
                listLayoutWidthPxRef.current = nextWidthPx;
                setListLayoutWidthPx(nextWidthPx);
            }
        }
        const nextBucket = resolveTranscriptRowWidthBucket(width);
        if (listLayoutWidthBucketRef.current === nextBucket) return;
        listLayoutWidthBucketRef.current = nextBucket;
        setListLayoutWidthBucket(nextBucket);
    }, []);
    const initialFillAbortRef = React.useRef<AbortController | null>(null);
    const requestSessionOpenInitialFillRef = React.useRef<() => void>(() => {});
    const chatListReactId = React.useId();
    const chatListNativeId = React.useMemo(() => buildChatListNativeId(props.sessionId, chatListReactId), [props.sessionId, chatListReactId]);
    const webScrollContainerRef = React.useRef<HTMLElement | null>(null);
    const transcriptNavigationRuntimeAnchorsRef = React.useRef<readonly TranscriptNavigationRuntimeAnchor[]>([]);
    const webHotColdCountsRef = React.useRef<{ coldCount: number; hotCount: number }>({
        coldCount: props.items.length,
        hotCount: 0,
    });
    const olderPaginationSnapshotRef = React.useRef<TranscriptOlderPaginationSnapshot>({
        phase: 'idle',
        suspendedReasons: [],
        hasMore: true,
        insideThreshold: false,
    });
    const nativePrependLayoutTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const nativePrependQuietReobserveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const nativePrependCorrectorReobserveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const observeNativePrependOwnerRef = React.useRef<() => void>(() => {});
    const invalidateNativePrependOwnerRef = React.useRef<() => void>(() => {});
    // Plan P2: lets the momentum-settle handler (defined before the scheduler) arm a capture
    // for the dwelled position when every momentum frame was swallowed (open transactions).
    const scheduleViewportAnchorCaptureRef = React.useRef<(
        state: TranscriptViewportChangeState,
        options?: Readonly<{ suppressAnchorCapture?: boolean }>,
    ) => void>(() => {});
    const resetOlderPaginationRef = React.useRef<() => void>(() => {});
    const webPrependIndexRecoveryScheduleRef = React.useRef<{ kind: 'raf' | 'timeout'; ids: any[] } | null>(null);
    const webPrependIndexRecoveryRunningRef = React.useRef(false);
    const webPrependRestoreExpiryTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const runWebPrependIndexRecoveryRef = React.useRef<() => boolean>(() => false);
    const [webPrependRangeReservePx, setWebPrependRangeReservePx] = React.useState(0);
    const clearWebPrependRangeReserve = React.useCallback(() => {
        setWebPrependRangeReservePx((previous) => previous === 0 ? previous : 0);
    }, [lifecycleHost]);
    const cancelWebPrependRestoreWindowExpiry = React.useCallback(() => {
        const timeoutId = webPrependRestoreExpiryTimerRef.current;
        if (timeoutId === null) return;
        webPrependRestoreExpiryTimerRef.current = null;
        clearTimeout(timeoutId);
    }, []);
    const cancelScheduledWebPrependIndexRecovery = React.useCallback(() => {
        const scheduledRecovery = webPrependIndexRecoveryScheduleRef.current;
        if (!scheduledRecovery) return;
        webPrependIndexRecoveryScheduleRef.current = null;
        if (scheduledRecovery.kind === 'raf') {
            for (const id of scheduledRecovery.ids) {
                cancelAnimationFrame(id);
            }
            return;
        }
        for (const id of scheduledRecovery.ids) {
            clearTimeout(id);
        }
    }, []);
    const closeWebPrependViewportOwnership = React.useCallback((
        outcome: TranscriptViewportTransactionOutcome,
    ) => {
        if (Platform.OS !== 'web') return;
        if (viewportCommandController.activeOwner() !== 'prepend') return;
        viewportCommandController.closeTransaction('prepend', outcome);
    }, [viewportCommandController]);
    const clearWebPrependRestoreWindow = React.useCallback((
        outcome: TranscriptViewportTransactionOutcome,
    ) => {
        applyWebPrependOwnerEffectsRef.current(webPrependOwner.clear({
            outcome,
            sessionId: props.sessionId,
        }));
    }, [props.sessionId, webPrependOwner]);
    const wantsPinnedRef = React.useRef(true);
    const pinThresholdPxRef = React.useRef(72);
    const lastUserScrollIntentAtMsRef = React.useRef(Number.NEGATIVE_INFINITY);
    const lastExplicitWebScrollIntentAtMsRef = React.useRef(Number.NEGATIVE_INFINITY);
    const nativeTranscriptTouchStartYRef = React.useRef<number | null>(null);
    const resolveRestoreAnchorIndexForCommandRef = React.useRef<(anchor: TranscriptViewportAnchorIdentity) => number | null>(() => null);
    const resolveJumpToSeqIndexForCommandRef = React.useRef<(
        seq: number,
        routeMessageId?: string | null,
        transcriptBlockIndex?: number | null,
        role?: TranscriptJumpTargetRole | null,
    ) => number | null>(() => null);
    const webDomObservationRef = React.useRef<WebDomScrollObservation | null>(null);
    if (webDomObservationRef.current === null) {
        webDomObservationRef.current = createWebDomScrollObservation();
    }
    const webDomObservation = webDomObservationRef.current;
    const applyWebPassiveLiveTailCorrectionEffectRef = React.useRef<(
        effect: WebPassiveLiveTailCorrectionEffect,
    ) => boolean>(() => false);
    const lastAutoRepinAtMsRef = React.useRef(Number.NEGATIVE_INFINITY);
    const lastPinOffsetForIntentRef = React.useRef<number | null>(null);
    const lastScrollOffsetForIntentRef = React.useRef<number | null>(null);
    const bottomFollowModeStateRef = React.useRef<TranscriptBottomFollowModeState>({
        dragSession: null,
        mode: resolveSessionEntryViewportState(readSessionViewportForEntry(props.sessionId)).bottomFollowMode,
    });
    const [bottomFollowModeRevision, bumpBottomFollowModeRevision] = React.useReducer((value: number) => (value + 1) % 1_000_000, 0);
    const commitBottomFollowModeState = React.useCallback((next: TranscriptBottomFollowModeState) => {
        const previous = bottomFollowModeStateRef.current;
        bottomFollowModeStateRef.current = next;
        if (previous.mode !== next.mode) {
            bumpBottomFollowModeRevision();
        }
    }, []);

    const dispatchViewportLifecycleEvent = React.useCallback((event: TranscriptViewportLifecycleEvent) => {
        const transition = viewportLifecycle.dispatch(event);
        commitBottomFollowModeState(transition.state.bottomFollowState);
        return transition;
    }, [commitBottomFollowModeState, viewportLifecycle]);
    const lastNativePinOffsetRef = React.useRef<number | null>(null);
    const lastNativeBottomFollowPinCommandRef = React.useRef<{
        sessionId: string;
        offsetY: number;
        writtenAtMs: number;
    } | null>(null);
    const lastNativeRestoreIndexCommandRef = React.useRef<LastNativeRestoreIndexCommand | null>(null);
    const nativeAutomaticBottomPinCommandSessionRef = React.useRef<string | null>(null);
    const nativeContentMaterializationAutoPinRef = React.useRef<NativeContentMaterializationAutoPin | null>(null);
    // Single stream writer (plan B3): at most one follow command per measured content version.
    const lastNativeStreamAppendPinRef = React.useRef<NativeStreamAppendPinContentVersion | null>(null);
    const nativeListDragActiveRef = React.useRef(false);
    const nativeBottomFollowRearmedAfterDragRef = React.useRef(false);
    // Plan B9: true between onMomentumScrollBegin and onMomentumScrollEnd. Combined with the
    // mode machine's retained trusted drag session it forms the post-drag release attribution
    // window: momentum frames may release follow, height-churn frames without a drag never can.
    const nativeMomentumScrollActiveRef = React.useRef(false);
    const nativeVisibleWindowSnapshotRef = React.useRef<NativeVisibleWindowSnapshot | null>(null);
    const lastNativeVisibleRowsSnapshotRef = React.useRef<NativeVisibleWindowSnapshot | null>(null);
    const nativeFlashListMvcpPolicyRef = React.useRef<TranscriptViewportTelemetryMvcpPolicy>('none');
    const nativeFlashListPauseOffsetCorrectionRef = React.useRef(false);
    const lastProactiveAutoFollowActivityKeyRef = React.useRef<string | null>(props.latestCommittedActivityKey);
    const pendingNativeMountSettleBottomPinRef = React.useRef(false);
    const flushPendingNativeMountSettleBottomPinRef = React.useRef<(() => void) | null>(null);
    const nativeInitialViewportPendingObservationRef = React.useRef(false);
    // Entry-restore owner state lives in viewport/entryRestore; ChatList applies its effects.
    // N2b.2 slice-from-anchor entry window (native flash_v2 anchored entries).
    const [entrySliceWindow, setEntrySliceWindow] = React.useState<{
        sessionId: string;
        anchorRowId: string;
    } | null>(null);
    const entrySliceWindowRef = React.useRef<{ sessionId: string; anchorRowId: string } | null>(null);
    const entrySliceWithheldCountRef = React.useRef(0);
    const revealEntrySliceWindowRef = React.useRef<() => number>(() => 0);
    const entryRestoreDeadlineTimeoutRef = React.useRef<{
        sessionId: string;
        timeoutId: ReturnType<typeof setTimeout>;
    } | null>(null);
    const composerInsetHeightRef = React.useRef(0);
    // Render-visible mirror of `composerInsetHeightRef` (the single source of truth). Bottom-anchored
    // overlays that live OUTSIDE the scroll geometry (e.g. the catch-up overlay) must re-position when
    // the composer inset changes, which a ref alone cannot drive. Committed from
    // `handleComposerInsetHeightChange` so it stays in lockstep with the ref.
    const [composerInsetHeight, setComposerInsetHeight] = React.useState(0);
    // Rendered height of the native hot-tail block (live-tail rows carved into the inverted
    // visual-bottom edge slot). Folded into the inverted bottom command's viewOffset so the
    // live tail lands fully above the composer. 0 when the native split is OFF/empty.
    const nativeHotTailHeightRef = React.useRef(0);
    // §12 #4: live-region carve context for per-pin telemetry (anchor id+kind, hot/cold counts,
    // whether the carve owns the bottom). Updated each render; read by the scroll-write executor
    // and the height-driven pin so they never re-derive it inside scroll callbacks.
    const liveTailCarveTelemetryRef = React.useRef<{
        active: boolean;
        anchorId: string | null;
        anchorKind: TranscriptLiveTailAnchorReason | null;
        coldCount: number;
        hotCount: number;
    }>({ active: false, anchorId: null, anchorKind: null, coldCount: 0, hotCount: 0 });
    // §12 #2: stable bridge to the latest height-driven live-tail pin (assigned after the pin
    // helpers exist). Keeps `handleNativeHotTailHeightChange` identity-stable while still calling
    // the freshest pin logic — height + pin become ONE event, killing the async-ref overlap race.
    const pinNativeLiveTailForHotTailHeightRef = React.useRef<((height: number) => void) | null>(null);
    // §12 #4: carve fields for an issued inverted bottom pin (the deterministic inset = composerInset
    // + hot-tail height, the anchor that opened the carve, hot/cold counts). Empty when the carve is
    // OFF so non-carve / flag=0 pins stay byte-for-byte unchanged.
    const resolveInvertedBottomPinCarveTelemetryFields = React.useCallback((): Record<string, unknown> => {
        const carve = liveTailCarveTelemetryRef.current;
        if (!carve.active) return {};
        return {
            liveRegionActive: true,
            nativeHotTailHeightPx: nativeHotTailHeightRef.current,
            nativeCarvePinIssued: true,
            ...(carve.anchorId ? { liveTailAnchorId: carve.anchorId } : {}),
            ...(carve.anchorKind ? { liveTailAnchorKind: carve.anchorKind } : {}),
            coldCount: carve.coldCount,
            hotCount: carve.hotCount,
        };
    }, []);
    const scheduledPinRef = React.useRef<ScheduledPinToBottom | null>(null);
    const bottomFollowWriteSchedulerStateRef = React.useRef<BottomFollowWriteSchedulerState<WebTranscriptScrollMetrics>>({
        explicitJumpActive: false,
        gestureActive: false,
        pending: null,
    });
    const blankRecoveryStateRef = React.useRef(createTranscriptBlankRecoveryState());
    const scheduleBottomFollowWriteTimerRef = React.useRef<((write: BottomFollowScheduledWrite<WebTranscriptScrollMetrics>) => void) | null>(null);
    const applyBottomFollowWriteSchedulerEffectsRef = React.useRef<((effects: readonly BottomFollowWriteSchedulerEffect<WebTranscriptScrollMetrics>[]) => void) | null>(null);
    const authorizeImmediateBottomFollowWriteRef = React.useRef<(
        (writer: BottomFollowAutomaticWriter, reason: TranscriptViewportTelemetryScrollReason) => boolean
    )>(() => false);
    const requestBottomFollowScheduledWriteRef = React.useRef<(previousWebMetrics?: WebTranscriptScrollMetrics | null, reason?: TranscriptViewportTelemetryScrollReason, nativePrevFollowAtBottom?: boolean, writer?: BottomFollowAutomaticWriter) => void>(() => {});
    const latestJumpToSeqRef = React.useRef<number | null>(props.jumpToSeq ?? null);
    latestJumpToSeqRef.current = props.jumpToSeq ?? null;
    const initialWebPinStabilizingRef = React.useRef(false);
    const scheduledViewportAnchorCaptureRef = React.useRef<{
        captureAnchor: () => SessionViewportAnchorSnapshot | null;
        dueAtMs: number;
        emit: ((state: TranscriptViewportChangeState) => void) | undefined;
        generation: number;
        sessionId: string;
        state: TranscriptViewportChangeState;
        timeoutId: ReturnType<typeof setTimeout>;
        wantsPinned: boolean;
    } | null>(null);
    const viewportAnchorCaptureGenerationRef = React.useRef(0);
    const attemptEntryRestoreRef = React.useRef<() => void>(() => {});
    const anchorLookupLoadCountRef = React.useRef(0);
    const anchorLookupInFlightRef = React.useRef(false);
    const anchorLookupExhaustedRef = React.useRef(false);
    const loadOlderForAnchorLookupRef = React.useRef<((options?: LoadOlderOptions) => Promise<{
        loaded: number;
        hasMore: boolean;
        status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight';
    } | null>) | null>(null);
    const requestBoundedEntryViewportMaterializationRef = React.useRef<() => boolean>(() => false);

    const transcriptMotionPreset = useSetting('transcriptMotionPreset');
    const transcriptMotionFreshnessMs = useSetting('transcriptMotionFreshnessMs');
    const transcriptAnimateNewItemsEnabled = useSetting('transcriptAnimateNewItemsEnabled');
    const transcriptAnimateToolExpandCollapseEnabled = useSetting('transcriptAnimateToolExpandCollapseEnabled');
    const transcriptAnimateToolExpandCollapseFreshOnly = useSetting('transcriptAnimateToolExpandCollapseFreshOnly');
    const transcriptAnimateThinkingEnabled = useSetting('transcriptAnimateThinkingEnabled');
    const reducedMotionPreferred = useReducedMotionPreference();
    const sessionThinkingDisplayMode = useSetting('sessionThinkingDisplayMode');
    const sessionThinkingInlinePresentation = useSetting('sessionThinkingInlinePresentation');
    const sessionThinkingInlineChrome = useSetting('sessionThinkingInlineChrome');

    const updateNativeInitialViewportPendingObservation = React.useCallback((pending: boolean) => {
        if (Platform.OS === 'web') return;
        if (nativeInitialViewportPendingObservationRef.current === pending) return;
        nativeInitialViewportPendingObservationRef.current = pending;
        setNativeInitialViewportPendingObservation(pending);
    }, []);

    const applyNativeUserScrollTakeoverHostEffects = React.useCallback((
        effects: readonly NativeUserScrollTakeoverApplyEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== props.sessionId) continue;
            switch (effect.type) {
                case 'native-user-scroll-preempt-entry-restore':
                    preemptEntryRestoreTransaction();
                    break;
                case 'native-user-scroll-cancel-native-mount-settle-bottom-pin':
                    pendingNativeMountSettleBottomPinRef.current = false;
                    break;
                case 'native-user-scroll-suppress-native-mount-settle-auto-pin':
                    nativeMountSettleAutoPinSuppressedRef.current = true;
                    break;
                case 'native-user-scroll-clear-native-initial-viewport-pending-observation':
                    updateNativeInitialViewportPendingObservation(false);
                    break;
                case 'native-user-scroll-record-intent-timestamp':
                    lastUserScrollIntentAtMsRef.current = effect.timestampMs;
                    break;
            }
        }
    }, [
        preemptEntryRestoreTransaction,
        props.sessionId,
        updateNativeInitialViewportPendingObservation,
    ]);

    const recordNativeUserScrollIntent = React.useCallback((nowMs: number = Date.now()) => {
        if (Platform.OS === 'web') return;
        const plan = lifecycleHost.planNativeUserScrollTakeover({
            sessionId: props.sessionId,
            timestampMs: nowMs,
        });
        applyNativeUserScrollTakeoverHostEffects(plan.nativeUserScrollTakeoverEffects);
    }, [
        applyNativeUserScrollTakeoverHostEffects,
        lifecycleHost,
        props.sessionId,
    ]);

    const resetNativeSessionViewportLifecycle = React.useCallback((sessionId: string) => {
        if (Platform.OS === 'web') return;
        sessionOpenLatch.resetNativeInitialViewport(sessionId);
        updateNativeInitialViewportPendingObservation(false);
    }, [sessionOpenLatch, updateNativeInitialViewportPendingObservation]);

    const hasNativeContentMeasurementForCurrentSession = React.useCallback((): boolean => {
        return measurementHost.hasNativeContentMeasurementForSession({
            platform: Platform.OS === 'web' ? 'web' : 'native',
            sessionId: props.sessionId,
        });
    }, [measurementHost, props.sessionId]);

    const hasNativeInitialViewportAppliedForCurrentSession = React.useCallback((): boolean => {
        if (Platform.OS === 'web') return true;
        return sessionOpenLatch.hasNativeInitialViewportApplied(props.sessionId);
    }, [props.sessionId, sessionOpenLatch]);

    const markNativeInitialViewportAppliedForCurrentSession = React.useCallback((options?: Readonly<{
        entrySettleBaselineContentHeight?: number;
    }>) => {
        if (Platform.OS === 'web') return;
        const { wasApplied } = sessionOpenLatch.markNativeInitialViewportApplied(props.sessionId);
        updateNativeInitialViewportPendingObservation(false);
        if (!wasApplied && sessionEntryViewportRef.current?.shouldFollowBottom !== false) {
            lifecycleHost.armNativeEntrySettleConfirmation({
                baselineContentHeight: options?.entrySettleBaselineContentHeight,
                sessionId: props.sessionId,
            });
        }
        if (!entryRestoreOwner.hasOpenTransaction(props.sessionId)) {
            // Cold-open entry phase (no entry-restore transaction): applied = confirmed.
            // Restore entries close their phase through the entry restore owner.
            closeEntryViewportOwnership('confirmed');
        }
    }, [
        closeEntryViewportOwnership,
        entryRestoreOwner,
        lifecycleHost,
        props.sessionId,
        sessionOpenLatch,
        updateNativeInitialViewportPendingObservation,
    ]);

    const applyNativeBottomFollowCompletionHostEffects = React.useCallback((
        effects: TranscriptLifecycleHostScrollObservationPlan['nativeBottomFollowCompletionEffects'],
    ) => {
        for (const effect of effects) {
            if (
                effect.type !== 'complete-native-bottom-follow' ||
                effect.sessionId !== props.sessionId
            ) {
                continue;
            }
            pendingNativeMountSettleBottomPinRef.current = false;
            markNativeInitialViewportAppliedForCurrentSession({
                // Plan P3: the applying frame's event content height is
                // the settle-confirm baseline (event source only, E7).
                entrySettleBaselineContentHeight: effect.entrySettleBaselineContentHeight,
            });
        }
    }, [
        markNativeInitialViewportAppliedForCurrentSession,
        props.sessionId,
    ]);

    const shouldIgnoreNativeInvalidScrollObservation = React.useCallback((
        offsetY: number,
        distanceFromBottom: number,
    ): boolean => {
        return resolveShouldIgnoreNativeInvalidScrollObservation({
            distanceFromBottom,
            isWeb: Platform.OS === 'web',
            offsetY,
        });
    }, []);

    const resolveWebScrollMetrics = React.useCallback(() => {
        if (Platform.OS !== 'web') return null;
        if (typeof document === 'undefined') return null;
        if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return null;

        const root = (document as any)?.getElementById?.(chatListNativeId) as HTMLElement | null | undefined;
        const metrics = resolveWebTranscriptScrollMetrics({
            root,
            cachedElement: webScrollContainerRef.current,
            win: window,
            minOverflowPx: 50,
            maxDescendants: 1800,
            maxAncestors: 30,
            pick: 'best',
            allowRootFallback: true,
            score: (el) => {
                const sh = (el as any).scrollHeight;
                return typeof sh === 'number' && Number.isFinite(sh) ? sh : 0;
            },
        });
        if (metrics) {
            webScrollContainerRef.current = metrics.element;
        }
        return metrics;
    }, [chatListNativeId]);

    const observeWebTranscriptNavigationVisibilityForSession = React.useCallback((
        metrics: WebTranscriptScrollMetrics,
        scrollIntent: Readonly<{ isTrusted: boolean }> | null,
    ) => {
        if (Platform.OS !== 'web') return;
        scheduleWebTranscriptNavigationVisibilityObservation({
            anchors: transcriptNavigationRuntimeAnchorsRef.current,
            metrics,
            scrollIntent,
            store: getTranscriptNavigationVisibilityStore(props.sessionId),
        });
    }, [lifecycleHost, props.sessionId]);

    const resolveEnabledViewportTelemetryTuning = React.useCallback(() => {
        const tuning = sync.getSyncTuning();
        configureTranscriptViewportTelemetryFromTuning(tuning);
        return transcriptViewportTelemetry.isEnabled() ? tuning : null;
    }, []);

    const resolveWebViewportTelemetryDiagnostics = React.useCallback((params: Readonly<{
        flashListContentHeight?: number;
        flashListLayoutHeight?: number;
        metrics?: WebTranscriptScrollMetrics | null;
        paginationPhase?: TranscriptOlderPaginationSnapshot['phase'];
        paginationSuspendedReasons?: TranscriptOlderPaginationSnapshot['suspendedReasons'];
        programmaticWebWrite: boolean;
        scrollable?: boolean;
        trigger: 'scroll' | 'edge-reached' | 'restore' | 'prepend-restore' | 'jump';
    }>) => {
        if (!resolveEnabledViewportTelemetryTuning()) return {};
        const metrics = params.metrics ?? null;
        const paginationSnapshot = olderPaginationSnapshotRef.current;
        const counts = webHotColdCountsRef.current;
        const webPrependFacts = webPrependOwner.telemetryFacts({ items: itemsRef.current });
        return {
            trigger: params.trigger,
            ...(metrics ? {
                domScrollTop: metrics.scrollTop,
                domScrollHeight: metrics.scrollHeight,
                domClientHeight: metrics.clientHeight,
                firstVisibleAnchorTestId: resolveFirstVisibleWebAnchorTestId({
                    anchors: transcriptNavigationRuntimeAnchorsRef.current,
                    metrics,
                }) ?? 'none',
            } : {
                firstVisibleAnchorTestId: 'none',
            }),
            flashListContentHeight: params.flashListContentHeight ?? listContentHeightRef.current,
            flashListLayoutHeight: params.flashListLayoutHeight ?? listLayoutHeightRef.current,
            scrollable: params.scrollable ?? (metrics ? isWebTranscriptScrollable(metrics, 1) : false),
            paginationPhase: params.paginationPhase ?? paginationSnapshot.phase,
            paginationSuspendedReasons: params.paginationSuspendedReasons ?? paginationSnapshot.suspendedReasons,
            coldCount: counts.coldCount,
            hotCount: counts.hotCount,
            ...webPrependFacts,
            programmaticWebWrite: params.programmaticWebWrite,
        };
    }, [resolveEnabledViewportTelemetryTuning, webPrependOwner]);

    const resolveBackwardPrefetchThresholdPx = React.useCallback((viewportPx: number): number => {
        const tuning = sync.getSyncTuning();
        return resolveTranscriptEdgePrefetchThresholdPx({
            configuredPx: tuning.transcriptBackwardPrefetchThresholdPx,
            viewportPx,
            fallbackViewportRatio: TRANSCRIPT_EDGE_PREFETCH_FALLBACK_VIEWPORT_RATIO,
            minPx: TRANSCRIPT_EDGE_PREFETCH_MIN_PX,
            maxPx: TRANSCRIPT_EDGE_PREFETCH_MAX_PX,
        });
    }, []);

    const waitForNextVisualUpdate = React.useCallback(waitForNextTranscriptVisualUpdate, []);

    const motionConfig = React.useMemo(() => {
        return resolveTranscriptMotionConfig({
            reducedMotionPreferred,
            transcriptMotionPreset,
            transcriptMotionFreshnessMs,
            transcriptAnimateNewItemsEnabled,
            transcriptAnimateToolExpandCollapseEnabled,
            transcriptAnimateToolExpandCollapseFreshOnly,
            transcriptAnimateThinkingEnabled,
        });
    }, [
        reducedMotionPreferred,
        transcriptAnimateNewItemsEnabled,
        transcriptAnimateThinkingEnabled,
        transcriptAnimateToolExpandCollapseEnabled,
        transcriptAnimateToolExpandCollapseFreshOnly,
        transcriptMotionFreshnessMs,
        transcriptMotionPreset,
    ]);

    const transcriptScrollPinEnabled = useSetting('transcriptScrollPinEnabled');
    const transcriptScrollPinOffsetThresholdPx = useSetting('transcriptScrollPinOffsetThresholdPx');
    const transcriptScrollAutoFollowWhenPinned = useSetting('transcriptScrollAutoFollowWhenPinned');
    const transcriptScrollJumpToBottomEnabled = useSetting('transcriptScrollJumpToBottomEnabled');
    const transcriptScrollJumpToBottomMinNewCount = useSetting('transcriptScrollJumpToBottomMinNewCount');
    const transcriptScrollJumpToBottomRevealViewportRatio = useSetting('transcriptScrollJumpToBottomRevealViewportRatio');
    const transcriptScrollJumpToBottomAnimateScroll = useSetting('transcriptScrollJumpToBottomAnimateScroll');
    const transcriptToolCallsCollapsedPreviewCountSetting = useSetting('transcriptToolCallsCollapsedPreviewCount');

    const [scrollPin, setScrollPin] = React.useState<TranscriptScrollPinState>(() => ({
        isPinned: resolveSessionEntryViewportState(readSessionViewportForEntry(props.sessionId)).shouldFollowBottom,
        newActivityCount: 0,
        lastActivityKey: null,
    }));
    const scrollPinRef = React.useRef(scrollPin);
    const commitScrollPinState = React.useCallback((next: TranscriptScrollPinState) => {
        const current = scrollPinRef.current;
        if (
            current === next ||
            (
                current.isPinned === next.isPinned &&
                current.newActivityCount === next.newActivityCount &&
                current.lastActivityKey === next.lastActivityKey
            )
        ) {
            return;
        }
        scrollPinRef.current = next;
        setScrollPin(next);
    }, []);
    const commitScrollPinEvent = React.useCallback((event: TranscriptScrollPinEvent) => {
        const next = resolveTranscriptScrollPinStateUpdate(scrollPinRef.current, event);
        if (!next) return;
        commitScrollPinState(next);
    }, [commitScrollPinState]);
    const [jumpToBottomDistanceFromBottom, setJumpToBottomDistanceFromBottom] = React.useState(0);
    const jumpToBottomDistanceFromBottomRef = React.useRef(0);
    const isPinnedRef = React.useRef(true);
    const resetOlderPaginationForSessionEntry = React.useCallback(() => {
        hasMoreOlderRef.current = null;
        resetOlderPaginationRef.current();
    }, []);
    const applySessionEntryRenderResetEffects = React.useCallback((sessionEntryRenderResetEffects: SessionEntryRenderResetEffects) => {
        webDomObservation.reset();
        lastNativePinOffsetRef.current = null;
        lastNativeBottomFollowPinCommandRef.current = null;
        nativeAutomaticBottomPinCommandSessionRef.current = null;
        nativeBottomFollowRearmedAfterDragRef.current = false;
        nativeMomentumScrollActiveRef.current = false;
        lastNativeStreamAppendPinRef.current = null;
        lastProactiveAutoFollowActivityKeyRef.current = props.latestCommittedActivityKey;
        resetOlderPaginationForSessionEntry();
        if (sessionEntryRenderResetEffects.platform === 'native') {
            resetNativeSessionViewportLifecycle(sessionEntryRenderResetEffects.nativeSessionViewportReset.sessionId);
        }
        disposeEntryRestoreTransactionForExitRef.current();
        applyEntryRestoreOwnerEffectsRef.current(entryRestoreOwner.resetForSession({ sessionId: props.sessionId }));
        entrySliceWindowRef.current = null;
        const entryRestoreDeadlineTimeout = entryRestoreDeadlineTimeoutRef.current;
        if (entryRestoreDeadlineTimeout) {
            entryRestoreDeadlineTimeoutRef.current = null;
            clearTimeout(entryRestoreDeadlineTimeout.timeoutId);
        }
        const nativeEntryRestorePaintReleaseTimeout = nativeEntryRestorePaintReleaseTimeoutRef.current;
        if (nativeEntryRestorePaintReleaseTimeout) {
            nativeEntryRestorePaintReleaseTimeoutRef.current = null;
            clearTimeout(nativeEntryRestorePaintReleaseTimeout.timeoutId);
        }
        invalidateNativePrependOwnerRef.current();
        lifecycleHost.clearNativeExplicitJumpConfirmation({ sessionId: sessionEntryRenderResetEffects.nativeExplicitJumpReset.sessionId });
        lifecycleHost.resetNativeEntrySettleConfirmation({
            sessionId: sessionEntryRenderResetEffects.nativeEntrySettleReset.sessionId,
            shouldArmConfirmation: sessionEntryRenderResetEffects.nativeEntrySettleReset.shouldArmConfirmation,
        });
        lastNativeRestoreIndexCommandRef.current = null;
        anchorLookupLoadCountRef.current = 0;
        anchorLookupInFlightRef.current = false;
        anchorLookupExhaustedRef.current = false;
        viewportCommandController.resetForSession({
            sessionId: props.sessionId,
            openEntryTransaction: sessionEntryRenderResetEffects.commandControllerReset.openEntryTransaction,
        });
        measurementHost.resetForSession({ sessionId: sessionEntryRenderResetEffects.measurementReset.sessionId });
    }, [
        entryRestoreOwner,
        lifecycleHost,
        measurementHost,
        props.latestCommittedActivityKey,
        props.sessionId,
        resetNativeSessionViewportLifecycle,
        resetOlderPaginationForSessionEntry,
        viewportCommandController,
        webDomObservation,
    ]);
    const sessionEntryViewportRef = React.useRef<{
        sessionId: string;
        entryKind: SessionOpenEntryKind;
        shouldFollowBottom: boolean;
        // Finite persisted distance-from-bottom, or null when the stored viewport carried
        // no trustworthy offset (missing or non-finite) — consumers must not treat null as 0
        // where 0 means "at the bottom".
        offsetY: number | null;
        anchor: SessionViewportAnchorSnapshot | null;
        effects: readonly SessionEntryViewportApplyEffect[];
    } | null>(null);
    const [expandedToolCallsAnchorMessageIds, setExpandedToolCallsAnchorMessageIds] = React.useState<ReadonlySet<string>>(
        () => new Set<string>(),
    );
    const thinkingDefaultExpanded =
        sessionThinkingDisplayMode === 'inline' && sessionThinkingInlinePresentation === 'full';
    const [thinkingExpandedByMessageId, setThinkingExpandedByMessageId] = React.useState<ReadonlyMap<string, boolean>>(
        () => new Map<string, boolean>(),
    );

    const clearOlderLoadSpinnerDelay = React.useCallback(() => {
        const timeoutId = olderLoadSpinnerDelayTimeoutRef.current;
        if (!timeoutId) return;
        olderLoadSpinnerDelayTimeoutRef.current = null;
        clearTimeout(timeoutId);
    }, []);

    const hideOlderLoadSpinner = React.useCallback(() => {
        clearOlderLoadSpinnerDelay();
        setIsLoadingOlder(false);
    }, [clearOlderLoadSpinnerDelay]);

    const showOlderLoadSpinner = React.useCallback(() => {
        clearOlderLoadSpinnerDelay();
        setIsLoadingOlder(true);
    }, [clearOlderLoadSpinnerDelay]);

    const applyExplicitJumpTakeoverApplyEffects = React.useCallback((
        effects: readonly ExplicitJumpTakeoverApplyEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== props.sessionId) continue;
            switch (effect.type) {
                case 'explicit-jump-cancel-native-mount-settle-bottom-pin':
                    pendingNativeMountSettleBottomPinRef.current = false;
                    break;
                case 'explicit-jump-suppress-entry-restore':
                    applyEntryRestoreOwnerEffectsRef.current(entryRestoreOwner.preempt({
                        reason: 'jump',
                        sessionId: props.sessionId,
                    }));
                    break;
                case 'explicit-jump-preempt-entry-restore':
                    preemptEntryRestoreTransaction();
                    break;
                case 'explicit-jump-clear-native-entry-restore-paint-release-timeout': {
                    const nativeEntryRestorePaintReleaseTimeout = nativeEntryRestorePaintReleaseTimeoutRef.current;
                    if (nativeEntryRestorePaintReleaseTimeout) {
                        nativeEntryRestorePaintReleaseTimeoutRef.current = null;
                        clearTimeout(nativeEntryRestorePaintReleaseTimeout.timeoutId);
                    }
                    break;
                }
                case 'explicit-jump-invalidate-native-prepend-transaction':
                    invalidateNativePrependOwnerRef.current();
                    break;
                case 'explicit-jump-clear-native-restore-index-command-cache':
                    lastNativeRestoreIndexCommandRef.current = null;
                    break;
                case 'explicit-jump-close-native-prepend-transaction':
                    applyNativePrependOwnerEffectsRef.current(nativePrependOwner.trustedScroll({
                        activeOwner: viewportCommandController.activeOwner(),
                        sessionId: props.sessionId,
                    }));
                    break;
            }
        }
    }, [
        entryRestoreOwner,
        nativePrependOwner,
        preemptEntryRestoreTransaction,
        props.sessionId,
        viewportCommandController,
    ]);
    React.useEffect(() => {
        if (props.jumpToSeq == null) return;
        const plan = lifecycleHost.planExplicitJumpTakeover({
            reason: 'jump-to-seq',
            sessionId: props.sessionId,
        });
        commitBottomFollowModeState(plan.state.bottomFollowState);
        applyExplicitJumpTakeoverApplyEffects(plan.explicitJumpTakeoverEffects);
    }, [
        applyExplicitJumpTakeoverApplyEffects,
        commitBottomFollowModeState,
        lifecycleHost,
        props.jumpToSeq,
        props.sessionId,
    ]);

    const cancelScheduledPinToBottom = React.useCallback(() => {
        pendingNativeMountSettleBottomPinRef.current = false;
        bottomFollowWriteSchedulerStateRef.current = {
            ...bottomFollowWriteSchedulerStateRef.current,
            pending: null,
        };
        const scheduled = scheduledPinRef.current;
        if (!scheduled) return;
        scheduledPinRef.current = null;
        if (scheduled.kind === 'raf') {
            const caf = (globalThis as any)?.cancelAnimationFrame as undefined | ((id: any) => void);
            if (typeof caf === 'function') {
                caf(scheduled.id);
            }
            return;
        }
        clearTimeout(scheduled.id);
    }, []);

    const applyImmediateWebReleaseApplyEffects = React.useCallback((
        effects: readonly WebImmediateReleaseLiveTailApplyEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== props.sessionId) continue;
            wantsPinnedRef.current = false;
        }
    }, [props.sessionId]);

    const applyImmediateWebReleaseLifecycleEffects = React.useCallback((
        effects: readonly TranscriptViewportLifecycleEffect[],
    ) => {
        applyImmediateWebReleaseApplyEffects(resolveWebImmediateReleaseLiveTailApplyEffects({
            effects,
            sessionId: props.sessionId,
        }));
    }, [
        applyImmediateWebReleaseApplyEffects,
        props.sessionId,
    ]);

    const applyNativeMomentumActiveMirrorApplyEffects = React.useCallback((
        effects: readonly NativeMomentumActiveMirrorApplyEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== props.sessionId) continue;
            nativeMomentumScrollActiveRef.current = effect.active;
        }
    }, [props.sessionId]);

    const applyNativeMomentumActiveMirrorLifecycleEffects = React.useCallback((
        effects: readonly TranscriptViewportLifecycleEffect[],
    ) => {
        if (Platform.OS === 'web') return;
        applyNativeMomentumActiveMirrorApplyEffects(resolveNativeMomentumActiveMirrorApplyEffects({
            effects,
            sessionId: props.sessionId,
        }));
    }, [
        applyNativeMomentumActiveMirrorApplyEffects,
        props.sessionId,
    ]);

    const applyNativeDragActiveMirrorApplyEffects = React.useCallback((
        effects: readonly NativeDragActiveMirrorApplyEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== props.sessionId) continue;
            nativeListDragActiveRef.current = effect.active;
            const schedulerPlan = planBottomFollowWriteSchedulerEvent(
                bottomFollowWriteSchedulerStateRef.current,
                {
                    active: effect.active,
                    type: 'set-gesture-active',
                },
            );
            bottomFollowWriteSchedulerStateRef.current = schedulerPlan.state;
            for (const schedulerEffect of schedulerPlan.effects) {
                if (schedulerEffect.type === 'schedule-write') {
                    scheduleBottomFollowWriteTimerRef.current?.(schedulerEffect.write);
                }
            }
        }
    }, [props.sessionId]);

    const applyNativeDragActiveMirrorLifecycleEffects = React.useCallback((
        effects: readonly TranscriptViewportLifecycleEffect[],
    ) => {
        if (Platform.OS === 'web') return;
        applyNativeDragActiveMirrorApplyEffects(resolveNativeDragActiveMirrorApplyEffects({
            effects,
            sessionId: props.sessionId,
        }));
    }, [
        applyNativeDragActiveMirrorApplyEffects,
        props.sessionId,
    ]);

    const applyNativeBottomFollowRearmResetEffects = React.useCallback((
        effects: readonly NativeBottomFollowRearmResetEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== props.sessionId) continue;
            if (effect.type !== 'reset-native-bottom-follow-rearm') continue;
            nativeBottomFollowRearmedAfterDragRef.current = false;
        }
    }, [props.sessionId]);

    const applyNativeBottomFollowRearmResetLifecycleEffects = React.useCallback((
        effects: readonly TranscriptViewportLifecycleEffect[],
    ) => {
        if (Platform.OS === 'web') return;
        applyNativeBottomFollowRearmResetEffects(resolveNativeBottomFollowRearmResetEffects({
            effects,
            sessionId: props.sessionId,
        }));
    }, [
        applyNativeBottomFollowRearmResetEffects,
        props.sessionId,
    ]);

    const applyNativeTouchReleaseLiveTailStateEffects = React.useCallback((
        effects: readonly NativeTouchReleaseLiveTailStateEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== props.sessionId) continue;
            if (effect.type !== 'apply-native-touch-release-live-tail-state') continue;
            wantsPinnedRef.current = false;
            isPinnedRef.current = false;
            commitScrollPinState({ ...scrollPinRef.current, isPinned: false });
        }
    }, [
        commitScrollPinState,
        props.sessionId,
    ]);

    const applyNativeOffsetReleaseLiveTailStateEffects = React.useCallback((
        effects: readonly NativeOffsetReleaseLiveTailStateEffect[],
    ): boolean => {
        let appliedRelease = false;
        for (const effect of effects) {
            if (effect.sessionId !== props.sessionId) continue;
            if (effect.type !== 'apply-native-offset-release-live-tail-state') continue;
            commitBottomFollowModeState(effect.bottomFollowState);
            wantsPinnedRef.current = false;
            isPinnedRef.current = false;
            appliedRelease = true;
        }
        return appliedRelease;
    }, [
        commitBottomFollowModeState,
        props.sessionId,
    ]);

    const releaseLiveTailForImmediateWebUserIntent = React.useCallback(() => {
        const transition = dispatchViewportLifecycleEvent({
            sessionId: props.sessionId,
            source: 'web-immediate-user-intent',
            type: 'release-live-tail-intent',
        });
        applyImmediateWebReleaseLifecycleEffects(transition.effects);
    }, [
        applyImmediateWebReleaseLifecycleEffects,
        dispatchViewportLifecycleEvent,
        props.sessionId,
    ]);

    const applyWebUserScrollTakeoverApplyEffects = React.useCallback((
        effects: readonly WebUserScrollTakeoverApplyEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== props.sessionId) continue;
            preemptEntryRestoreTransaction();
        }
    }, [
        preemptEntryRestoreTransaction,
        props.sessionId,
    ]);

    const applyWebUserScrollTakeoverLifecycleEffects = React.useCallback((
        effects: readonly TranscriptViewportLifecycleEffect[],
    ) => {
        applyWebUserScrollTakeoverApplyEffects(resolveWebUserScrollTakeoverApplyEffects({
            effects,
            sessionId: props.sessionId,
        }));
    }, [
        applyWebUserScrollTakeoverApplyEffects,
        props.sessionId,
    ]);

    const applyWebUserScrollIntentTimestampApplyEffects = React.useCallback((
        effects: readonly WebUserScrollIntentTimestampApplyEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== props.sessionId) continue;
            lastUserScrollIntentAtMsRef.current = effect.timestampMs;
        }
    }, [props.sessionId]);

    const applyWebUserScrollIntentTimestampLifecycleEffects = React.useCallback((
        effects: readonly TranscriptViewportLifecycleEffect[],
    ) => {
        applyWebUserScrollIntentTimestampApplyEffects(resolveWebUserScrollIntentTimestampApplyEffects({
            effects,
            sessionId: props.sessionId,
        }));
    }, [
        applyWebUserScrollIntentTimestampApplyEffects,
        props.sessionId,
    ]);

    const stopScrollEventPropagationOnWeb = React.useCallback((event: any) => {
        // Expo Router (Vaul/Radix) modals on web often install document-level scroll-lock listeners
        // that `preventDefault()` wheel/touch scroll, which breaks scrolling inside nested scroll views.
        // Stopping propagation here keeps the event within the transcript subtree so native scrolling works.
        if (Platform.OS !== 'web') return;
        const nowMs = Date.now();
        lastExplicitWebScrollIntentAtMsRef.current = nowMs;
        const transition = dispatchViewportLifecycleEvent({
            sessionId: props.sessionId,
            type: 'web-user-scroll-takeover',
        });
        applyWebUserScrollTakeoverLifecycleEffects(transition.effects);
        const timestampTransition = dispatchViewportLifecycleEvent({
            sessionId: props.sessionId,
            timestampMs: nowMs,
            type: 'web-user-scroll-intent-timestamp',
        });
        applyWebUserScrollIntentTimestampLifecycleEffects(timestampTransition.effects);
        // If the user scrolls upward (away from the bottom), treat that as explicit intent to unpin
        // immediately, even if they remain within the pinned threshold. This prevents mount-time
        // stabilization retries from fighting the user for several seconds after entering a session.
        const deltaY = (event as any)?.deltaY;
        if (typeof deltaY === 'number' && Number.isFinite(deltaY) && deltaY < 0) {
            releaseLiveTailForImmediateWebUserIntent();
        }
        if (typeof event?.stopPropagation === 'function') event.stopPropagation();
    }, [
        applyWebUserScrollIntentTimestampLifecycleEffects,
        applyWebUserScrollTakeoverLifecycleEffects,
        dispatchViewportLifecycleEvent,
        props.sessionId,
        releaseLiveTailForImmediateWebUserIntent,
    ]);

    const markUserScrollIntentOnWeb = React.useCallback(() => {
        if (Platform.OS !== 'web') return;
        const nowMs = Date.now();
        lastExplicitWebScrollIntentAtMsRef.current = nowMs;
        const transition = dispatchViewportLifecycleEvent({
            sessionId: props.sessionId,
            type: 'web-user-scroll-takeover',
        });
        applyWebUserScrollTakeoverLifecycleEffects(transition.effects);
        const timestampTransition = dispatchViewportLifecycleEvent({
            sessionId: props.sessionId,
            timestampMs: nowMs,
            type: 'web-user-scroll-intent-timestamp',
        });
        applyWebUserScrollIntentTimestampLifecycleEffects(timestampTransition.effects);
    }, [
        applyWebUserScrollIntentTimestampLifecycleEffects,
        applyWebUserScrollTakeoverLifecycleEffects,
        dispatchViewportLifecycleEvent,
        props.sessionId,
    ]);

    const applyNativeGestureTakeoverPlan = React.useCallback((plan: NativeGestureTakeoverPlan) => {
        if (Platform.OS === 'web') return;
        commitBottomFollowModeState(plan.state.bottomFollowState);
        applyNativeUserScrollTakeoverHostEffects(plan.nativeUserScrollTakeoverEffects);
        markNativeInitialViewportAppliedForCurrentSession();
        // A finger down catches any in-flight fling: its momentum window ends here.
        cancelScheduledPinToBottom();
        applyNativeBottomFollowRearmResetEffects(plan.nativeBottomFollowRearmResetEffects);
        applyNativeDragActiveMirrorApplyEffects(plan.nativeDragActiveMirrorEffects);
        applyNativeMomentumActiveMirrorApplyEffects(plan.nativeMomentumActiveMirrorEffects);
    }, [
        applyNativeBottomFollowRearmResetEffects,
        applyNativeDragActiveMirrorApplyEffects,
        applyNativeMomentumActiveMirrorApplyEffects,
        applyNativeUserScrollTakeoverHostEffects,
        commitBottomFollowModeState,
        cancelScheduledPinToBottom,
        markNativeInitialViewportAppliedForCurrentSession,
    ]);

    const recordNativeGestureTakeover = React.useCallback((nowMs?: number) => {
        if (Platform.OS === 'web') return;
        const plan = lifecycleHost.planNativeGestureTakeover({
            sessionId: props.sessionId,
            timestampMs: nowMs ?? Date.now(),
        });
        applyNativeGestureTakeoverPlan(plan);
    }, [
        applyNativeGestureTakeoverPlan,
        lifecycleHost,
        props.sessionId,
    ]);

    const hasOpenEntryRestoreTransactionForSession = React.useCallback(() => {
        return entryRestoreOwner.hasOpenTransaction(props.sessionId);
    }, [entryRestoreOwner, props.sessionId]);

    const hasOpenNativePrependTransactionForSession = React.useCallback((): boolean => {
        return nativePrependOwner.hasOpenTransaction(props.sessionId);
    }, [nativePrependOwner, props.sessionId]);

    const hasActiveNativeViewportRestore = React.useCallback(() => (
        hasOpenEntryRestoreTransactionForSession() ||
        hasOpenNativePrependTransactionForSession()
    ), [hasOpenEntryRestoreTransactionForSession, hasOpenNativePrependTransactionForSession]);

    const applyNativeTouchIntentHostEffects = React.useCallback((
        effects: readonly NativeTouchIntentApplyEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== props.sessionId) continue;
            switch (effect.type) {
                case 'native-touch-record-intent-timestamp':
                    lastUserScrollIntentAtMsRef.current = effect.timestampMs;
                    break;
                case 'native-touch-suppress-native-mount-settle-auto-pin':
                    nativeMountSettleAutoPinSuppressedRef.current = true;
                    break;
                case 'native-touch-cancel-native-mount-settle-bottom-pin':
                    pendingNativeMountSettleBottomPinRef.current = false;
                    break;
                case 'native-touch-cancel-scheduled-pin':
                    cancelScheduledPinToBottom();
                    break;
            }
        }
    }, [
        cancelScheduledPinToBottom,
        props.sessionId,
    ]);

    const recordNativeTranscriptTouchStartIntent = React.useCallback((event?: unknown) => {
        if (Platform.OS === 'web') return;
        nativeTranscriptTouchStartYRef.current = readNativeTouchPageY(event);
    }, []);

    const recordNativeTranscriptTouchEndIntent = React.useCallback(() => {
        if (Platform.OS === 'web') return;
        nativeTranscriptTouchStartYRef.current = null;
    }, []);

    const recordNativeTranscriptTouchIntent = React.useCallback((event?: unknown) => {
        if (Platform.OS === 'web') return;
        const hasActiveNativeRestore = hasActiveNativeViewportRestore();
        const currentY = readNativeTouchPageY(event);
        const startY = nativeTranscriptTouchStartYRef.current;
        if (startY == null && currentY != null) {
            nativeTranscriptTouchStartYRef.current = currentY;
        }
        const movedVertically =
            startY != null &&
            currentY != null &&
            Math.abs(currentY - startY) >= TRANSCRIPT_NATIVE_TOUCH_ESCAPE_MOVE_THRESHOLD_PX;
        if (movedVertically && !hasActiveNativeRestore && wantsPinnedRef.current) {
            nativeTranscriptTouchStartYRef.current = currentY;
            recordNativeGestureTakeover();
            const releaseThresholdPx = pinThresholdPxRef.current;
            // Native active streams can remain physically bottom-pinned long enough
            // that no trusted scroll frame arrives before drag-end. Once the user's
            // touch has moved beyond the escape threshold, the gesture itself owns
            // the viewport: release live-tail now and let a later trusted bottom
            // observation re-arm follow if the user returns.
            const plan = lifecycleHost.planNativeTouchRelease({
                distanceFromLiveTailPx: releaseThresholdPx + 1,
                pinThresholdPx: releaseThresholdPx,
                sessionId: props.sessionId,
            });
            commitBottomFollowModeState(plan.state.bottomFollowState);
            applyNativeTouchReleaseLiveTailStateEffects(plan.nativeTouchReleaseStateEffects);
            applyNativeBottomFollowRearmResetEffects(plan.nativeBottomFollowRearmResetEffects);
            return;
        }
        const nowMs = Date.now();
        const plan = lifecycleHost.planNativeTouchIntent({
            hasActiveNativeViewportRestore: hasActiveNativeRestore,
            sessionId: props.sessionId,
            timestampMs: nowMs,
        });
        applyNativeTouchIntentHostEffects(plan.nativeTouchIntentEffects);
    }, [
        applyNativeTouchIntentHostEffects,
        hasActiveNativeViewportRestore,
        applyNativeBottomFollowRearmResetEffects,
        applyNativeTouchReleaseLiveTailStateEffects,
        commitBottomFollowModeState,
        lifecycleHost,
        props.sessionId,
        recordNativeGestureTakeover,
    ]);

    const recordNativeListDragEscapeIntent = React.useCallback(() => {
        recordNativeGestureTakeover();
    }, [recordNativeGestureTakeover]);

    const recordNativeTranscriptResponderStartIntent = React.useCallback((event?: unknown) => {
        recordNativeTranscriptTouchStartIntent(event);
        return false;
    }, [recordNativeTranscriptTouchStartIntent]);

    const recordNativeTranscriptResponderMoveIntent = React.useCallback((event?: unknown) => {
        recordNativeTranscriptTouchIntent(event);
        return false;
    }, [recordNativeTranscriptTouchIntent]);

    const nativeFlashListScrollOverrideProps = React.useMemo(() => {
        if (Platform.OS === 'web') return undefined;
        return {
            onMoveShouldSetResponderCapture: recordNativeTranscriptResponderMoveIntent,
            onStartShouldSetResponderCapture: recordNativeTranscriptResponderStartIntent,
            onTouchCancel: recordNativeTranscriptTouchEndIntent,
            onTouchEnd: recordNativeTranscriptTouchEndIntent,
            onTouchMove: recordNativeTranscriptTouchIntent,
            onTouchStart: recordNativeTranscriptTouchStartIntent,
        };
    }, [
        recordNativeTranscriptResponderMoveIntent,
        recordNativeTranscriptResponderStartIntent,
        recordNativeTranscriptTouchEndIntent,
        recordNativeTranscriptTouchIntent,
        recordNativeTranscriptTouchStartIntent,
    ]);

    const mainTranscriptListShellPlatformInteractionProps = React.useMemo<TranscriptListShellPlatformInteractionProps>(() => {
        if (Platform.OS === 'web') {
            return {
                onWheel: stopScrollEventPropagationOnWeb,
                onTouchMove: stopScrollEventPropagationOnWeb,
                onPointerDown: markUserScrollIntentOnWeb,
                onMouseDown: markUserScrollIntentOnWeb,
            };
        }
        return {
            onTouchCancel: recordNativeTranscriptTouchEndIntent,
            onTouchEnd: recordNativeTranscriptTouchEndIntent,
            onTouchMove: recordNativeTranscriptTouchIntent,
            onTouchStart: recordNativeTranscriptTouchStartIntent,
        };
    }, [
        markUserScrollIntentOnWeb,
        recordNativeTranscriptTouchEndIntent,
        recordNativeTranscriptTouchIntent,
        recordNativeTranscriptTouchStartIntent,
        stopScrollEventPropagationOnWeb,
    ]);

    const applyLocalTranscriptInteractionAutoPinDeferralApplyEffects = React.useCallback((
        effects: readonly LocalTranscriptInteractionAutoPinDeferralApplyEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== props.sessionId) continue;
            switch (effect.type) {
                case 'local-interaction-record-intent-timestamp':
                    lastUserScrollIntentAtMsRef.current = effect.timestampMs;
                    break;
                case 'local-interaction-suppress-native-mount-settle-auto-pin':
                    nativeMountSettleAutoPinSuppressedRef.current = true;
                    break;
                case 'local-interaction-cancel-scheduled-pin':
                    cancelScheduledPinToBottom();
                    break;
            }
        }
    }, [
        cancelScheduledPinToBottom,
        props.sessionId,
    ]);

    const deferAutoPinAfterLocalTranscriptInteraction = React.useCallback(() => {
        const nowMs = Date.now();
        const plan = lifecycleHost.planLocalInteractionAutoPinDeferral({
            sessionId: props.sessionId,
            timestampMs: nowMs,
        });
        commitBottomFollowModeState(plan.state.bottomFollowState);
        applyLocalTranscriptInteractionAutoPinDeferralApplyEffects(
            plan.localInteractionAutoPinDeferralEffects,
        );
    }, [
        applyLocalTranscriptInteractionAutoPinDeferralApplyEffects,
        commitBottomFollowModeState,
        lifecycleHost,
        props.sessionId,
    ]);

    const prepareWebToolGroupLocalHeightChange = React.useCallback((): 'anchor' | 'bottom' | 'none' => {
        if (Platform.OS !== 'web') return 'none';
        const metrics = resolveWebScrollMetrics();
        if (!metrics) return 'none';
        const distanceFromBottom = getWebTranscriptDistanceFromBottom(metrics);
        if (wantsPinnedRef.current && distanceFromBottom <= pinThresholdPxRef.current) {
            pendingWebLocalHeightChangeAnchorRef.current = null;
            return 'bottom';
        }
        if (!isWebTranscriptScrollable(metrics, 1)) {
            pendingWebLocalHeightChangeAnchorRef.current = null;
            return 'none';
        }
        const anchor = captureWebTranscriptViewportAnchor({ container: metrics.element });
        if (!anchor) {
            pendingWebLocalHeightChangeAnchorRef.current = null;
            return 'none';
        }
        pendingWebLocalHeightChangeAnchorRef.current = {
            sessionId: props.sessionId,
            anchor,
        };
        return 'anchor';
    }, [props.sessionId, resolveWebScrollMetrics]);

    const applyToolCallsGroupExpanded = React.useCallback((params: { toolCallsGroupId: string; toolMessageIds: readonly string[]; expanded: boolean }) => {
        setExpandedToolCallsAnchorMessageIds((prev) => {
            const next = new Set(prev);
            if (params.expanded) {
                const toolMessageIds = params.toolMessageIds;
                const anchor = toolMessageIds.length > 0 ? toolMessageIds[toolMessageIds.length - 1] : null;
                if (typeof anchor === 'string' && anchor) {
                    next.add(anchor);
                }
            } else {
                for (const id of params.toolMessageIds) {
                    next.delete(id);
                }
            }
            return next;
        });
    }, []);

    const resolveThinkingExpanded = React.useCallback((messageId: string): boolean => {
        return thinkingExpandedByMessageId.get(messageId) ?? thinkingDefaultExpanded;
    }, [thinkingDefaultExpanded, thinkingExpandedByMessageId]);

    const applyThinkingExpanded = React.useCallback((messageId: string, expanded: boolean) => {
        setThinkingExpandedByMessageId((prev) => {
            const prevValue = prev.get(messageId);
            if (prevValue === expanded) return prev;
            const next = new Map(prev);
            if (expanded === thinkingDefaultExpanded) {
                next.delete(messageId);
            } else {
                next.set(messageId, expanded);
            }
            return next;
        });
    }, [thinkingDefaultExpanded]);

    const setToolCallsGroupExpanded = React.useCallback((params: { toolCallsGroupId: string; toolMessageIds: readonly string[]; expanded: boolean }) => {
        const webHeightPolicy = prepareWebToolGroupLocalHeightChange();
        if (Platform.OS !== 'web' || webHeightPolicy !== 'bottom') {
            deferAutoPinAfterLocalTranscriptInteraction();
        }
        applyToolCallsGroupExpanded(params);
    }, [applyToolCallsGroupExpanded, deferAutoPinAfterLocalTranscriptInteraction, prepareWebToolGroupLocalHeightChange]);

    const setThinkingExpanded = React.useCallback((messageId: string, expanded: boolean) => {
        if (resolveThinkingExpanded(messageId) === expanded) return;
        deferAutoPinAfterLocalTranscriptInteraction();
        applyThinkingExpanded(messageId, expanded);
    }, [applyThinkingExpanded, deferAutoPinAfterLocalTranscriptInteraction, resolveThinkingExpanded]);

    const onViewportChangeRef = React.useRef(props.onViewportChange);
    React.useEffect(() => {
        onViewportChangeRef.current = props.onViewportChange;
    }, [props.onViewportChange]);
    const stampViewportAnchorForEmit = React.useCallback((
        anchor: SessionViewportAnchorSnapshot | null | undefined,
    ): SessionViewportAnchorSnapshot | null | undefined => {
        const state = getStorage().getState();
        const session = state?.sessionMessages?.[props.sessionId];
        return stampViewportAnchorForEmitState({
            anchor,
            items: listDataRef.current,
            messagesById: props.messagesById,
            stateMessagesById: (session?.messagesById ?? session?.messagesMap ?? {}) as Readonly<Record<string, Message | undefined>>,
        });
    }, [
        props.messagesById,
        props.sessionId,
    ]);
    const emitViewportChange = React.useCallback((state: TranscriptViewportChangeState): boolean => {
        const emit = onViewportChangeRef.current;
        if (!emit) return false;
        emit({
            ...state,
            anchor: stampViewportAnchorForEmit(state.anchor),
        });
        return true;
    }, [stampViewportAnchorForEmit]);
    const applyExplicitReturnToLiveTailViewportEffects = React.useCallback((
        effects: readonly ExplicitReturnToLiveTailViewportEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== props.sessionId) continue;
            if (effect.type !== 'apply-explicit-return-to-live-tail-viewport') continue;
            commitScrollPinState({ ...scrollPinRef.current, isPinned: effect.isPinned, newActivityCount: 0 });
            const emitted = emitViewportChange({
                isPinned: effect.isPinned,
                offsetY: effect.distanceFromLiveTailPx,
                shouldRestoreViewport: false,
            });
            if (!emitted) {
                sync.markSessionLiveTailIntent(props.sessionId);
            }
        }
    }, [
        commitScrollPinState,
        emitViewportChange,
        props.sessionId,
    ]);
    const commitExplicitReturnToLiveTailState = React.useCallback((
        intent: Extract<TranscriptViewportLifecycleEvent, { type: 'return-to-live-tail-intent' }>['intent'],
    ) => {
        wantsPinnedRef.current = true;
        isPinnedRef.current = true;
        const plan = lifecycleHost.planExplicitReturnToLiveTail({
            intent,
            sessionId: props.sessionId,
        });
        commitBottomFollowModeState(plan.state.bottomFollowState);
        applyExplicitReturnToLiveTailViewportEffects(plan.viewportEffects);
    }, [
        applyExplicitReturnToLiveTailViewportEffects,
        commitBottomFollowModeState,
        lifecycleHost,
        props.sessionId,
    ]);
    const cancelScheduledViewportAnchorCapture = React.useCallback(() => {
        const scheduled = scheduledViewportAnchorCaptureRef.current;
        if (!scheduled) return;
        scheduledViewportAnchorCaptureRef.current = null;
        clearTimeout(scheduled.timeoutId);
    }, []);
    const invalidateViewportAnchorCapture = React.useCallback(() => {
        viewportAnchorCaptureGenerationRef.current += 1;
        cancelScheduledViewportAnchorCapture();
    }, [cancelScheduledViewportAnchorCapture]);
    const resetViewportAnchorCaptureForSessionEntry = React.useCallback(() => {
        flushViewportAnchorCaptureRef.current();
        invalidateViewportAnchorCapture();
    }, [invalidateViewportAnchorCapture]);
    const resetInitialFillForSessionEntry = React.useCallback(() => {
        initialFillAbortRef.current?.abort();
        initialFillAbortRef.current = null;
    }, []);
    const resetNativeMountSettleFlagsForSessionEntry = React.useCallback(() => {
        setNativeMountSettleStable(false);
        nativeMountSettleDeadlineReachedRef.current = false;
        nativeMountSettleAutoPinSuppressedRef.current = false;
        setNativeMountSettleDeadlineReached(false);
    }, []);
    const clearNativePaintReleaseTimeoutsForSessionEntry = React.useCallback(() => {
        const nativeFirstPaintFallbackReleaseTimeout = nativeFirstPaintFallbackReleaseTimeoutRef.current;
        if (nativeFirstPaintFallbackReleaseTimeout) {
            nativeFirstPaintFallbackReleaseTimeoutRef.current = null;
            clearTimeout(nativeFirstPaintFallbackReleaseTimeout.timeoutId);
        }
        const nativeEntryRestorePaintReleaseTimeout = nativeEntryRestorePaintReleaseTimeoutRef.current;
        if (nativeEntryRestorePaintReleaseTimeout) {
            nativeEntryRestorePaintReleaseTimeoutRef.current = null;
            clearTimeout(nativeEntryRestorePaintReleaseTimeout.timeoutId);
        }
    }, []);
    const resetTransientSessionEntryUiState = React.useCallback(() => {
        clearWebPrependRestoreWindow('abandoned-identity');
        setExpandedToolCallsAnchorMessageIds(new Set());
    }, [clearWebPrependRestoreWindow]);
    const consumeSessionOpenArmEntryViewportState = React.useCallback(() => {
        const entryViewport = sessionEntryViewportRef.current;
        const shouldFollowBottom = entryViewport?.shouldFollowBottom ?? true;
        const entryAnchor = shouldFollowBottom ? null : (entryViewport?.anchor ?? null);
        const entryEffects = entryViewport?.effects ?? [];
        if (entryViewport && entryEffects.length > 0) {
            sessionEntryViewportRef.current = {
                ...entryViewport,
                effects: [],
            };
        }
        return {
            entryAnchor,
            entryEffects,
            entryOffsetY: entryViewport?.offsetY ?? null,
            shouldFollowBottom,
        };
    }, []);
    const applyFollowBottomIntentTakeoverApplyEffects = React.useCallback((
        effects: readonly FollowBottomIntentTakeoverApplyEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== props.sessionId) continue;
            switch (effect.type) {
                case 'follow-bottom-intent-preempt-entry-restore':
                    preemptEntryRestoreTransaction();
                    break;
                case 'follow-bottom-intent-clear-user-scroll-intent':
                    lastUserScrollIntentAtMsRef.current = Number.NEGATIVE_INFINITY;
                    break;
                case 'follow-bottom-intent-record-live-tail-pin-offset':
                    lastPinOffsetForIntentRef.current = effect.distanceFromLiveTailPx;
                    break;
            }
        }
    }, [
        preemptEntryRestoreTransaction,
        props.sessionId,
    ]);
    const applySessionEntryViewportApplyEffects = React.useCallback((
        effects: readonly SessionEntryViewportApplyEffect[],
        entryAnchor: SessionViewportAnchorSnapshot | null,
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== props.sessionId) continue;
            if (effect.type !== 'apply-session-entry-viewport') continue;
            wantsPinnedRef.current = effect.isPinned;
            isPinnedRef.current = effect.isPinned;
            commitScrollPinState({
                isPinned: effect.isPinned,
                lastActivityKey: null,
                newActivityCount: 0,
            });
            jumpToBottomDistanceFromBottomRef.current = effect.jumpButtonDistanceFromLiveTailPx;
            setJumpToBottomDistanceFromBottom(effect.jumpButtonDistanceFromLiveTailPx);
            if (effect.shouldEmitViewportChange) {
                emitViewportChange({
                    anchor: effect.shouldUseEntryAnchor ? entryAnchor : null,
                    isPinned: effect.isPinned,
                    offsetY: effect.jumpButtonDistanceFromLiveTailPx,
                    shouldRestoreViewport: effect.shouldRestoreViewport,
                });
            }
        }
    }, [
        commitScrollPinState,
        emitViewportChange,
        props.sessionId,
    ]);
    React.useLayoutEffect(() => {
        const resolvedEntryViewport = resolveSessionEntryViewportState<SessionViewportAnchorSnapshot>(
            readSessionViewportForEntry(props.sessionId),
        );
        const shouldFollowBottom = resolvedEntryViewport.shouldFollowBottom;
        const persistedEntryOffsetY = resolvedEntryViewport.offsetY;
        const entryKind: SessionOpenEntryKind = props.jumpToSeq != null
            ? 'jump'
            : (shouldFollowBottom ? 'bottom' : 'anchored');
        if (
            sessionEntryViewportRef.current?.sessionId === props.sessionId &&
            sessionEntryViewportRef.current.entryKind === entryKind
        ) {
            return;
        }
        const platform = Platform.OS === 'web' ? 'web' : 'native';
        const lifecycleEntry = lifecycleHost.enterSession({
            entryDistanceFromLiveTailPx: persistedEntryOffsetY,
            platform,
            sessionId: props.sessionId,
            shouldFollowLiveTail: shouldFollowBottom,
        });
        const tuning = sync.getSyncTuning();
        const webInitialPinRetryPlan = resolveSessionOpenWebInitialPinRetryPlan(tuning);
        const armDecision = sessionOpenLatch.arm({
            entryKind,
            isNativeFlashListBottomMaintenanceEnabled: Platform.OS !== 'web',
            nativeFirstPaintFallbackDelayMs:
                tuning.transcriptInitialFillBudgetMs +
                tuning.transcriptMountSettleQuiescentWindowMs * 2 +
                1,
            nowMs: Date.now(),
            platform,
            sessionId: props.sessionId,
            shouldFollowBottom,
            webInitialPinRetryDelaysMs: webInitialPinRetryPlan.retryDelaysMs,
            webInitialPinStabilizeMs: webInitialPinRetryPlan.stabilizeMaxMs,
        });
        sessionEntryViewportRef.current = {
            sessionId: props.sessionId,
            entryKind,
            shouldFollowBottom,
            offsetY: persistedEntryOffsetY,
            anchor: resolvedEntryViewport.anchor,
            effects: lifecycleEntry.viewportEffects,
        };
        wantsPinnedRef.current = Boolean(shouldFollowBottom);
        isPinnedRef.current = shouldFollowBottom;
        commitBottomFollowModeState(lifecycleEntry.state.bottomFollowState);
        lastUserScrollIntentAtMsRef.current = Number.NEGATIVE_INFINITY;
        lastExplicitWebScrollIntentAtMsRef.current = Number.NEGATIVE_INFINITY;
        lastRouteJumpProtectionClearingWebMovementAtMsRef.current = Number.NEGATIVE_INFINITY;
        lastAutoRepinAtMsRef.current = Number.NEGATIVE_INFINITY;
        lastPinOffsetForIntentRef.current = shouldFollowBottom ? 0 : persistedEntryOffsetY;
        lastScrollOffsetForIntentRef.current = null;
        applySessionEntryRenderResetEffects(lifecycleEntry.renderResetEffects);
        applySessionOpenLatchEffectsRef.current(armDecision.effects);
        applySessionOpenLatchEffectsRef.current(sessionOpenLatch.onHostFacts({
            contentHeight: listContentHeightRef.current,
            hasEntrySliceWindow: entrySliceWindowRef.current?.sessionId === props.sessionId,
            isLoaded: props.isLoaded,
            isScrollable: false,
            itemCount: itemsRef.current.length,
            layoutHeight: listLayoutHeightRef.current,
            nowMs: Date.now(),
            sessionId: props.sessionId,
            userWantsPinned: wantsPinnedRef.current,
        }).effects);
    }, [
        applySessionEntryRenderResetEffects,
        commitBottomFollowModeState,
        lifecycleHost,
        props.isLoaded,
        props.jumpToSeq,
        props.sessionId,
        sessionOpenLatch,
    ]);
    const lastFollowBottomIntentKeyRef = React.useRef<string | number | null>(props.followBottomIntentKey ?? null);

    const applySessionOpenArmResetPlan = React.useCallback((plan: SessionOpenArmResetPlan): void => {
        if (plan.sessionId !== props.sessionId) return;
        resetViewportAnchorCaptureForSessionEntry();
        resetInitialFillForSessionEntry();
        resetNativeMountSettleFlagsForSessionEntry();
        hideOlderLoadSpinner();
        clearNativePaintReleaseTimeoutsForSessionEntry();
        resetOlderPaginationForSessionEntry();
        cancelScheduledPinToBottom();
        resetTransientSessionEntryUiState();
        const {
            entryAnchor,
            entryEffects,
            entryOffsetY,
            shouldFollowBottom,
        } = consumeSessionOpenArmEntryViewportState();
        lastUserScrollIntentAtMsRef.current = Number.NEGATIVE_INFINITY;
        lastExplicitWebScrollIntentAtMsRef.current = Number.NEGATIVE_INFINITY;
        lastRouteJumpProtectionClearingWebMovementAtMsRef.current = Number.NEGATIVE_INFINITY;
        lastAutoRepinAtMsRef.current = Number.NEGATIVE_INFINITY;
        // Null (no trustworthy remembered offset) must survive here: 0 would read as
        // "at the bottom" and let the exit flush fabricate a live-tail report.
        lastPinOffsetForIntentRef.current = shouldFollowBottom ? 0 : entryOffsetY;
        lastScrollOffsetForIntentRef.current = null;
        webDomObservation.reset();
        lastNativePinOffsetRef.current = null;
        lastNativeBottomFollowPinCommandRef.current = null;
        lastProactiveAutoFollowActivityKeyRef.current = props.latestCommittedActivityKey;
        resetNativeSessionViewportLifecycle(plan.sessionId);
        invalidateNativePrependOwnerRef.current();
        lastNativeRestoreIndexCommandRef.current = null;
        if (Platform.OS !== 'web') {
            listContentHeightRef.current = 0;
            setListContentHeight(0);
        }
        pendingNativeMountSettleBottomPinRef.current = false;
        sessionOpenWebInitialPinRetryArmAtMsRef.current = Date.now();
        applySessionEntryViewportApplyEffects(entryEffects, entryAnchor);
        if (Platform.OS === 'web' && shouldFollowBottom) {
            scheduleFirstSessionOpenWebInitialPinRetryRef.current?.();
        }
    }, [
        applySessionEntryViewportApplyEffects,
        cancelScheduledPinToBottom,
        clearNativePaintReleaseTimeoutsForSessionEntry,
        consumeSessionOpenArmEntryViewportState,
        hideOlderLoadSpinner,
        resetInitialFillForSessionEntry,
        resetNativeMountSettleFlagsForSessionEntry,
        resetNativeSessionViewportLifecycle,
        resetOlderPaginationForSessionEntry,
        resetTransientSessionEntryUiState,
        resetViewportAnchorCaptureForSessionEntry,
        props.latestCommittedActivityKey,
        props.sessionId,
        webDomObservation,
    ]);

    const applySessionOpenDisposeResetPlan = React.useCallback((plan: SessionOpenDisposeResetPlan): void => {
        if (plan.reason !== 'session-switch' && plan.reason !== 'disposed') return;
        resetInitialFillForSessionEntry();
        clearNativePaintReleaseTimeoutsForSessionEntry();
        cancelScheduledPinToBottom();
        pendingNativeMountSettleBottomPinRef.current = false;
    }, [
        cancelScheduledPinToBottom,
        clearNativePaintReleaseTimeoutsForSessionEntry,
        resetInitialFillForSessionEntry,
    ]);

    const applyUnmountCleanup = React.useCallback(() => {
        flushPendingJumpSeqViewportPromotionForExitRef.current();
        flushViewportAnchorCaptureRef.current();
        flushExitLiveTailIntentRef.current();
        // An entry transaction still open at unmount closes with an attributable
        // outcome (mirror of the prepend invalidation below) — never a silent drop.
        disposeEntryRestoreTransactionForExitRef.current();
        const entryRestoreDeadlineTimeout = entryRestoreDeadlineTimeoutRef.current;
        if (entryRestoreDeadlineTimeout) {
            entryRestoreDeadlineTimeoutRef.current = null;
            clearTimeout(entryRestoreDeadlineTimeout.timeoutId);
        }
        initialFillAbortRef.current?.abort();
        initialFillAbortRef.current = null;
        const timeoutId = olderLoadSpinnerDelayTimeoutRef.current;
        if (timeoutId) {
            olderLoadSpinnerDelayTimeoutRef.current = null;
            clearTimeout(timeoutId);
        }
        const nativeFirstPaintFallbackReleaseTimeout = nativeFirstPaintFallbackReleaseTimeoutRef.current;
        if (nativeFirstPaintFallbackReleaseTimeout) {
            nativeFirstPaintFallbackReleaseTimeoutRef.current = null;
            clearTimeout(nativeFirstPaintFallbackReleaseTimeout.timeoutId);
        }
        const nativeEntryRestorePaintReleaseTimeout = nativeEntryRestorePaintReleaseTimeoutRef.current;
        if (nativeEntryRestorePaintReleaseTimeout) {
            nativeEntryRestorePaintReleaseTimeoutRef.current = null;
            clearTimeout(nativeEntryRestorePaintReleaseTimeout.timeoutId);
        }
        lifecycleHost.resetMountSettle({ reason: 'unmount' });
        pendingNativeMountSettleBottomPinRef.current = false;
        invalidateNativePrependOwnerRef.current();
        lastNativeRestoreIndexCommandRef.current = null;
        nativeMountSettleAutoPinSuppressedRef.current = false;
    }, []);

    React.useEffect(() => {
        return () => {
            applyUnmountCleanup();
        };
    }, [applyUnmountCleanup]);

    // Web unmount detaches the DOM before passive cleanup; route-jump promotion
    // needs one last metrics read while the exiting scroller still exists.
    React.useLayoutEffect(() => {
        return () => {
            flushPendingJumpSeqViewportPromotionForExitRef.current();
        };
    }, []);

    const pinEnabled = transcriptScrollPinEnabled !== false;
    const pinThresholdPx =
        typeof transcriptScrollPinOffsetThresholdPx === 'number' && Number.isFinite(transcriptScrollPinOffsetThresholdPx)
            ? Math.max(0, Math.trunc(transcriptScrollPinOffsetThresholdPx))
            : 72;
    pinThresholdPxRef.current = pinThresholdPx;
    const autoFollowWhenPinned = transcriptScrollAutoFollowWhenPinned !== false;
    const pinEnabledRef = React.useRef(pinEnabled);
    const autoFollowWhenPinnedRef = React.useRef(autoFollowWhenPinned);
    const jumpToSeqActiveRef = React.useRef(props.jumpToSeq != null);
    pinEnabledRef.current = pinEnabled;
    autoFollowWhenPinnedRef.current = autoFollowWhenPinned;
    jumpToSeqActiveRef.current = props.jumpToSeq != null;
    const jumpEnabled = transcriptScrollJumpToBottomEnabled !== false;
    const jumpMinNewCount =
        typeof transcriptScrollJumpToBottomMinNewCount === 'number' && Number.isFinite(transcriptScrollJumpToBottomMinNewCount)
            ? Math.max(1, Math.trunc(transcriptScrollJumpToBottomMinNewCount))
            : 1;
    const jumpRevealViewportRatio =
        typeof transcriptScrollJumpToBottomRevealViewportRatio === 'number' && Number.isFinite(transcriptScrollJumpToBottomRevealViewportRatio)
            ? Math.max(0, Math.min(TRANSCRIPT_SCROLL_JUMP_TO_BOTTOM_REVEAL_VIEWPORT_RATIO_MAX, transcriptScrollJumpToBottomRevealViewportRatio))
            : settingsDefaults.transcriptScrollJumpToBottomRevealViewportRatio;
    const jumpRevealOffsetThresholdPx = Math.max(pinThresholdPx, Math.trunc(listLayoutHeight * jumpRevealViewportRatio));
    const commitJumpToBottomDistanceForVisibility = React.useCallback((distanceFromBottom: number) => {
        jumpToBottomDistanceFromBottomRef.current = distanceFromBottom;
        setJumpToBottomDistanceFromBottom((previousCommittedDistance) =>
            resolveNextJumpToBottomDistanceVisibilityState({
                previousCommittedDistance,
                nextDistance: distanceFromBottom,
                revealThresholdPx: jumpRevealOffsetThresholdPx,
            })
        );
    }, [jumpRevealOffsetThresholdPx]);
    const promotePendingJumpSeqViewportSnapshot = React.useCallback((params: Readonly<{
        distanceFromBottom: number;
        metrics: WebTranscriptScrollMetrics;
        requireRestorableAnchor?: boolean;
        scrollOffsetPx: number;
    }>): boolean => {
        const pending = pendingJumpSeqViewportPromotionRef.current;
        if (!pending) return false;
        const promotion = resolveJumpSeqViewportPromotion({
            currentSessionId: props.sessionId,
            distanceFromBottom: params.distanceFromBottom,
            metrics: params.metrics,
            pendingSeq: pending.seq,
            pendingSessionId: pending.sessionId,
            pinThresholdPx: pinThresholdPxRef.current,
            requireRestorableAnchor: params.requireRestorableAnchor,
            resolveAnchorSeq: (anchor) => normalizeDurableViewportSeq(anchor?.seq),
            scrollOffsetPx: params.scrollOffsetPx,
            stampAnchor: (anchor) => stampViewportAnchorForEmit(anchor) ?? null,
        });
        if (promotion.status === 'wrong-session') {
            pendingJumpSeqViewportPromotionRef.current = null;
            return false;
        }
        if (promotion.status === 'stale-anchor') {
            pendingJumpSeqViewportPromotionRef.current = null;
            return true;
        }
        const { state: viewportState } = promotion;
        if (promotion.status === 'needs-restorable-anchor') {
            const distanceFromBottom = viewportState.offsetY;
            wantsPinnedRef.current = false;
            isPinnedRef.current = false;
            lastPinOffsetForIntentRef.current = distanceFromBottom;
            lastScrollOffsetForIntentRef.current = promotion.scrollOffsetPx;
            commitBottomFollowModeState({ dragSession: null, mode: 'released' });
            commitJumpToBottomDistanceForVisibility(distanceFromBottom);
            commitScrollPinState({ ...scrollPinRef.current, isPinned: false });
            return false;
        }
        pendingJumpSeqViewportPromotionRef.current = null;
        const distanceFromBottom = viewportState.offsetY;
        const isPinned = viewportState.isPinned;

        invalidateViewportAnchorCapture();
        promotedJumpSeqViewportProtectionRef.current = isPinned
            ? null
            : {
                promotedAtMs: Date.now(),
                seq: pending.seq,
                sessionId: props.sessionId,
            };
        wantsPinnedRef.current = isPinned;
        isPinnedRef.current = isPinned;
        lastPinOffsetForIntentRef.current = distanceFromBottom;
        lastScrollOffsetForIntentRef.current = promotion.scrollOffsetPx;
        commitBottomFollowModeState({ dragSession: null, mode: isPinned ? 'following' : 'released' });
        commitJumpToBottomDistanceForVisibility(distanceFromBottom);
        commitScrollPinState({
            ...scrollPinRef.current,
            isPinned,
            newActivityCount: isPinned ? 0 : scrollPinRef.current.newActivityCount,
        });
        pending.emitViewportChange?.(viewportState);
        return true;
    }, [
        commitBottomFollowModeState,
        commitJumpToBottomDistanceForVisibility,
        commitScrollPinState,
        invalidateViewportAnchorCapture,
        props.sessionId,
        stampViewportAnchorForEmit,
    ]);

    const flushPendingJumpSeqViewportPromotionForExit = React.useCallback(() => {
        const pending = pendingJumpSeqViewportPromotionRef.current;
        if (!pending) return;
        if (pending.sessionId !== currentSessionIdRef.current) return;
        if (Platform.OS !== 'web') return;

        const metrics = resolveWebScrollMetrics();
        if (!metrics) return;

        const viewportState = resolveJumpSeqViewportPromotionState({
            distanceFromBottom: getWebTranscriptDistanceFromBottom(metrics),
            metrics,
            pinThresholdPx: pinThresholdPxRef.current,
        });
        pendingJumpSeqViewportPromotionRef.current = null;
        invalidateViewportAnchorCapture();
        promotedJumpSeqViewportProtectionRef.current = viewportState.isPinned
            ? null
            : {
                promotedAtMs: Date.now(),
                seq: pending.seq,
                sessionId: pending.sessionId,
            };
        const emit = pending.emitViewportChange;
        queueMicrotask(() => {
            emit?.(viewportState);
        });
    }, [
        invalidateViewportAnchorCapture,
        resolveWebScrollMetrics,
    ]);

    React.useLayoutEffect(() => {
        flushPendingJumpSeqViewportPromotionForExitRef.current = flushPendingJumpSeqViewportPromotionForExit;
    }, [flushPendingJumpSeqViewportPromotionForExit]);

    const targetWindowActiveRef = React.useRef(false);
    const activeTargetWindowTargetRef = React.useRef<TranscriptJumpTarget | null>(null);
    const targetWindowEdgeLoadInFlightRef = React.useRef({ older: false, newer: false });
    const canAutoFollowForReason = React.useCallback((
        reason: TranscriptViewportTelemetryScrollReason,
        options?: Readonly<{ explicit?: boolean }>,
    ): boolean => canAutoFollowTranscriptBottom({
        autoFollowWhenPinned: autoFollowWhenPinnedRef.current,
        bottomFollowMode: bottomFollowModeStateRef.current.mode,
        isExplicitUserCommand: options?.explicit === true || isExplicitTranscriptBottomFollowCommand(reason),
        jumpToSeqActive: jumpToSeqActiveRef.current && reason !== 'jump-to-seq',
        pinEnabled: pinEnabledRef.current,
        reason,
        targetWindowActive: targetWindowActiveRef.current,
        wantsPinned: wantsPinnedRef.current,
    }), []);
    // Native inverted scroll facts own the raw native offset mapping. Web DOM offsets stay raw scrollTop identity
    // at the host/web boundary and do not enter this native source.
    const nativeInvertedFactSourceRef = React.useRef<TranscriptViewportFactSource | null>(null);
    if (Platform.OS !== 'web' && nativeInvertedFactSourceRef.current === null) {
        nativeInvertedFactSourceRef.current = createNativeInvertedFlashListFactSource({
            readRawScrollOffset: () => readNativeAbsoluteScrollOffset(listRef.current) ?? undefined,
            readContentHeight: () => listContentHeightRef.current,
            readLayoutHeight: () => listLayoutHeightRef.current,
            readRenderedVisibleRange: () => {
                try {
                    return listRef.current?.computeVisibleIndices?.() ?? null;
                } catch {
                    return null;
                }
            },
            readFirstVisibleRenderedIndex: () => {
                try {
                    return listRef.current?.getFirstVisibleIndex?.() ?? null;
                } catch {
                    return null;
                }
            },
            readRenderedItemCount: () => listDataRef.current.length,
            readSourceIndexForRenderedIndex: (renderedIndex) => {
                const projectionSourceIndex = renderWindowIndexMapRef.current?.renderedToSourceIndex(renderedIndex);
                if (projectionSourceIndex != null) return projectionSourceIndex;
                const itemId = listDataRef.current[renderedIndex]?.id;
                if (!itemId) return null;
                const sourceIndex = canonicalWindowedItemsRef.current.findIndex((item) => item.id === itemId);
                return sourceIndex >= 0 ? sourceIndex : null;
            },
        });
    }
    const readCurrentNativeDistanceFromBottom = React.useCallback((params: {
        contentHeight?: number;
        layoutHeight?: number;
    } = {}): number | null => {
        if (Platform.OS === 'web') return null;
        return nativeInvertedFactSourceRef.current?.getDistanceFromLiveTail(params) ?? null;
    }, []);
    const resolveNativeObservedScrollOffset = React.useCallback((rawOffsetY: number, override?: {
        contentHeight?: number;
        layoutHeight?: number;
    }) => {
        if (Platform.OS === 'web') return null;
        return nativeInvertedFactSourceRef.current?.resolveObservedOffset(rawOffsetY, override) ?? null;
    }, []);
    const readViewportContentMetrics = React.useCallback((override?: {
        contentHeight?: number;
        layoutHeight?: number;
    }) => {
        if (Platform.OS === 'web') {
            const contentHeight = typeof override?.contentHeight === 'number' && Number.isFinite(override.contentHeight)
                ? override.contentHeight
                : listContentHeightRef.current;
            const layoutHeight = typeof override?.layoutHeight === 'number' && Number.isFinite(override.layoutHeight)
                ? override.layoutHeight
                : listLayoutHeightRef.current;
            if (!Number.isFinite(contentHeight) || !Number.isFinite(layoutHeight) || layoutHeight <= 0) return null;
            const normalizedContentHeight = Math.max(0, contentHeight);
            const normalizedLayoutHeight = Math.max(0, layoutHeight);
            return {
                contentHeight: normalizedContentHeight,
                layoutHeight: normalizedLayoutHeight,
                scrollable: normalizedContentHeight > normalizedLayoutHeight,
            };
        }
        return nativeInvertedFactSourceRef.current?.getContentMetrics(override) ?? null;
    }, []);
    const readViewportVisibleSourceRange = React.useCallback(() => {
        return nativeInvertedFactSourceRef.current?.getVisibleSourceRange() ?? null;
    }, []);
    const resolveViewportReachedEdge = React.useCallback((edge: 'start' | 'end'): 'older' | 'newer' => {
        if (Platform.OS === 'web') return edge === 'start' ? 'older' : 'newer';
        return nativeInvertedFactSourceRef.current?.resolveReachedEdge(edge) ?? (edge === 'start' ? 'older' : 'newer');
    }, []);
    const observeNativeStreamAppendOffsetEscape = React.useCallback((params: {
        contentHeight: number;
        layoutHeight: number;
    }): boolean => {
        const distanceFromBottom = Platform.OS === 'web'
            ? null
            : readCurrentNativeDistanceFromBottom(params);
        const plan = lifecycleHost.planNativeOffsetEscapeRelease({
            bottomFollowState: bottomFollowModeStateRef.current,
            distanceFromLiveTailPx: distanceFromBottom,
            hasActiveNativeViewportRestore: hasActiveNativeViewportRestore(),
            hasNativeTouchStart: nativeTranscriptTouchStartYRef.current != null,
            hasRearmedNativeBottomFollow: nativeBottomFollowRearmedAfterDragRef.current,
            isNative: Platform.OS !== 'web',
            nativeMomentumScrollActive: nativeMomentumScrollActiveRef.current,
            pinThresholdPx,
            sessionId: props.sessionId,
            timestampMs: Date.now(),
            wantsPinned: wantsPinnedRef.current,
        });
        if (plan.decision.type !== 'release') return false;
        if (plan.nativeGestureTakeoverPlan) {
            applyNativeGestureTakeoverPlan(plan.nativeGestureTakeoverPlan);
        }
        return applyNativeOffsetReleaseLiveTailStateEffects(plan.nativeOffsetReleaseLiveTailStateEffects);
    }, [
        applyNativeGestureTakeoverPlan,
        applyNativeOffsetReleaseLiveTailStateEffects,
        hasActiveNativeViewportRestore,
        lifecycleHost,
        pinThresholdPx,
        props.sessionId,
        readCurrentNativeDistanceFromBottom,
    ]);
    /**
     * Trusted arrival back at the bottom (plan B8): re-arming follow is a first-class
     * live-tail transition — the viewport emission must agree with the mode within the
     * same observation window so sync marks live-tail intent (catch-up resolves
     * `tail_reset_latest_page`, never `defer_forward_loading`, on the next big gap).
     */
    const applyNativeTrustedBottomArrivalEffects = React.useCallback((
        effects: readonly NativeTrustedBottomArrivalEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== props.sessionId) continue;
            if (effect.type === 'adopt-native-trusted-bottom-arrival') {
                lastUserScrollIntentAtMsRef.current = Number.NEGATIVE_INFINITY;
                nativeMountSettleAutoPinSuppressedRef.current = false;
                nativeBottomFollowRearmedAfterDragRef.current = true;
                wantsPinnedRef.current = true;
                isPinnedRef.current = true;
                lastPinOffsetForIntentRef.current = effect.distanceFromLiveTailPx;
                commitJumpToBottomDistanceForVisibility(effect.distanceFromLiveTailPx);
                commitScrollPinState({ ...scrollPinRef.current, isPinned: true, newActivityCount: 0 });
                emitViewportChange(effect.viewportState);
            }
        }
    }, [
        commitJumpToBottomDistanceForVisibility,
        commitScrollPinState,
        emitViewportChange,
        props.sessionId,
    ]);
    const adoptNativeFollowingForTrustedBottomArrival = React.useCallback((distanceFromBottom: number | null) => {
        if (Platform.OS === 'web') return;
        applyNativeTrustedBottomArrivalEffects(resolveNativeTrustedBottomArrivalEffects({
            distanceFromLiveTailPx: distanceFromBottom,
            sessionId: props.sessionId,
        }));
    }, [
        applyNativeTrustedBottomArrivalEffects,
        props.sessionId,
    ]);
    /**
     * Deferred-newer drain (plan C6/D3): the list supplies viewport GEOMETRY only. The data layer
     * accrues the deferred-forward backlog and owns the release decision (threshold + in-flight
     * dedupe + fetch) in `sync.maybeDrainDeferredNewerMessages`. Routing every viewport observation
     * through this single owner removes parallel list-side threshold decisions.
     */
	    const drainDeferredNewerMessages = React.useCallback((params: Readonly<{
	        distanceFromBottom: number;
	        pinned: boolean;
	    }>) => {
	        sync.maybeDrainDeferredNewerMessages(props.sessionId, {
	            isPinned: params.pinned,
	            distanceFromBottomPx: params.distanceFromBottom,
	        });
    }, [props.sessionId]);
    const applyNativeReturnToLiveTailApplyEffects = React.useCallback((
        effects: readonly NativeReturnToLiveTailApplyEffect[],
    ): boolean => {
        let appliedReturn = false;
        for (const effect of effects) {
            if (effect.sessionId !== props.sessionId) continue;
            if (effect.type === 'adopt-native-return-to-live-tail') {
                adoptNativeFollowingForTrustedBottomArrival(effect.distanceFromLiveTailPx);
                appliedReturn = true;
                continue;
            }
            if (effect.type === 'drain-native-return-to-live-tail') {
                drainDeferredNewerMessages({
                    distanceFromBottom: effect.distanceFromLiveTailPx,
                    pinned: effect.isPinned,
                });
            }
        }
        return appliedReturn;
    }, [
        adoptNativeFollowingForTrustedBottomArrival,
        drainDeferredNewerMessages,
        props.sessionId,
    ]);
    const applyNativeReturnToLiveTailLifecycleEffects = React.useCallback((
        effects: readonly TranscriptViewportLifecycleEffect[],
    ): boolean => {
        if (Platform.OS === 'web') return false;
        return applyNativeReturnToLiveTailApplyEffects(resolveNativeReturnToLiveTailApplyEffects({
            effects,
            sessionId: props.sessionId,
        }));
    }, [
        applyNativeReturnToLiveTailApplyEffects,
        props.sessionId,
    ]);
    const applyNativeSettledReturnToLiveTailReturnEffects = React.useCallback((
        effects: readonly NativeSettledReturnToLiveTailReturnEffect[],
    ): boolean => {
        let appliedReturn = false;
        for (const effect of effects) {
            if (effect.sessionId !== props.sessionId) continue;
            if (effect.type === 'adopt-native-settled-return-to-live-tail') {
                adoptNativeFollowingForTrustedBottomArrival(effect.distanceFromLiveTailPx);
                appliedReturn = true;
                continue;
            }
            if (effect.type === 'capture-native-settled-return-anchor') {
                scheduleViewportAnchorCaptureRef.current(effect.viewportState);
            }
        }
        return appliedReturn;
    }, [
        adoptNativeFollowingForTrustedBottomArrival,
        props.sessionId,
    ]);
    const applyNativeSettledReturnToLiveTailDrainEffects = React.useCallback((
        effects: readonly NativeSettledReturnToLiveTailDrainEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== props.sessionId) continue;
            if (effect.type !== 'drain-native-settled-return-to-live-tail') continue;
            drainDeferredNewerMessages({
                distanceFromBottom: effect.distanceFromLiveTailPx,
                pinned: effect.isPinned,
            });
        }
    }, [drainDeferredNewerMessages, props.sessionId]);
    const shouldSuppressGenericViewportStateForProtectedJumpSeq = React.useCallback((): boolean => {
        if (Platform.OS !== 'web') return false;
        const protection = promotedJumpSeqViewportProtectionRef.current;
        const routeJumpSeq = typeof props.jumpToSeq === 'number' && Number.isFinite(props.jumpToSeq)
            ? Math.trunc(props.jumpToSeq)
            : null;
        if (
            routeJumpSeq != null &&
            pendingJumpSeqViewportPromotionRef.current === null &&
            lastRouteJumpProtectionClearingWebMovementAtMsRef.current === Number.NEGATIVE_INFINITY
        ) {
            return true;
        }
        if (!protection) return false;
        if (protection.sessionId !== props.sessionId) {
            promotedJumpSeqViewportProtectionRef.current = null;
            return false;
        }
        if (
            routeJumpSeq != null &&
            routeJumpSeq !== protection.seq
        ) {
            promotedJumpSeqViewportProtectionRef.current = null;
            return false;
        }
        if (lastRouteJumpProtectionClearingWebMovementAtMsRef.current > protection.promotedAtMs) {
            promotedJumpSeqViewportProtectionRef.current = null;
            return false;
        }
        return true;
    }, [
        props.jumpToSeq,
        props.sessionId,
    ]);
    const applyGenericScrollObservationViewportStateApplyEffects = React.useCallback((
        effects: readonly GenericScrollObservationViewportStateEffect[],
        params: Readonly<{
            recordAcceptedViewportPaintObservation: () => void;
        }>,
    ): boolean => {
        let applied = false;
        for (const effect of effects) {
            if (effect.sessionId !== props.sessionId) continue;
            applied = true;
            if (shouldSuppressGenericViewportStateForProtectedJumpSeq()) continue;
            const { state } = effect;
            lastPinOffsetForIntentRef.current = state.lastDistanceFromLiveTailPx;
            lastScrollOffsetForIntentRef.current = state.nextScrollOffsetPx;
            wantsPinnedRef.current = state.wantsPinned;
            isPinnedRef.current = state.viewportState.isPinned;
            emitViewportChange(state.viewportState);
            scheduleViewportAnchorCaptureRef.current(state.anchorCapture.viewportState, {
                suppressAnchorCapture: state.anchorCapture.suppressAnchorCapture,
            });
            commitJumpToBottomDistanceForVisibility(state.jumpButtonDistanceFromLiveTailPx);
	            commitScrollPinEvent(state.scrollPinEvent);
	            params.recordAcceptedViewportPaintObservation();
	            if (Platform.OS !== 'web') {
	                drainDeferredNewerMessages({
	                    distanceFromBottom: state.drain.distanceFromLiveTailPx,
	                    pinned: state.drain.isPinned,
	                });
	            }
	        }
	        return applied;
	    }, [
        commitJumpToBottomDistanceForVisibility,
        commitScrollPinEvent,
        drainDeferredNewerMessages,
        emitViewportChange,
        props.sessionId,
        shouldSuppressGenericViewportStateForProtectedJumpSeq,
    ]);
    const applyGenericScrollObservationViewportStateEffects = React.useCallback((
        effects: readonly TranscriptViewportLifecycleEffect[],
        params: Readonly<{
            recordAcceptedViewportPaintObservation: () => void;
        }>,
    ): boolean => {
        const applyEffects = effects.filter((
            effect,
        ): effect is GenericScrollObservationViewportStateEffect => (
            effect.sessionId === props.sessionId &&
            effect.type === 'apply-generic-observed-viewport-state'
        ));
        return applyGenericScrollObservationViewportStateApplyEffects(applyEffects, params);
    }, [
        applyGenericScrollObservationViewportStateApplyEffects,
        props.sessionId,
    ]);
    const applyGenericScrollObservationReadOnlyVisibleBottomStateEffects = React.useCallback((
        effects: readonly GenericScrollObservationReadOnlyVisibleBottomEffect[],
    ): boolean => {
        let applied = false;
        for (const effect of effects) {
            if (effect.sessionId !== props.sessionId) continue;
            applied = true;
            // Keep this path read-only: it updates visibility/telemetry state for a native passive
            // exact-bottom observation without emitting viewport persistence, drains, or pin writes.
            const { state } = effect;
            lastPinOffsetForIntentRef.current = state.lastDistanceFromLiveTailPx;
            commitJumpToBottomDistanceForVisibility(state.jumpButtonDistanceFromLiveTailPx);
            commitScrollPinEvent(state.scrollPinEvent);
        }
        return applied;
    }, [
        commitJumpToBottomDistanceForVisibility,
        commitScrollPinEvent,
        props.sessionId,
    ]);
    const applyGenericScrollObservationReadOnlyVisibleBottomEffects = React.useCallback((
        effects: readonly TranscriptViewportLifecycleEffect[],
    ): boolean => {
        const applyEffects = effects.filter((
            effect,
        ): effect is GenericScrollObservationReadOnlyVisibleBottomEffect => (
            effect.sessionId === props.sessionId &&
            effect.type === 'apply-generic-read-only-visible-bottom-state'
        ));
        return applyGenericScrollObservationReadOnlyVisibleBottomStateEffects(applyEffects);
    }, [
        applyGenericScrollObservationReadOnlyVisibleBottomStateEffects,
        props.sessionId,
    ]);
    const applyGenericScrollObservationSuppressionApplyEffects = React.useCallback((
        effects: readonly GenericScrollObservationSuppressionEffect[],
    ): boolean => {
        let applied = false;
        for (const effect of effects) {
            if (effect.sessionId !== props.sessionId) continue;
            applied = true;
        }
        return applied;
    }, [props.sessionId]);
    const applyGenericScrollObservationSuppressionEffects = React.useCallback((
        effects: readonly TranscriptViewportLifecycleEffect[],
    ): boolean => {
        const applyEffects = effects.filter((
            effect,
        ): effect is GenericScrollObservationSuppressionEffect => (
            effect.sessionId === props.sessionId &&
            effect.type === 'suppress-generic-scroll-observation'
        ));
        return applyGenericScrollObservationSuppressionApplyEffects(applyEffects);
    }, [
        applyGenericScrollObservationSuppressionApplyEffects,
        props.sessionId,
    ]);
    const applyGenericScrollObservationAnchorCaptureCancellationApplyEffects = React.useCallback((
        effects: readonly GenericScrollObservationAnchorCaptureCancellationEffect[],
    ): boolean => {
        let applied = false;
        for (const effect of effects) {
            if (effect.sessionId !== props.sessionId) continue;
            applied = true;
            invalidateViewportAnchorCapture();
        }
        return applied;
    }, [invalidateViewportAnchorCapture, props.sessionId]);
    const applyGenericScrollObservationAnchorCaptureCancellationEffects = React.useCallback((
        effects: readonly TranscriptViewportLifecycleEffect[],
    ): boolean => {
        const applyEffects = effects.filter((
            effect,
        ): effect is GenericScrollObservationAnchorCaptureCancellationEffect => (
            effect.sessionId === props.sessionId &&
            effect.type === 'cancel-scheduled-viewport-anchor-capture'
        ));
        return applyGenericScrollObservationAnchorCaptureCancellationApplyEffects(applyEffects);
    }, [
        applyGenericScrollObservationAnchorCaptureCancellationApplyEffects,
        props.sessionId,
    ]);
    const applyNativeMomentumSettleAwayReleaseStateEffects = React.useCallback((
        effects: readonly NativeMomentumSettleAwayReleaseStateEffect[],
    ): boolean => {
        let appliedRelease = false;
        for (const effect of effects) {
            if (effect.sessionId !== props.sessionId) continue;
            if (effect.type !== 'apply-native-momentum-settle-away-release-state') continue;
            wantsPinnedRef.current = false;
            isPinnedRef.current = false;
            cancelScheduledPinToBottom();
            lastPinOffsetForIntentRef.current = effect.distanceFromLiveTailPx;
            commitJumpToBottomDistanceForVisibility(effect.distanceFromLiveTailPx);
            commitScrollPinEvent(effect.scrollPinEvent);
            emitViewportChange(effect.viewportState);
            // Plan P2: the settle is user-attributed (trusted drag session) — capture the
            // dwelled position even when every momentum frame was swallowed elsewhere.
            scheduleViewportAnchorCaptureRef.current(effect.viewportState);
            appliedRelease = true;
        }
        return appliedRelease;
    }, [
        cancelScheduledPinToBottom,
        commitJumpToBottomDistanceForVisibility,
        commitScrollPinEvent,
        emitViewportChange,
        props.sessionId,
    ]);
    const applyNativeMomentumSettleAwayReleaseLifecycleEffects = React.useCallback((
        effects: readonly TranscriptViewportLifecycleEffect[],
    ): boolean => {
        if (Platform.OS === 'web') return false;
        return applyNativeMomentumSettleAwayReleaseStateEffects(resolveNativeMomentumSettleAwayReleaseStateEffects({
            effects,
            pinEnabled: pinEnabledRef.current,
            sessionId: props.sessionId,
            wantsPinned: wantsPinnedRef.current,
        }));
    }, [
        applyNativeMomentumSettleAwayReleaseStateEffects,
        props.sessionId,
    ]);
    const applyNativeBottomFollowRearmAdoptionEffects = React.useCallback((
        effects: readonly NativeBottomFollowRearmAdoptionEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== props.sessionId) continue;
            if (effect.type !== 'adopt-native-bottom-follow-rearm') continue;
            adoptNativeFollowingForTrustedBottomArrival(effect.distanceFromLiveTailPx);
        }
    }, [
        adoptNativeFollowingForTrustedBottomArrival,
        props.sessionId,
    ]);
    const applyNativeBottomFollowRearmLifecycleEffects = React.useCallback((
        effects: readonly TranscriptViewportLifecycleEffect[],
    ): boolean => {
        if (Platform.OS === 'web') return false;
        const decision = resolveNativeBottomFollowRearmAdoptionDecision({
            effects,
            hasRearmedNativeBottomFollow: nativeBottomFollowRearmedAfterDragRef.current,
            sessionId: props.sessionId,
        });
        applyNativeBottomFollowRearmAdoptionEffects(decision.effects);
        return decision.consumed;
    }, [
        applyNativeBottomFollowRearmAdoptionEffects,
        props.sessionId,
    ]);
    const recordNativeListDragEndIntent = React.useCallback(() => {
        if (Platform.OS === 'web') return;
        const dragSession = bottomFollowModeStateRef.current.dragSession;
        const distanceFromBottom =
            dragSession?.latestDistanceFromBottom ??
            readCurrentNativeDistanceFromBottom() ??
            null;
        const transition = dispatchViewportLifecycleEvent({
            distanceFromLiveTailPx: distanceFromBottom,
            pinThresholdPx,
            sessionId: props.sessionId,
            type: 'gesture-end',
        });
        applyNativeDragActiveMirrorLifecycleEffects(transition.effects);
        const appliedLifecycleReturn = applyNativeReturnToLiveTailLifecycleEffects(transition.effects);
        const appliedLifecycleRearm = applyNativeBottomFollowRearmLifecycleEffects(transition.effects);
        if (appliedLifecycleReturn || appliedLifecycleRearm) {
            return;
        }
        applyNativeBottomFollowRearmResetLifecycleEffects(transition.effects);
    }, [
        applyNativeBottomFollowRearmLifecycleEffects,
        applyNativeBottomFollowRearmResetLifecycleEffects,
        applyNativeDragActiveMirrorLifecycleEffects,
        applyNativeReturnToLiveTailLifecycleEffects,
        dispatchViewportLifecycleEvent,
        pinThresholdPx,
        props.sessionId,
        readCurrentNativeDistanceFromBottom,
    ]);
    const recordNativeMomentumScrollBeginIntent = React.useCallback(() => {
        if (Platform.OS === 'web') return;
        const transition = dispatchViewportLifecycleEvent({
            sessionId: props.sessionId,
            type: 'native-momentum-scroll-begin',
        });
        applyNativeMomentumActiveMirrorLifecycleEffects(transition.effects);
    }, [
        applyNativeMomentumActiveMirrorLifecycleEffects,
        dispatchViewportLifecycleEvent,
        props.sessionId,
    ]);
    /**
     * Post-drag momentum settle (plan B8): a trusted fling that lands within the pin
     * threshold re-arms follow even though every momentum frame is untrusted — the
     * retained trusted drag session is the user attribution, and it closes here either way.
     * Plan B9: the window also settles out of 'following' (drag ended near the bottom with
     * momentum pending) — a fling that carried the viewport away must end released, with the
     * pin/jump-button state committed even if every momentum frame was swallowed elsewhere.
     */
    const recordNativeMomentumScrollEndSettle = React.useCallback(() => {
        if (Platform.OS === 'web') return;
        const momentumEndTransition = dispatchViewportLifecycleEvent({
            sessionId: props.sessionId,
            type: 'native-momentum-scroll-end',
        });
        applyNativeMomentumActiveMirrorLifecycleEffects(momentumEndTransition.effects);
        const distanceFromBottom = readCurrentNativeDistanceFromBottom();
        const transition = dispatchViewportLifecycleEvent({
            distanceFromLiveTailPx: distanceFromBottom,
            pinThresholdPx,
            sessionId: props.sessionId,
            type: 'momentum-settle',
        });
        if (applyNativeReturnToLiveTailLifecycleEffects(transition.effects)) {
            return;
        }
        if (applyNativeBottomFollowRearmLifecycleEffects(transition.effects)) {
            return;
        }
        if (applyNativeMomentumSettleAwayReleaseLifecycleEffects(transition.effects)) {
            applyNativeBottomFollowRearmResetLifecycleEffects(transition.effects);
        }
    }, [
        applyNativeBottomFollowRearmLifecycleEffects,
        applyNativeBottomFollowRearmResetLifecycleEffects,
        applyNativeMomentumActiveMirrorLifecycleEffects,
        applyNativeMomentumSettleAwayReleaseLifecycleEffects,
        applyNativeReturnToLiveTailLifecycleEffects,
        dispatchViewportLifecycleEvent,
        pinThresholdPx,
        props.sessionId,
        readCurrentNativeDistanceFromBottom,
    ]);
    React.useEffect(() => {
        setJumpToBottomDistanceFromBottom((previousCommittedDistance) =>
            resolveNextJumpToBottomDistanceVisibilityState({
                previousCommittedDistance,
                nextDistance: jumpToBottomDistanceFromBottomRef.current,
                revealThresholdPx: jumpRevealOffsetThresholdPx,
            })
        );
    }, [jumpRevealOffsetThresholdPx]);
    const jumpToBottomAffordance = resolveJumpToBottomAffordanceState({
        distanceFromBottom: jumpToBottomDistanceFromBottom,
        enabled: jumpEnabled,
        isPinned: scrollPin.isPinned,
        minNewActivityCount: jumpMinNewCount,
        newActivityCount: scrollPin.newActivityCount,
        revealThresholdPx: jumpRevealOffsetThresholdPx,
    });
    const jumpAnimateScroll = transcriptScrollJumpToBottomAnimateScroll !== false;
    // §13 catch-up overlay gate. `useSessionCatchingUpNewer` is the canonical UI-observable per-session
    // "sync is catching the transcript up to newer activity" signal (fail-closed). The signal is
    // catch-up-only by construction — sync brackets it ONLY around resume catch-up
    // (`catchUpDirectSessionMessages`), the deferred-newer backlog drain (`loadNewerMessages`, fired
    // only when a missed-while-away backlog exists), and socket-reconnect catch-up
    // (`invalidateMessagesForSession`); ordinary realtime live streaming applies messages straight
    // through the socket path and never raises it. So it cannot nag during normal pinned streaming and
    // needs NO pin gate. A `!scrollPin.isPinned` gate would in fact suppress the overlay in its
    // primary scenario: reopening a background-working session restores the user PINNED at the live
    // tail while sync silently catches up, which is exactly when the surface must show.
    const isCatchingUpNewer = useSessionCatchingUpNewer(props.sessionId);
    const showCatchUpOverlay = isCatchingUpNewer;
    const transcriptListExtraData = React.useMemo(() => ({
        messagePins: props.messagePins,
        selectionVersion: transcriptMessageSelection.selectionVersion,
    }), [props.messagePins, transcriptMessageSelection.selectionVersion]);

    // N3.1: the inverted pilot rides the flash_v2 machinery with orientation as an
    // orthogonal axis — every `=== 'flash_v2'` gate below stays authoritative; the
    // orientation is consumed ONLY at the seam boundaries (data order, raw<->canonical
    // scroll offsets, edge slots, chronological neighbor lookups).
    const transcriptListPresentation = resolveTranscriptListPresentation({
        platformIsWeb: Platform.OS === 'web',
    });
    const pendingWebLocalHeightChangeAnchorRef = React.useRef<Readonly<{
        sessionId: string;
        anchor: WebTranscriptViewportAnchor;
    }> | null>(null);
    const listOrientation: TranscriptListOrientation = transcriptListPresentation.orientation;
    const resolveSyncLoadOlderOptions = React.useCallback((): SyncLoadOlderOptions | undefined => {
        if (Platform.OS === 'web') return undefined;
        const configuredLimit = sync.getSyncTuning().transcriptNativeOlderMessagesPageSize;
        if (typeof configuredLimit !== 'number' || !Number.isFinite(configuredLimit)) return undefined;
        return { limit: Math.max(1, Math.trunc(configuredLimit)) };
    }, []);
    const [firstListPaintObserved, setFirstListPaintObserved] = React.useState(false);
    const [nativeViewportPaintObserved, setNativeViewportPaintObservedState] = React.useState(false);
    const nativeViewportPaintObservedRef = React.useRef(false);
    const [nativeEntryRestorePaintReleaseState, setNativeEntryRestorePaintReleaseState] = React.useState<{
        released: boolean;
        sessionId: string;
    }>(() => ({
        released: false,
        sessionId: props.sessionId,
    }));
    const nativeEntryRestorePaintReleasedRef = React.useRef<{
        released: boolean;
        sessionId: string;
    }>({
        released: false,
        sessionId: props.sessionId,
    });
    const nativeEntryRestorePaintReleased =
        nativeEntryRestorePaintReleaseState.sessionId === props.sessionId &&
        nativeEntryRestorePaintReleaseState.released;
    const updateNativeViewportPaintObserved = React.useCallback((observed: boolean) => {
        if (Platform.OS === 'web') return;
        nativeViewportPaintObservedRef.current = observed;
        setNativeViewportPaintObservedState(observed);
    }, []);
    const updateNativeEntryRestorePaintReleased = React.useCallback((released: boolean) => {
        if (Platform.OS === 'web') return;
        const nextState = {
            released,
            sessionId: props.sessionId,
        };
        nativeEntryRestorePaintReleasedRef.current = nextState;
        setNativeEntryRestorePaintReleaseState(nextState);
    }, [props.sessionId]);
    const releaseNativePaintForIssuedEntryRestore = React.useCallback(() => {
        if (Platform.OS === 'web') return false;
        if (nativeViewportPaintObservedRef.current) return false;
        if (
            nativeEntryRestorePaintReleasedRef.current.sessionId === props.sessionId &&
            nativeEntryRestorePaintReleasedRef.current.released
        ) {
            return false;
        }
        const contentMetrics = readViewportContentMetrics();
        if (!contentMetrics || contentMetrics.contentHeight <= 0) return false;
        if (sessionEntryViewportRef.current?.sessionId !== props.sessionId) return false;
        if (sessionEntryViewportRef.current.shouldFollowBottom !== false) return false;
        if (!entryRestoreOwner.hasOpenTransaction(props.sessionId)) return false;

        updateNativeEntryRestorePaintReleased(true);
        return true;
    }, [entryRestoreOwner, props.sessionId, readViewportContentMetrics, updateNativeEntryRestorePaintReleased]);
    /**
     * 32ms paint-release polish (plan A4): once the entry-restore transaction has issued its
     * write (background sessions) or closed, reveal the restored viewport shortly after.
     * The transaction deadline always fires, so the placeholder can never hang.
     */
    const scheduleNativePaintReleaseForEntryRestore = React.useCallback((options?: Readonly<{ force?: boolean }>) => {
        if (Platform.OS === 'web') return;
        if (options?.force !== true && props.sessionActive) return;
        if (nativeViewportPaintObservedRef.current) return;
        if (
            nativeEntryRestorePaintReleasedRef.current.sessionId === props.sessionId &&
            nativeEntryRestorePaintReleasedRef.current.released
        ) {
            return;
        }
        if (sessionEntryViewportRef.current?.sessionId !== props.sessionId) return;
        if (sessionEntryViewportRef.current.shouldFollowBottom !== false) return;
        const paintReleaseHandle = entryRestoreOwner.nativePaintReleaseHandle({ sessionId: props.sessionId });
        if (!paintReleaseHandle) return;
        const existing = nativeEntryRestorePaintReleaseTimeoutRef.current;
        if (
            existing?.sessionId === props.sessionId &&
            existing.issuedAtMs === paintReleaseHandle.issuedAtMs
        ) {
            return;
        }
        if (existing) {
            nativeEntryRestorePaintReleaseTimeoutRef.current = null;
            clearTimeout(existing.timeoutId);
        }

        const handle = {
            issuedAtMs: paintReleaseHandle.issuedAtMs,
            sessionId: props.sessionId,
            timeoutId: null as unknown as ReturnType<typeof setTimeout>,
        };
        handle.timeoutId = setTimeout(() => {
            if (nativeEntryRestorePaintReleaseTimeoutRef.current !== handle) return;
            nativeEntryRestorePaintReleaseTimeoutRef.current = null;
            if (currentSessionIdRef.current !== handle.sessionId) return;
            if (!entryRestoreOwner.matchesNativePaintReleaseHandle({
                issuedAtMs: handle.issuedAtMs,
                sessionId: handle.sessionId,
            })) return;
            releaseNativePaintForIssuedEntryRestore();
        }, TRANSCRIPT_NATIVE_ENTRY_RESTORE_PAINT_RELEASE_DELAY_MS);
        nativeEntryRestorePaintReleaseTimeoutRef.current = handle;
    }, [entryRestoreOwner, props.sessionActive, props.sessionId, releaseNativePaintForIssuedEntryRestore]);
    const firstPaintTelemetryRef = React.useRef<{
        recorded: boolean;
        sessionId: string;
        startedAtMs: number;
    } | null>(null);
    const stablePaintTelemetryRef = React.useRef<{
        recorded: boolean;
        sessionId: string;
        startedAtMs: number;
    } | null>(null);
    const [webStablePaintRetryTick, bumpWebStablePaintRetryTick] = React.useReducer((value: number) => (value + 1) % 1_000_000, 0);
    const webStablePaintRetryTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const clearWebStablePaintRetry = React.useCallback(() => {
        const timeout = webStablePaintRetryTimeoutRef.current;
        if (timeout === null) return;
        clearTimeout(timeout);
        webStablePaintRetryTimeoutRef.current = null;
    }, []);
    const scheduleWebStablePaintRetry = React.useCallback(() => {
        if (!syncPerformanceTelemetry.isEnabled()) return;
        if (Platform.OS !== 'web') return;
        if (stablePaintTelemetryRef.current?.recorded === true) return;
        if (webStablePaintRetryTimeoutRef.current !== null) return;
        webStablePaintRetryTimeoutRef.current = setTimeout(() => {
            webStablePaintRetryTimeoutRef.current = null;
            bumpWebStablePaintRetryTick();
        }, 16);
    }, []);
    if (firstPaintTelemetryRef.current?.sessionId !== props.sessionId) {
        firstPaintTelemetryRef.current = {
            recorded: false,
            sessionId: props.sessionId,
            startedAtMs: readSessionUiTelemetryNowMs(),
        };
    }
    if (stablePaintTelemetryRef.current?.sessionId !== props.sessionId) {
        stablePaintTelemetryRef.current = {
            recorded: false,
            sessionId: props.sessionId,
            startedAtMs: readSessionUiTelemetryNowMs(),
        };
    }

    React.useEffect(() => clearWebStablePaintRetry, [clearWebStablePaintRetry]);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return undefined;
        if (isEnrichedMarkdownRuntimePreloaded()) {
            setWebMarkdownRuntimeReady(true);
            return undefined;
        }

        let cancelled = false;
        const preload = preloadEnrichedMarkdownRuntime();
        fireAndForget(preload, { tag: 'ChatList.webMarkdownRuntimeFirstPaint' });
        preload.then(
            () => {
                if (!cancelled) setWebMarkdownRuntimeReady(true);
            },
            () => {
                if (!cancelled) setWebMarkdownRuntimeReady(true);
            },
        );

        return () => {
            cancelled = true;
        };
    }, []);

    const getTurnMessageById = React.useCallback((messageId: string): Message | null => {
        const forkAwareMessage = props.messagesById[messageId];
        if (forkAwareMessage) return forkAwareMessage;
        const state = getStorage().getState();
        const session = state?.sessionMessages?.[props.sessionId];
        return session?.messagesById?.[messageId] ?? session?.messagesMap?.[messageId] ?? null;
    }, [props.messagesById, props.sessionId]);
    // R1: revision resolver for row shell signatures — `id + revision` replaces full-message
    // serialization. Fork-context messages resolve against their origin session's revisions;
    // messages without a tracked revision fall back to the legacy content signature downstream.
    const getTurnMessageRevisionById = React.useCallback((messageId: string): number | null => {
        const state = getStorage().getState();
        const originSessionId = props.forkMessageMetadataById?.[messageId]?.originSessionId ?? props.sessionId;
        const revision = state?.sessionMessages?.[originSessionId]?.messageRevisionsById?.[messageId];
        return typeof revision === 'number' && Number.isFinite(revision) ? Math.trunc(revision) : null;
    }, [props.forkMessageMetadataById, props.sessionId]);
    const resolveToolCallMessagesForIds = React.useCallback((toolMessageIds: readonly string[]): ToolCallMessage[] => {
        const toolMessages: ToolCallMessage[] = [];
        for (const toolMessageId of toolMessageIds) {
            const message = getTurnMessageById(toolMessageId);
            if (message?.kind === 'tool-call') toolMessages.push(message);
        }
        return toolMessages;
    }, [getTurnMessageById]);
    // N2c stable virtualization units: under flash_v2 (native AND web), turn items and
    // linear tool-calls-group items decompose into per-unit rows HERE, where the
    // tool-group expansion state lives. `props.items` stays the pre-decomposition
    // source for consumers that visit turn/tool-calls-group shapes (auto-expand).
    const decomposedItems = React.useMemo<ChatTranscriptListItem[]>(() => {
        return buildTranscriptTurnUnits({
            items: props.items,
            getMessageById: getTurnMessageById,
            metadataByMessageId: props.forkMessageMetadataById ?? undefined,
            isGroupExpanded: (toolMessageIds) => toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id)),
            collapsedPreviewCount: resolveTranscriptToolCallsCollapsedPreviewCount(transcriptToolCallsCollapsedPreviewCountSetting),
        });
    }, [
        expandedToolCallsAnchorMessageIds,
        getTurnMessageById,
        props.forkMessageMetadataById,
        props.items,
        transcriptToolCallsCollapsedPreviewCountSetting,
    ]);
    const resolveTargetWindowItemSeq = React.useCallback((item: ChatTranscriptListItem): number | null => {
        const directSeq = (item as { seq?: unknown }).seq;
        if (typeof directSeq === 'number' && Number.isFinite(directSeq)) return Math.trunc(directSeq);
        const descriptor = resolveTranscriptViewportAnchorDescriptor(item);
        const messageId = descriptor?.messageId;
        if (!messageId) return null;
        const seq = getTurnMessageById(messageId)?.seq;
        return typeof seq === 'number' && Number.isFinite(seq) ? Math.trunc(seq) : null;
    }, [getTurnMessageById]);
    const sessionTargetWindowState = sync.getSessionTargetWindowState(props.sessionId);
    const renderWindowProjection = React.useMemo(() => {
        const tuning = sync.getSyncTuning();
        return resolveTranscriptRenderWindowProjection({
            activeThinkingMessageId: props.activeThinkingMessageId,
            entrySliceWindow,
            expandedToolCallsAnchorMessageIds,
            items: decomposedItems,
            listOrientation,
            platformOS: Platform.OS,
            resolveLiveTailAnchor: (items) => resolveTranscriptLiveTailAnchor({
                items,
                getMessageById: getTurnMessageById,
                thinkingFallbackMessageId: props.activeThinkingMessageId,
                turnActive: props.sessionThinking,
                sessionActive: props.sessionActive,
                latestCommittedActivityKey: props.latestCommittedActivityKey,
            }),
            resolveSeq: resolveTargetWindowItemSeq,
            sessionId: props.sessionId,
            targetWindowState: sessionTargetWindowState,
            transcriptNativeHotTailItemCount: tuning.transcriptNativeHotTailItemCount,
            transcriptWebHotTailItemCount: tuning.transcriptWebHotTailItemCount,
        });
    }, [
        decomposedItems,
        entrySliceWindow,
        expandedToolCallsAnchorMessageIds,
        getTurnMessageById,
        listOrientation,
        props.activeThinkingMessageId,
        props.latestCommittedActivityKey,
        props.sessionActive,
        props.sessionId,
        props.sessionThinking,
        resolveTargetWindowItemSeq,
        sessionTargetWindowState,
        sync,
    ]);
    const entrySliceSourceBounds = renderWindowProjection.entrySlice.bounds;
    entrySliceWithheldCountRef.current = renderWindowProjection.entrySlice.withheldCount;
    const targetWindowHostFacts = renderWindowProjection.targetWindow;
    const targetWindowActive = targetWindowHostFacts.targetWindowActive;
    targetWindowActiveRef.current = targetWindowActive;
    React.useEffect(() => {
        if (!targetWindowActive) {
            activeTargetWindowTargetRef.current = null;
        }
    }, [targetWindowActive]);
    const canonicalWindowedItems = renderWindowProjection.canonicalWindowedItems;
    const displayItems = renderWindowProjection.displayItems;
    const liveTailAnchor = renderWindowProjection.liveTailAnchor;
    const transcriptHotColdSegments = renderWindowProjection.hotCold;
    const transcriptHotColdSplitActive = transcriptHotColdSegments.active;
    const shouldUseWebHotColdSplit = Platform.OS === 'web' && transcriptHotColdSplitActive;
    const shouldUseNativeHotColdSplit = Platform.OS !== 'web' && transcriptHotColdSplitActive;
    const listData = renderWindowProjection.listData;
    React.useLayoutEffect(() => {
        if (!renderWindowProjection.nativeHotTailResetRequired) return;
        nativeHotTailHeightRef.current = 0;
    }, [renderWindowProjection.nativeHotTailResetRequired]);
    webHotColdCountsRef.current = {
        coldCount: transcriptHotColdSplitActive
            ? transcriptHotColdSegments.coldItems.length
            : listData.length,
        hotCount: transcriptHotColdSplitActive
            ? transcriptHotColdSegments.hotItems.length
            : 0,
    };
    liveTailCarveTelemetryRef.current = {
        active: shouldUseNativeHotColdSplit,
        anchorId: liveTailAnchor?.messageId ?? null,
        anchorKind: liveTailAnchor?.reason ?? null,
        coldCount: transcriptHotColdSegments.coldCount,
        hotCount: transcriptHotColdSegments.hotCount,
    };

    React.useEffect(() => {
        // A stale slice window from the previous session is already inert (sessionId
        // mismatch); release the state so the next entry starts clean.
        if (entrySliceWindow && entrySliceWindow.sessionId !== props.sessionId) {
            entrySliceWindowRef.current = null;
            setEntrySliceWindow(null);
        }
    }, [entrySliceWindow, props.sessionId]);

    React.useEffect(() => {
        if (props.jumpToSeq == null) return;
        if (entrySliceWindowRef.current?.sessionId !== props.sessionId) return;
        // An explicit jump owns the viewport: drop the slice window without a prepend
        // transaction — the jump's own write places the viewport next.
        entrySliceWindowRef.current = null;
        setEntrySliceWindow(null);
    }, [props.jumpToSeq, props.sessionId]);

    React.useEffect(() => {
        setFirstListPaintObserved(false);
        updateNativeViewportPaintObserved(false);
        updateNativeEntryRestorePaintReleased(false);
        nativeVisibleWindowSnapshotRef.current = null;
        lastNativeVisibleRowsSnapshotRef.current = null;
    }, [
        props.sessionId,
        updateNativeEntryRestorePaintReleased,
        updateNativeViewportPaintObserved,
    ]);

    canonicalWindowedItemsRef.current = canonicalWindowedItems;
    renderWindowIndexMapRef.current = renderWindowProjection.indexMap;
    nativeHotEdgeVisibleRowsRef.current = renderWindowProjection.hotCold.nativeEdgeSlotItems.length > 0
        ? {
            firstItemId: renderWindowProjection.hotCold.nativeEdgeSlotItems[0]?.id ?? null,
            firstSourceIndex: renderWindowProjection.indexMap.hotEdgeSourceIndices[0] ?? null,
            lastItemId: renderWindowProjection.hotCold.nativeEdgeSlotItems[renderWindowProjection.hotCold.nativeEdgeSlotItems.length - 1]?.id ?? null,
            lastSourceIndex: renderWindowProjection.indexMap.hotEdgeSourceIndices[renderWindowProjection.indexMap.hotEdgeSourceIndices.length - 1] ?? null,
        }
        : null;
    itemsRef.current = displayItems;
    listDataRef.current = listData;
    preDecompositionItemsRef.current = props.items;

    const transcriptNavigationRenderedSources = React.useMemo<TranscriptNavigationRenderedAnchorSource[]>(() => {
        const state = getStorage().getState();
        const session = state?.sessionMessages?.[props.sessionId];
        const stateMessagesById = (session?.messagesById ?? session?.messagesMap ?? {}) as Readonly<Record<string, Message>>;
        const reducerState = session?.reducerState ?? null;
        return listData.flatMap((item, sourceIndex) => {
            const messageIds = collectTranscriptNavigationMessageIdsForItem(item);
            const messages = messageIds.flatMap((messageId) => {
                const message = props.messagesById[messageId] ?? stateMessagesById[messageId] ?? null;
                if (!message) return [];
                return [{
                    messageId,
                    routeMessageId: buildSessionMessageRouteId({
                        messageId,
                        messagesById: { [messageId]: message },
                        reducerState,
                    }),
                    seq: typeof message.seq === 'number' && Number.isFinite(message.seq)
                        ? Math.trunc(message.seq)
                        : null,
                    transcriptBlockIndex:
                        typeof message.transcriptBlockIndex === 'number' && Number.isFinite(message.transcriptBlockIndex)
                            ? Math.trunc(message.transcriptBlockIndex)
                            : null,
                    role: transcriptNavigationRoleForMessage(message),
                }];
            });
            if (messages.length === 0) return [];
            return [{
                sourceIndex,
                messageIds,
                messages,
            }];
        });
    }, [listData, props.messagesById, props.sessionId]);
    const transcriptNavigationRuntimeAnchors = React.useMemo(
        () => deriveTranscriptNavigationRuntimeAnchors({
            entries: props.transcriptNavigationEntries,
            renderedSources: transcriptNavigationRenderedSources,
        }),
        [props.transcriptNavigationEntries, transcriptNavigationRenderedSources],
    );
    transcriptNavigationRuntimeAnchorsRef.current = transcriptNavigationRuntimeAnchors;
    const transcriptNavigationRailVisible = React.useMemo(() => deriveTranscriptNavigationRailLayout({
        entryCount: props.transcriptNavigationEntries.length,
        paneHeightPx: listLayoutHeight,
        paneWidthPx: listLayoutWidthPx,
        platformOS: Platform.OS === 'web' || Platform.OS === 'ios' || Platform.OS === 'android'
            ? Platform.OS
            : 'native-other',
        transcriptContentWidthPx: Math.min(listLayoutWidthPx, transcriptContentMaxWidth),
        transcriptMaxWidthPx: transcriptContentMaxWidth,
    }).visible, [
        listLayoutHeight,
        listLayoutWidthPx,
        props.transcriptNavigationEntries.length,
        transcriptContentMaxWidth,
    ]);
    // Panel-only mode hides the rail (width steal), so the pane's open state must
    // keep visibility observation alive for the panel's active-entry tracking.
    const transcriptNavigationPaneOpen = useTranscriptNavigationPaneOpen(props.sessionId);
    const transcriptNavigationVisibilitySnapshot = useTranscriptNavigationVisibilitySnapshot(props.sessionId, {
        enabled: transcriptNavigationRailVisible || transcriptNavigationPaneOpen,
    });
    const transcriptNavigationRailVisibilitySnapshot = React.useMemo(() => {
        const entryIds = new Set(props.transcriptNavigationEntries.map((entry) => entry.id));
        const currentAnchorId = transcriptNavigationVisibilitySnapshot.currentAnchorId &&
            entryIds.has(transcriptNavigationVisibilitySnapshot.currentAnchorId)
            ? transcriptNavigationVisibilitySnapshot.currentAnchorId
            : null;
        const visibleAnchorIds = transcriptNavigationVisibilitySnapshot.visibleAnchorIds.filter((id) => entryIds.has(id));
        return {
            currentAnchorId,
            visibleAnchorIds,
        };
    }, [props.transcriptNavigationEntries, transcriptNavigationVisibilitySnapshot]);

    React.useEffect(() => {
        recordStreamingVisibleUpdateForSessionUiTelemetry({
            sessionId: props.sessionId,
            latestMessageId: props.latestCommittedActivityKey,
            committedMessages: props.committedMessagesCount,
            transcriptLoaded: props.isLoaded ? 1 : 0,
            visibleItems: listData.length,
        });
    }, [
        listData.length,
        props.committedMessagesCount,
        props.isLoaded,
        props.latestCommittedActivityKey,
        props.sessionId,
    ]);

    React.useEffect(() => {
        return () => {
            clearStreamingSessionUiTelemetryMarks(props.sessionId);
            clearTranscriptNavigationVisibilityStore(props.sessionId);
        };
    }, [props.sessionId]);

    const hasRearmedNativeBottomFollow = React.useCallback((): boolean => (
        usesNativeFlashListBottomMaintenance &&
        bottomFollowModeStateRef.current.mode === 'following' &&
        wantsPinnedRef.current &&
        isPinnedRef.current
    ), [usesNativeFlashListBottomMaintenance]);
    const nativeEntryShouldUseBottomMaintenance =
        sessionEntryViewportRef.current?.shouldFollowBottom !== false;
    const frameTuning = sync.getSyncTuning();
    const configuredFlashListDrawDistance = frameTuning.transcriptFlashListDrawDistance;
    const telemetryPlatform = resolveTranscriptViewportTelemetryPlatform(Platform.OS);
    const resolveNativeVisibleWindowSnapshot = React.useCallback((): NativeVisibleWindowSnapshot => {
        const data = listDataRef.current;
        const layoutHeight = listLayoutHeightRef.current;
        const blankAreaPx = data.length > 0 && Number.isFinite(layoutHeight) && layoutHeight > 0
            ? Math.max(0, Math.trunc(layoutHeight))
            : 0;
        let visibleRangeReadStatus: TranscriptViewportTelemetryVisibleRangeReadStatus = 'null';
        const resolveLastKnownVisibleRowsSnapshot = (): NativeVisibleWindowSnapshot | null => {
            const snapshot = lastNativeVisibleRowsSnapshotRef.current;
            if (!snapshot?.hasVisibleRows) return null;
            const rowIds = new Set(data.map((item) => item.id));
            if (
                (snapshot.firstVisibleItemId && !rowIds.has(snapshot.firstVisibleItemId)) ||
                (snapshot.lastVisibleItemId && !rowIds.has(snapshot.lastVisibleItemId))
            ) {
                return null;
            }
            return snapshot;
        };
        const buildBlankSnapshot = (
            visibleWindowSource: TranscriptViewportTelemetryVisibleWindowSource,
            rangeFacts: Readonly<{
                firstVisibleRenderedIndex?: number;
                visibleRangeReadStatus?: TranscriptViewportTelemetryVisibleRangeReadStatus;
                visibleRenderedEndIndex?: number;
                visibleRenderedStartIndex?: number;
            }> = {},
        ): NativeVisibleWindowSnapshot => {
            const nativeHotEdgeRows = nativeHotEdgeVisibleRowsRef.current;
            if (nativeHotEdgeRows) {
                const rawOffsetY = readNativeAbsoluteScrollOffset(listRef.current);
                const distanceFromBottom = readCurrentNativeDistanceFromBottom();
                if (
                    (typeof rawOffsetY !== 'number' || rawOffsetY >= -64) &&
                    typeof distanceFromBottom === 'number' &&
                    distanceFromBottom <= pinThresholdPxRef.current
                ) {
                    const snapshot: NativeVisibleWindowSnapshot = {
                        blankAreaPx: 0,
                        blankAreaSource: 'none',
                        ...(rangeFacts.firstVisibleRenderedIndex !== undefined
                            ? { firstVisibleRenderedIndex: rangeFacts.firstVisibleRenderedIndex }
                            : {}),
                        firstVisibleItemId: nativeHotEdgeRows.firstItemId ?? undefined,
                        hasVisibleRows: true,
                        lastVisibleItemId: nativeHotEdgeRows.lastItemId ?? undefined,
                        ...(rangeFacts.visibleRangeReadStatus ? { visibleRangeReadStatus: rangeFacts.visibleRangeReadStatus } : {}),
                        ...(rangeFacts.visibleRenderedEndIndex !== undefined
                            ? { visibleRenderedEndIndex: rangeFacts.visibleRenderedEndIndex }
                            : {}),
                        ...(rangeFacts.visibleRenderedStartIndex !== undefined
                            ? { visibleRenderedStartIndex: rangeFacts.visibleRenderedStartIndex }
                            : {}),
                        visibleWindowSource: 'native-hot-edge-slot',
                    };
                    lastNativeVisibleRowsSnapshotRef.current = snapshot;
                    return snapshot;
                }
            }
            const lastKnownSnapshot = resolveLastKnownVisibleRowsSnapshot();
            if (lastKnownSnapshot) {
                return {
                    blankAreaPx,
                    blankAreaSource: 'index-estimate',
                    hasVisibleRows: false,
                    ...(rangeFacts.firstVisibleRenderedIndex !== undefined
                        ? { firstVisibleRenderedIndex: rangeFacts.firstVisibleRenderedIndex }
                        : {}),
                    lastKnownFirstVisibleItemId: lastKnownSnapshot.firstVisibleItemId,
                    lastKnownLastVisibleItemId: lastKnownSnapshot.lastVisibleItemId,
                    ...(rangeFacts.visibleRangeReadStatus ? { visibleRangeReadStatus: rangeFacts.visibleRangeReadStatus } : {}),
                    ...(rangeFacts.visibleRenderedEndIndex !== undefined
                        ? { visibleRenderedEndIndex: rangeFacts.visibleRenderedEndIndex }
                        : {}),
                    ...(rangeFacts.visibleRenderedStartIndex !== undefined
                        ? { visibleRenderedStartIndex: rangeFacts.visibleRenderedStartIndex }
                        : {}),
                    visibleWindowSource,
                    visibleWindowStale: true,
                };
            }
            return {
                blankAreaPx,
                blankAreaSource: 'index-estimate',
                ...(rangeFacts.firstVisibleRenderedIndex !== undefined
                    ? { firstVisibleRenderedIndex: rangeFacts.firstVisibleRenderedIndex }
                    : {}),
                hasVisibleRows: false,
                ...(rangeFacts.visibleRangeReadStatus ? { visibleRangeReadStatus: rangeFacts.visibleRangeReadStatus } : {}),
                ...(rangeFacts.visibleRenderedEndIndex !== undefined
                    ? { visibleRenderedEndIndex: rangeFacts.visibleRenderedEndIndex }
                    : {}),
                ...(rangeFacts.visibleRenderedStartIndex !== undefined
                    ? { visibleRenderedStartIndex: rangeFacts.visibleRenderedStartIndex }
                    : {}),
                visibleWindowSource,
            };
        };
        const buildSnapshotFromRange = (
            startIndex: number,
            endIndex: number,
            visibleWindowSource: TranscriptViewportTelemetryVisibleWindowSource,
        ): NativeVisibleWindowSnapshot | null => {
            if (!Number.isFinite(startIndex) || !Number.isFinite(endIndex)) return null;
            if (data.length === 0) {
                return {
                    blankAreaPx: 0,
                    blankAreaSource: 'none',
                    hasVisibleRows: false,
                    visibleRangeReadStatus: 'null',
                    visibleWindowSource,
                };
            }
            const normalizedStart = Math.trunc(startIndex);
            const normalizedEnd = Math.trunc(endIndex);
            const rangeFacts = {
                visibleRenderedEndIndex: normalizedEnd,
                visibleRenderedStartIndex: normalizedStart,
            };
            if (normalizedStart > normalizedEnd) {
                return buildBlankSnapshot(visibleWindowSource, {
                    ...rangeFacts,
                    firstVisibleRenderedIndex: normalizedStart,
                    visibleRangeReadStatus: 'reversed',
                });
            }
            const rangeOutOfBounds =
                normalizedStart < 0 ||
                normalizedEnd < 0 ||
                normalizedStart >= data.length ||
                normalizedEnd >= data.length;
            const clampedStart = Math.max(0, Math.min(data.length - 1, normalizedStart));
            const clampedEnd = Math.max(0, Math.min(data.length - 1, normalizedEnd));
            if (clampedStart > clampedEnd) {
                return buildBlankSnapshot(visibleWindowSource, {
                    ...rangeFacts,
                    firstVisibleRenderedIndex: normalizedStart,
                    visibleRangeReadStatus: 'out-of-range',
                });
            }
            const firstVisibleItemId = data[clampedStart]?.id;
            const lastVisibleItemId = data[clampedEnd]?.id;
            if (!firstVisibleItemId && !lastVisibleItemId) {
                return buildBlankSnapshot(visibleWindowSource, {
                    ...rangeFacts,
                    firstVisibleRenderedIndex: normalizedStart,
                    visibleRangeReadStatus: rangeOutOfBounds ? 'out-of-range' : 'ok',
                });
            }
            const snapshot: NativeVisibleWindowSnapshot = {
                blankAreaPx: 0,
                blankAreaSource: 'none',
                firstVisibleRenderedIndex: normalizedStart,
                firstVisibleItemId,
                hasVisibleRows: true,
                lastVisibleItemId,
                visibleRangeReadStatus: rangeOutOfBounds ? 'out-of-range' : 'ok',
                visibleRenderedEndIndex: normalizedEnd,
                visibleRenderedStartIndex: normalizedStart,
                visibleWindowSource,
            };
            lastNativeVisibleRowsSnapshotRef.current = snapshot;
            return snapshot;
        };

        try {
            const visibleIndices = listRef.current?.computeVisibleIndices?.();
            const snapshot = visibleIndices
                ? buildSnapshotFromRange(visibleIndices.startIndex, visibleIndices.endIndex, 'ref-compute')
                : null;
            if (snapshot) return snapshot;
        } catch {
            visibleRangeReadStatus = 'threw';
            // Fall through to the viewability/ref fallback; telemetry must not affect scrolling.
        }

        try {
            const firstVisibleIndex = listRef.current?.getFirstVisibleIndex?.();
            if (typeof firstVisibleIndex === 'number' && Number.isFinite(firstVisibleIndex)) {
                const snapshot = buildSnapshotFromRange(firstVisibleIndex, firstVisibleIndex, 'ref-first-index');
                if (snapshot) return snapshot;
            }
        } catch {
            // Fall through to the last viewability callback snapshot.
        }

        return nativeVisibleWindowSnapshotRef.current ?? {
            blankAreaPx,
            blankAreaSource: blankAreaPx > 0 ? 'index-estimate' : 'none',
            hasVisibleRows: false,
            visibleRangeReadStatus,
            visibleWindowSource: 'none',
        };
    }, [readCurrentNativeDistanceFromBottom]);

    const applyBlankRecoveryEffects = React.useCallback((effects: readonly TranscriptBlankRecoveryEffect[]): void => {
        for (const effect of effects) {
            if (effect.type === 'request-bottom-follow-write') {
                authorizeImmediateBottomFollowWriteRef.current(effect.writer, effect.reason);
                continue;
            }
            if (effect.type === 'request-anchor-restore') {
                attemptEntryRestoreRef.current();
            }
        }
    }, []);

    const resolveNativeTelemetryDiagnostics = React.useCallback((
        source: Readonly<Record<string, unknown>>,
    ): Record<string, unknown> => {
        if (Platform.OS === 'web') return {};
        const rawOffsetFromSource = readFiniteTelemetryNumber(source.rawOffsetY);
        const rawOffsetFromList = readNativeAbsoluteScrollOffset(listRef.current) ?? undefined;
        const rawOffsetY = rawOffsetFromSource ?? rawOffsetFromList;
        const eventLayoutHeight = readFiniteTelemetryNumber(source.layoutHeight);
        const eventContentHeight = readFiniteTelemetryNumber(source.contentHeight);
        const refLayoutHeight = readFiniteTelemetryNumber(listLayoutHeightRef.current);
        const refContentHeight = readFiniteTelemetryNumber(listContentHeightRef.current);
        const layoutHeight =
            eventLayoutHeight ?? refLayoutHeight;
        const contentHeight =
            eventContentHeight ?? refContentHeight;
        const observedOffset =
            rawOffsetY !== undefined &&
            layoutHeight !== undefined &&
            contentHeight !== undefined
                ? resolveNativeObservedScrollOffset(rawOffsetY, { contentHeight, layoutHeight })
                : null;
        const canonicalOffsetY =
            readFiniteTelemetryNumber(source.canonicalOffsetY)
            ?? observedOffset?.canonicalOffsetY
            ?? readFiniteTelemetryNumber(source.offsetY);
        const distanceFromBottom =
            readFiniteTelemetryNumber(source.distanceFromBottom)
            ?? observedOffset?.distanceFromLiveTailPx;
        const isAtRawBottom =
            readTelemetryBoolean(source.isAtRawBottom)
            ?? observedOffset?.isAtRawLiveTail;
        const visibleSnapshot = resolveNativeVisibleWindowSnapshot();
        const bottomFollowState = bottomFollowModeStateRef.current;
        const bottomFollowMode: TranscriptViewportTelemetryBottomFollowMode =
            bottomFollowState.mode === 'escaping' || bottomFollowState.mode === 'released'
                ? bottomFollowState.mode
                : 'following';
        const listDataLength = listDataRef.current.length;
        const fullItemCount = itemsRef.current.length;
        const carveTelemetry = liveTailCarveTelemetryRef.current;
        const coldCount = carveTelemetry.active ? carveTelemetry.coldCount : listDataLength;
        const hotCount = carveTelemetry.active ? carveTelemetry.hotCount : 0;
        const entryRestoreState: TranscriptViewportTelemetryTransactionState =
            entryRestoreOwner.telemetryState(props.sessionId);
        const prependState: TranscriptViewportTelemetryTransactionState =
            nativePrependOwner.telemetryState(props.sessionId);
        const nativeBlankWindowSignature: TranscriptViewportTelemetryNativeBlankWindowSignature | undefined =
            visibleSnapshot.hasVisibleRows === false &&
            listDataLength > 0 &&
            layoutHeight !== undefined &&
            contentHeight !== undefined &&
            layoutHeight > 0 &&
            contentHeight > layoutHeight &&
            visibleSnapshot.blankAreaPx > 0
                ? 'empty-visible-window'
                : undefined;
        const recoveryPlan = planTranscriptBlankRecoveryObservation(blankRecoveryStateRef.current, {
            bottomFollowMode,
            contentPresent: listDataLength > 0,
            entryRestoreOpen: entryRestoreState === 'open',
            gestureActive:
                bottomFollowWriteSchedulerStateRef.current.gestureActive ||
                nativeMomentumScrollActiveRef.current ||
                bottomFollowState.dragSession !== null,
            hasVisibleRows: visibleSnapshot.hasVisibleRows,
            nowMs: Date.now(),
            observationReason: source.reason === 'invalid-native-offset' ? 'invalid-native-offset' : undefined,
            prependOpen: prependState === 'open',
            rawOffsetY,
            sessionId: props.sessionId,
        });
        blankRecoveryStateRef.current = recoveryPlan.state;
        applyBlankRecoveryEffects(recoveryPlan.effects);
        const layoutCacheClearState: TranscriptViewportTelemetryLayoutCacheClearState = 'idle';
        const layoutCacheClearReason: TranscriptViewportTelemetryLayoutCacheClearReason = 'none';
        const scrollToIndexFailureState: TranscriptViewportTelemetryScrollToIndexFailureState = 'none';

        return {
            orientation: 'inverted',
            ...(rawOffsetY !== undefined ? { rawOffsetY } : {}),
            ...(canonicalOffsetY !== undefined ? { canonicalOffsetY } : {}),
            ...(layoutHeight !== undefined ? { layoutHeight } : {}),
            ...(contentHeight !== undefined ? { contentHeight } : {}),
            ...(eventLayoutHeight !== undefined ? { eventLayoutHeight } : {}),
            ...(eventContentHeight !== undefined ? { eventContentHeight } : {}),
            ...(refLayoutHeight !== undefined ? { refLayoutHeight } : {}),
            ...(refContentHeight !== undefined ? { refContentHeight } : {}),
            ...(distanceFromBottom !== undefined ? { distanceFromBottom } : {}),
            bottomFollowMode,
            dragSessionTrusted: bottomFollowState.dragSession?.trusted === true,
            nativeMomentumActive: nativeMomentumScrollActiveRef.current,
            mvcpPolicy: nativeFlashListMvcpPolicyRef.current,
            pauseOffsetCorrection: nativeFlashListPauseOffsetCorrectionRef.current,
            ...(isAtRawBottom !== undefined ? { isAtRawBottom } : {}),
            hasVisibleRows: visibleSnapshot.hasVisibleRows,
            ...(visibleSnapshot.firstVisibleItemId ? { firstVisibleItemId: visibleSnapshot.firstVisibleItemId } : {}),
            ...(visibleSnapshot.lastVisibleItemId ? { lastVisibleItemId: visibleSnapshot.lastVisibleItemId } : {}),
            ...(visibleSnapshot.firstVisibleRenderedIndex !== undefined
                ? { firstVisibleRenderedIndex: visibleSnapshot.firstVisibleRenderedIndex }
                : {}),
            ...(visibleSnapshot.visibleRangeReadStatus
                ? { visibleRangeReadStatus: visibleSnapshot.visibleRangeReadStatus }
                : {}),
            ...(visibleSnapshot.visibleRenderedStartIndex !== undefined
                ? { visibleRenderedStartIndex: visibleSnapshot.visibleRenderedStartIndex }
                : {}),
            ...(visibleSnapshot.visibleRenderedEndIndex !== undefined
                ? { visibleRenderedEndIndex: visibleSnapshot.visibleRenderedEndIndex }
                : {}),
            ...(visibleSnapshot.visibleWindowStale ? { visibleWindowStale: true } : {}),
            ...(visibleSnapshot.lastKnownFirstVisibleItemId ? { lastKnownFirstVisibleItemId: visibleSnapshot.lastKnownFirstVisibleItemId } : {}),
            ...(visibleSnapshot.lastKnownLastVisibleItemId ? { lastKnownLastVisibleItemId: visibleSnapshot.lastKnownLastVisibleItemId } : {}),
            blankAreaPx: visibleSnapshot.blankAreaPx,
            blankAreaSource: visibleSnapshot.blankAreaSource,
            visibleWindowSource: visibleSnapshot.visibleWindowSource,
            ...(nativeBlankWindowSignature ? { nativeBlankWindowSignature } : {}),
            listDataLength,
            fullItemCount,
            coldCount,
            hotCount,
            entryRestoreState,
            prependState,
            layoutCacheClearState,
            layoutCacheClearReason,
            scrollToIndexFailureState,
        };
    }, [
        props.sessionId,
        resolveNativeVisibleWindowSnapshot,
        resolveNativeObservedScrollOffset,
    ]);
    const resolveViewportTelemetryMode = React.useCallback((mode?: TranscriptViewportMode): TranscriptViewportMode => {
        return mode ?? (wantsPinnedRef.current ? 'follow-bottom' : 'user-unpinned');
    }, []);
    const recordViewportTelemetryEvent = React.useCallback((
        event: Readonly<Record<string, unknown> & {
            mode: TranscriptViewportMode;
            type: TranscriptViewportTelemetryEvent['type'];
        }>,
        options?: Readonly<{ sessionId?: string }>,
    ) => {
        const tuning = resolveEnabledViewportTelemetryTuning();
        if (!tuning) return;
        const nativeDiagnostics = resolveNativeTelemetryDiagnostics(event);
        recordTranscriptViewportTelemetryEvent({
            ...event,
            ...nativeDiagnostics,
            sessionId: options?.sessionId ?? props.sessionId,
            platform: telemetryPlatform,
            listImplementation: 'flash_v2',
            timestampMs: Date.now(),
        }, tuning);
    }, [
        props.sessionId,
        resolveEnabledViewportTelemetryTuning,
        resolveNativeTelemetryDiagnostics,
        telemetryPlatform,
    ]);
    const recordRestoreDecisionTelemetry = React.useCallback((
        reason: TranscriptViewportTelemetryObservationReason,
        params: Readonly<{
            anchorCorrectionAttempt?: number;
            anchorCorrectionTargetOffsetY?: number;
            anchorDeltaPx?: number;
            anchorIndex?: number;
            anchorItemOffsetPx?: number;
            anchorObservedItemOffsetPx?: number;
            anchorRestoreViewOffset?: number;
            contentHeight?: number;
            distanceFromBottom?: number;
            layoutHeight?: number;
            mode?: TranscriptViewportMode;
            offsetY?: number;
            programmaticWebWrite?: boolean;
            scrollable?: boolean;
            webTrigger?: 'scroll' | 'edge-reached' | 'restore' | 'prepend-restore' | 'jump';
        }> = {},
    ) => {
        const webMetrics = Platform.OS === 'web' ? resolveWebScrollMetrics() : null;
        recordViewportTelemetryEvent({
            type: 'restore-decision',
            mode: resolveViewportTelemetryMode(params.mode ?? 'restore-distance'),
            reason,
            offsetY: params.offsetY,
            layoutHeight: params.layoutHeight,
            contentHeight: params.contentHeight,
            distanceFromBottom: params.distanceFromBottom,
            anchorIndex: params.anchorIndex,
            anchorItemOffsetPx: params.anchorItemOffsetPx,
            anchorObservedItemOffsetPx: params.anchorObservedItemOffsetPx,
            anchorDeltaPx: params.anchorDeltaPx,
            anchorCorrectionAttempt: params.anchorCorrectionAttempt,
            anchorCorrectionTargetOffsetY: params.anchorCorrectionTargetOffsetY,
            anchorRestoreViewOffset: params.anchorRestoreViewOffset,
            ...(Platform.OS === 'web' ? resolveWebViewportTelemetryDiagnostics({
                metrics: webMetrics,
                flashListContentHeight: params.contentHeight,
                flashListLayoutHeight: params.layoutHeight,
                programmaticWebWrite: params.programmaticWebWrite ?? false,
                scrollable: params.scrollable,
                trigger: params.webTrigger ?? (params.mode === 'jump-to-bottom' ? 'jump' : 'restore'),
            }) : {}),
        });
    }, [
        recordViewportTelemetryEvent,
        resolveViewportTelemetryMode,
        resolveWebScrollMetrics,
        resolveWebViewportTelemetryDiagnostics,
    ]);

    const recordScrollObservedTelemetry = React.useCallback((
        params: Readonly<{
            contentHeight?: number;
            distanceFromBottom: number;
            layoutHeight?: number;
            offsetY: number;
            rawOffsetY?: number;
            canonicalOffsetY?: number;
            reason?: TranscriptViewportTelemetryObservationReason;
        }>,
    ) => {
        recordViewportTelemetryEvent({
            type: 'scroll-observed',
            mode: resolveViewportTelemetryMode(),
            reason: params.reason ?? 'observed',
            offsetY: params.offsetY,
            rawOffsetY: params.rawOffsetY,
            canonicalOffsetY: params.canonicalOffsetY,
            layoutHeight: params.layoutHeight,
            contentHeight: params.contentHeight,
            distanceFromBottom: params.distanceFromBottom,
        });
    }, [recordViewportTelemetryEvent, resolveViewportTelemetryMode]);

    const recordNativeVisibleWindowTelemetry = React.useCallback((
        reason: TranscriptViewportTelemetryObservationReason = 'observed',
        params: Readonly<{
            canonicalOffsetY?: number;
            contentHeight?: number;
            distanceFromBottom?: number;
            layoutHeight?: number;
            rawOffsetY?: number;
        }> = {},
    ) => {
        if (Platform.OS === 'web') return;
        const tuning = sync.getSyncTuning();
        configureTranscriptViewportTelemetryFromTuning(tuning);
        if (!transcriptViewportTelemetry.isEnabled()) return;
        const rawOffsetY = params.rawOffsetY ?? readNativeAbsoluteScrollOffset(listRef.current) ?? undefined;
        const layoutHeight = params.layoutHeight ?? listLayoutHeightRef.current;
        const contentHeight = params.contentHeight ?? listContentHeightRef.current;
        const observedOffset = rawOffsetY !== undefined
            ? resolveNativeObservedScrollOffset(rawOffsetY, { contentHeight, layoutHeight })
            : null;
        const canonicalOffsetY =
            params.canonicalOffsetY ?? observedOffset?.canonicalOffsetY;
        const distanceFromBottom =
            params.distanceFromBottom ?? observedOffset?.distanceFromLiveTailPx;
        const visibleSourceRange = readViewportVisibleSourceRange();
        recordViewportTelemetryEvent({
            type: 'visible-window-observed',
            mode: resolveViewportTelemetryMode(),
            reason,
            rawOffsetY,
            canonicalOffsetY,
            offsetY: canonicalOffsetY,
            layoutHeight,
            contentHeight,
            distanceFromBottom,
            firstVisibleSourceIndex: visibleSourceRange?.firstSourceIndex,
            lastVisibleSourceIndex: visibleSourceRange?.lastSourceIndex,
        });
    }, [
        recordViewportTelemetryEvent,
        readViewportVisibleSourceRange,
        resolveNativeObservedScrollOffset,
        resolveViewportTelemetryMode,
    ]);

    const handleNativeViewableItemsChanged = React.useCallback((info: Readonly<{
        viewableItems?: readonly NativeViewableTranscriptItem[];
    }>) => {
        if (Platform.OS === 'web') return;
        const viewableItems = Array.isArray(info.viewableItems) ? info.viewableItems : [];
        const visibilityStore = getTranscriptNavigationVisibilityStore(props.sessionId);
        if (transcriptNavigationRuntimeAnchors.length > 0 && visibilityStore.hasSubscribers()) {
            visibilityStore.set(deriveNativeTranscriptVisibleAnchorFacts({
                anchors: transcriptNavigationRuntimeAnchors,
                itemCount: listDataRef.current.length,
                orientation: listOrientation,
                preferUserTurnAnchor: true,
                viewableItems,
            }));
        } else if (visibilityStore.hasSubscribers()) {
            visibilityStore.set(null);
        }
        const tuning = sync.getSyncTuning();
        configureTranscriptViewportTelemetryFromTuning(tuning);
        if (!transcriptViewportTelemetry.isEnabled()) return;
        const visibleItems = viewableItems
            .filter((item) => item.isViewable !== false)
            .sort((left, right) => (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER));
        const first = visibleItems[0];
        const last = visibleItems[visibleItems.length - 1];
        const layoutHeight = listLayoutHeightRef.current;
        const blankAreaPx =
            visibleItems.length === 0 &&
            listDataRef.current.length > 0 &&
            Number.isFinite(layoutHeight) &&
            layoutHeight > 0
                ? Math.max(0, Math.trunc(layoutHeight))
                : 0;
        nativeVisibleWindowSnapshotRef.current = {
            blankAreaPx,
            blankAreaSource: blankAreaPx > 0 ? 'index-estimate' : 'none',
            firstVisibleItemId: first?.item?.id,
            hasVisibleRows: visibleItems.length > 0,
            lastVisibleItemId: last?.item?.id,
            visibleWindowSource: 'viewability-callback',
        };
        if (nativeVisibleWindowSnapshotRef.current.hasVisibleRows) {
            lastNativeVisibleRowsSnapshotRef.current = nativeVisibleWindowSnapshotRef.current;
        }
        recordNativeVisibleWindowTelemetry('observed');
    }, [
        listOrientation,
        props.sessionId,
        recordNativeVisibleWindowTelemetry,
        transcriptNavigationRuntimeAnchors,
    ]);

    const shouldAttachNativeViewabilityTelemetry =
        Platform.OS !== 'web' &&
        sync.getSyncTuning().transcriptViewportTelemetryEnabled === true;
    const shouldAttachNativeViewability =
        Platform.OS !== 'web' &&
        (shouldAttachNativeViewabilityTelemetry || (
            transcriptNavigationRuntimeAnchors.length > 0 &&
            getTranscriptNavigationVisibilityStore(props.sessionId).hasSubscribers()
        ));
    const nativeViewabilityConfig = React.useMemo(() => (
        shouldAttachNativeViewability
            ? { itemVisiblePercentThreshold: 1 }
            : undefined
    ), [shouldAttachNativeViewability]);

    // ---- N1 evidence wiring (dev-gated telemetry only; zero product behavior) ----
    // Row identity state for N1.2/N1.3: last measured height and last content count per row id,
    // plus a lazy index lookup over the current list data for viewport-relation geometry.
    const rowEvidenceHeightsRef = React.useRef(new Map<string, number>());
    const rowEvidenceContentCountsRef = React.useRef(new Map<string, number>());
    const rowEvidenceIndexLookupRef = React.useRef<{
        data: readonly ChatTranscriptListItem[];
        indexById: Map<string, number>;
    } | null>(null);
    React.useEffect(() => {
        rowEvidenceHeightsRef.current.clear();
        rowEvidenceContentCountsRef.current.clear();
        rowEvidenceIndexLookupRef.current = null;
    }, [props.sessionId]);
    const isViewportEvidenceTelemetryEnabled = React.useCallback((): boolean => {
        // The telemetry singleton is reconfigured on every record call; refresh it here too so
        // the gate observes CDP debug overrides armed after the last recorded event.
        configureTranscriptViewportTelemetryFromTuning(sync.getSyncTuning());
        return transcriptViewportTelemetry.isEnabled();
    }, []);
    const resolveRowEvidenceViewportRelation = React.useCallback((itemId: string) => {
        const data = listDataRef.current;
        let lookup = rowEvidenceIndexLookupRef.current;
        if (!lookup || lookup.data !== data) {
            const indexById = new Map<string, number>();
            for (let i = 0; i < data.length; i += 1) {
                const item = data[i];
                if (item) indexById.set(item.id, i);
            }
            lookup = { data, indexById };
            rowEvidenceIndexLookupRef.current = lookup;
        }
        const index = lookup.indexById.get(itemId);
        const layout = index === undefined ? undefined : listRef.current?.getLayout?.(index);
        return resolveTranscriptRowViewportRelation({
            rowTopY: layout?.y,
            rowHeightPx: layout?.height,
            scrollOffsetY: readNativeAbsoluteScrollOffset(listRef.current) ?? undefined,
            viewportHeightPx: listLayoutHeightRef.current,
        });
    }, []);
    const handleRowShellMeasured = React.useCallback((params: Readonly<{
        itemId: string;
        rowKind: string;
        heightPx: number;
    }>) => {
        if (!isViewportEvidenceTelemetryEnabled()) return;
        const previousHeightPx = rowEvidenceHeightsRef.current.get(params.itemId);
        rowEvidenceHeightsRef.current.set(params.itemId, params.heightPx);
        // Same-height re-layouts are not visual deltas; record first measures and changes only.
        if (previousHeightPx === params.heightPx) return;
        recordViewportTelemetryEvent({
            type: 'row-measured',
            mode: resolveViewportTelemetryMode(),
            rowId: params.itemId,
            rowKind: params.rowKind,
            rowHeightPx: params.heightPx,
            rowPreviousHeightPx: previousHeightPx,
            rowDeltaPx: previousHeightPx === undefined ? undefined : params.heightPx - previousHeightPx,
            rowMeasurePhase: previousHeightPx === undefined ? 'first' : 'remeasure',
            rowViewportRelation: resolveRowEvidenceViewportRelation(params.itemId),
        });
    }, [
        isViewportEvidenceTelemetryEnabled,
        recordViewportTelemetryEvent,
        resolveRowEvidenceViewportRelation,
        resolveViewportTelemetryMode,
    ]);
    React.useEffect(() => {
        measurementHost.advanceLayoutInvalidationCommitToken();
    });
    const applyTranscriptMeasurementHostEffects = React.useCallback((
        effects: readonly TranscriptMeasurementHostEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.type === 'clear-layout-cache') {
                const list = listRef.current;
                list?.clearLayoutCacheOnUpdate?.();
            }
        }
    }, []);
    const handleRowLayoutMutation = React.useCallback((params: Readonly<{
        itemId: string;
        mutation: TranscriptRowLayoutMutation;
        rowKind: string;
    }>) => {
        const result = measurementHost.observeRowLayoutMutation({
            mutation: params.mutation,
            viewportTransactionOpen:
                hasOpenNativePrependTransactionForSession() || hasOpenEntryRestoreTransactionForSession(),
        });
        applyTranscriptMeasurementHostEffects(result.effects);
    }, [
        applyTranscriptMeasurementHostEffects,
        hasOpenEntryRestoreTransactionForSession,
        hasOpenNativePrependTransactionForSession,
        measurementHost,
    ]);
    React.useEffect(() => {
        // N1.1 + N2d.1: one always-on subscription to the patched FlashList offset corrector.
        // Production consumer: the open prepend transaction's corrector-deference signal —
        // applied corrections accumulate on the transaction so the observation can classify a
        // corrector-covered commit as mvcp-preserved instead of double-correcting. Dev/QA
        // consumer: viewport telemetry (gated per event at the listener level).
        if (Platform.OS === 'web') return undefined;
        return subscribeToFlashListOffsetCorrections((event) => {
            if (event.type === 'correction-applied' && typeof event.diffPx === 'number') {
                applyNativePrependOwnerEffectsRef.current(nativePrependOwner.recordCorrectorCorrection({
                    diffPx: event.diffPx,
                    sessionId: props.sessionId,
                }));
            }
            if (!isViewportEvidenceTelemetryEnabled()) return;
            recordViewportTelemetryEvent({
                type: 'offset-correction',
                mode: resolveViewportTelemetryMode(),
                correctionAction: event.type,
                correctionSource: event.source,
                correctionDiffPx: event.diffPx,
            });
        });
    }, [
        isViewportEvidenceTelemetryEnabled,
        nativePrependOwner,
        props.sessionId,
        recordViewportTelemetryEvent,
        resolveViewportTelemetryMode,
    ]);

    const hasWebPrependRestoreWindow = React.useCallback((): boolean => {
        if (Platform.OS !== 'web') return false;
        return webPrependOwner.hasRestoreWindow();
    }, [webPrependOwner]);

    const viewportDriverDeps = React.useMemo<TranscriptViewportDriverDeps>(() => ({
            listRef,
            listContentHeightRef,
            listLayoutHeightRef,
            listDataRef,
            itemsRef,
            composerInsetHeightRef,
            nativeHotTailHeightRef,
            lastPinOffsetForIntentRef,
            lastNativePinOffsetRef,
            webDomObservation,
            lastNativeRestoreIndexCommandRef,
            nativeMountSettleStable,
            telemetryPlatform,
            shouldUseNativeHotColdSplit,
            webHotColdCountsRef,
            clearWebPrependRangeReserve,
            resolveRestoreAnchorIndex: (anchor) => resolveRestoreAnchorIndexForCommandRef.current(anchor),
            resolveJumpToSeqIndex: (seq, routeMessageId, transcriptBlockIndex, role) => (
                resolveJumpToSeqIndexForCommandRef.current(seq, routeMessageId, transcriptBlockIndex, role)
            ),
            resolveWebScrollMetrics,
            recordViewportTelemetryEvent,
            recordRestoreDecisionTelemetry,
            resolveWebViewportTelemetryDiagnostics,
            resolveInvertedBottomPinCarveTelemetryFields,
        }), [
            clearWebPrependRangeReserve,
            nativeMountSettleStable,
            recordRestoreDecisionTelemetry,
            recordViewportTelemetryEvent,
            resolveInvertedBottomPinCarveTelemetryFields,
            resolveWebViewportTelemetryDiagnostics,
            resolveWebScrollMetrics,
            shouldUseNativeHotColdSplit,
            telemetryPlatform,
            webDomObservation,
        ]);

    const commandHost = React.useMemo(() => createTranscriptViewportCommandHost({
        controller: viewportCommandController,
        driverDeps: viewportDriverDeps,
        hasWebPrependRestoreWindow,
        isWeb: () => Platform.OS === 'web',
    }), [
        hasWebPrependRestoreWindow,
        viewportCommandController,
        viewportDriverDeps,
    ]);

    const resolveViewportCommand = React.useCallback((input: TranscriptViewportControllerInput): TranscriptViewportCommand => {
        return commandHost.resolve(input);
    }, [commandHost]);

    const executeViewportCommand = React.useCallback((command: TranscriptViewportCommand): boolean => {
        return commandHost.execute(command);
    }, [commandHost]);

    const executeViewportCommandWithAnimation = React.useCallback((
        command: TranscriptViewportCommand,
        animated: boolean,
    ): boolean => {
        return commandHost.executeWithAnimation(command, animated);
    }, [commandHost]);

    const applyNativeExplicitJumpConfirmationEffects = React.useCallback((
        effects: readonly NativeExplicitJumpConfirmationEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== props.sessionId) {
                continue;
            }
            if (effect.type === 'adopt-live-tail-arrival') {
                adoptNativeFollowingForTrustedBottomArrival(effect.distanceFromBottom);
                continue;
            }
            if (effect.type === 'issue-reconfirm-jump-to-bottom') {
                executeViewportCommandWithAnimation(resolveViewportCommand({
                    type: 'jump-to-bottom',
                    sessionId: props.sessionId,
                }), false);
            }
        }
    }, [
        adoptNativeFollowingForTrustedBottomArrival,
        executeViewportCommandWithAnimation,
        props.sessionId,
        resolveViewportCommand,
    ]);

    const resolveNativePrependObservationInput = React.useCallback((sessionId: string): NativePrependObservationInput => {
        const node = listRef.current;
        const absoluteScrollOffset = readNativeAbsoluteScrollOffset(node) ?? Number.NaN;
        return {
            activeOwner: viewportCommandController.activeOwner(),
            nowMs: Date.now(),
            postCommit: {
                absoluteScrollOffset,
                contentHeight: listContentHeightRef.current,
                getLayout: (index: number) => {
                    try {
                        return node?.getLayout?.(index) ?? undefined;
                    } catch {
                        return undefined;
                    }
                },
                items: listDataRef.current,
                layoutHeight: listLayoutHeightRef.current,
            },
            sessionId,
        };
    }, [viewportCommandController]);

    const applyNativePrependOwnerEffects = React.useCallback((
        effects: readonly NativePrependOwnerEffect[],
    ) => {
        for (const effect of effects) {
            switch (effect.type) {
                case 'preempt-entry-restore-for-prepend':
                    preemptEntryRestoreTransaction();
                    break;
                case 'open-prepend-ownership': {
                    const openResult = viewportCommandController.openTransaction('prepend');
                    if (!openResult.opened) {
                        applyNativePrependOwnerEffectsRef.current(nativePrependOwner.invalidate({
                            activeOwner: viewportCommandController.activeOwner(),
                            reason: 'ownership-rejected',
                            sessionId: effect.sessionId,
                        }));
                    }
                    break;
                }
                case 'close-prepend-ownership':
                    if (viewportCommandController.activeOwner() === 'prepend') {
                        viewportCommandController.closeTransaction('prepend', effect.outcome);
                    }
                    break;
                case 'execute-command':
                    executeViewportCommand(resolveViewportCommand(effect.command));
                    break;
                case 'schedule-layout-timeout': {
                    const existing = nativePrependLayoutTimerRef.current;
                    if (existing != null) clearTimeout(existing);
                    nativePrependLayoutTimerRef.current = setTimeout(() => {
                        nativePrependLayoutTimerRef.current = null;
                        applyNativePrependOwnerEffectsRef.current(nativePrependOwner.runLayoutTimeout(
                            resolveNativePrependObservationInput(effect.sessionId),
                        ));
                    }, effect.delayMs);
                    break;
                }
                case 'clear-layout-timeout': {
                    const existing = nativePrependLayoutTimerRef.current;
                    if (existing != null) {
                        nativePrependLayoutTimerRef.current = null;
                        clearTimeout(existing);
                    }
                    break;
                }
                case 'schedule-quiet-reobserve': {
                    const existing = nativePrependQuietReobserveTimerRef.current;
                    if (existing != null) clearTimeout(existing);
                    nativePrependQuietReobserveTimerRef.current = setTimeout(() => {
                        nativePrependQuietReobserveTimerRef.current = null;
                        applyNativePrependOwnerEffectsRef.current(nativePrependOwner.runQuietReobserve(
                            resolveNativePrependObservationInput(effect.sessionId),
                        ));
                    }, effect.delayMs);
                    break;
                }
                case 'clear-quiet-reobserve': {
                    const existing = nativePrependQuietReobserveTimerRef.current;
                    if (existing != null) {
                        nativePrependQuietReobserveTimerRef.current = null;
                        clearTimeout(existing);
                    }
                    break;
                }
                case 'schedule-corrector-reobserve': {
                    const existing = nativePrependCorrectorReobserveTimerRef.current;
                    if (existing != null) clearTimeout(existing);
                    nativePrependCorrectorReobserveTimerRef.current = setTimeout(() => {
                        nativePrependCorrectorReobserveTimerRef.current = null;
                        applyNativePrependOwnerEffectsRef.current(nativePrependOwner.runCorrectorReobserve(
                            resolveNativePrependObservationInput(effect.sessionId),
                        ));
                    }, effect.delayMs);
                    break;
                }
                case 'clear-corrector-reobserve': {
                    const existing = nativePrependCorrectorReobserveTimerRef.current;
                    if (existing != null) {
                        nativePrependCorrectorReobserveTimerRef.current = null;
                        clearTimeout(existing);
                    }
                    break;
                }
                case 'bump-transaction-revision':
                    bumpNativePrependTransactionRevision();
                    break;
                case 'record-restore-decision-for-session':
                    recordViewportTelemetryEvent({
                        type: 'restore-decision',
                        mode: effect.mode,
                        reason: effect.reason,
                        anchorItemOffsetPx: effect.anchorItemOffsetPx,
                        anchorDeltaPx: effect.anchorDeltaPx,
                        correctorAppliedDiffTotalPx: effect.correctorAppliedDiffTotalPx,
                        correctorEventCount: effect.correctorEventCount,
                    }, { sessionId: effect.sessionId });
                    break;
            }
        }
    }, [
        executeViewportCommand,
        nativePrependOwner,
        preemptEntryRestoreTransaction,
        recordViewportTelemetryEvent,
        resolveNativePrependObservationInput,
        resolveViewportCommand,
        viewportCommandController,
    ]);
    applyNativePrependOwnerEffectsRef.current = applyNativePrependOwnerEffects;

    const restoreWebPrependAnchorThroughViewportCommand = React.useCallback((
        anchor: WebTranscriptPrependAnchor,
    ): WebTranscriptPrependRestoreResult => {
        return commandHost.restoreWebPrependAnchor({
            anchor,
            sessionId: props.sessionId,
        });
    }, [
        commandHost,
        props.sessionId,
    ]);

    const resolveWebPrependRefreshOptions = React.useCallback((strategy: 'anchor' | 'item' | 'growth' | 'none') => {
        if (strategy === 'anchor') {
            return { adoptCurrentAnchorPosition: true, recaptureAnchor: true, recaptureItem: true } as const;
        }
        if (strategy === 'item') {
            return { adoptCurrentAnchorPosition: true, recaptureItem: true } as const;
        }
        return { preserveBaselineMetrics: true } as const;
    }, []);

    const applyWebPrependOwnerEffects = React.useCallback((
        effects: readonly WebPrependOwnerEffect[],
    ) => {
        for (const effect of effects) {
            switch (effect.type) {
                case 'execute-web-prepend-restore': {
                    const restoreResult = restoreWebPrependAnchorThroughViewportCommand(effect.anchor);
                    const metrics = resolveWebScrollMetrics();
                    const refreshedAnchor = metrics
                        ? refreshWebTranscriptPrependAnchor(
                            effect.anchor,
                            metrics,
                            resolveWebPrependRefreshOptions(restoreResult.strategy),
                        )
                        : null;
                    const acceptEffects = webPrependOwner.acceptRestoreResult({
                        currentMetrics: metrics,
                        nowMs: Date.now(),
                        refreshedAnchor,
                        result: restoreResult,
                        sessionId: effect.sessionId,
                    });
                    applyWebPrependOwnerEffectsRef.current(acceptEffects);
                    break;
                }
                case 'execute-anchor-recovery':
                    executeViewportCommand(resolveViewportCommand({
                        type: 'restore-anchor',
                        sessionId: effect.sessionId,
                        reason: 'prepend-restore',
                        anchor: effect.anchor,
                        itemOffsetPx: effect.itemOffsetPx,
                        animated: false,
                    }));
                    break;
                case 'preempt-entry-restore-for-prepend':
                    preemptEntryRestoreTransaction();
                    break;
                case 'open-prepend-ownership': {
                    const openResult = viewportCommandController.openTransaction('prepend');
                    if (!openResult.opened) {
                        applyWebPrependOwnerEffectsRef.current(webPrependOwner.clear({
                            outcome: 'abandoned-identity',
                            sessionId: effect.sessionId,
                        }));
                    }
                    break;
                }
                case 'close-prepend-ownership':
                    closeWebPrependViewportOwnership(effect.outcome);
                    break;
                case 'set-web-range-reserve':
                    setWebPrependRangeReservePx((previous) => previous === effect.reservePx ? previous : effect.reservePx);
                    break;
                case 'clear-web-range-reserve':
                    clearWebPrependRangeReserve();
                    break;
                case 'schedule-web-restore-expiry': {
                    cancelWebPrependRestoreWindowExpiry();
                    const arm = (expiresAtMs: number) => {
                        const delayMs = Math.max(0, Math.ceil(expiresAtMs - Date.now())) + 1;
                        webPrependRestoreExpiryTimerRef.current = setTimeout(() => {
                            webPrependRestoreExpiryTimerRef.current = null;
                            applyWebPrependOwnerEffectsRef.current(webPrependOwner.expire({ nowMs: Date.now() }));
                        }, delayMs);
                    };
                    arm(effect.expiresAtMs);
                    break;
                }
                case 'clear-web-restore-expiry':
                    cancelWebPrependRestoreWindowExpiry();
                    break;
                case 'schedule-web-index-recovery': {
                    if (webPrependIndexRecoveryScheduleRef.current) break;
                    const scheduleTimeoutRecovery = (delayMs: number) => {
                        const handle: { kind: 'timeout'; ids: any[] } = { kind: 'timeout', ids: [] };
                        webPrependIndexRecoveryScheduleRef.current = handle;
                        const timeoutId = setTimeout(() => {
                            if (webPrependIndexRecoveryScheduleRef.current !== handle) return;
                            webPrependIndexRecoveryScheduleRef.current = null;
                            webPrependIndexRecoveryRunningRef.current = true;
                            try {
                                runWebPrependIndexRecoveryRef.current();
                            } finally {
                                webPrependIndexRecoveryRunningRef.current = false;
                            }
                        }, delayMs);
                        handle.ids.push(timeoutId);
                    };
                    if (webPrependIndexRecoveryRunningRef.current) {
                        scheduleTimeoutRecovery(TRANSCRIPT_WEB_PREPEND_INDEX_RECOVERY_RETRY_MS);
                        break;
                    }
                    if (typeof requestAnimationFrame === 'function') {
                        const handle: { kind: 'raf'; ids: any[] } = { kind: 'raf', ids: [] };
                        webPrependIndexRecoveryScheduleRef.current = handle;
                        const first = requestAnimationFrame(() => {
                            const second = requestAnimationFrame(() => {
                                if (webPrependIndexRecoveryScheduleRef.current !== handle) return;
                                webPrependIndexRecoveryScheduleRef.current = null;
                                webPrependIndexRecoveryRunningRef.current = true;
                                try {
                                    runWebPrependIndexRecoveryRef.current();
                                } finally {
                                    webPrependIndexRecoveryRunningRef.current = false;
                                }
                            });
                            handle.ids.push(second);
                        });
                        handle.ids.push(first);
                        break;
                    }
                    scheduleTimeoutRecovery(TRANSCRIPT_WEB_PREPEND_INDEX_RECOVERY_RETRY_MS);
                    break;
                }
                case 'clear-web-index-recovery':
                    cancelScheduledWebPrependIndexRecovery();
                    break;
                case 'record-restore-decision':
                    recordRestoreDecisionTelemetry(effect.reason, {
                        mode: effect.mode,
                        programmaticWebWrite: effect.programmaticWebWrite,
                        webTrigger: effect.webTrigger,
                    });
                    break;
            }
        }
    }, [
        cancelScheduledWebPrependIndexRecovery,
        cancelWebPrependRestoreWindowExpiry,
        clearWebPrependRangeReserve,
        closeWebPrependViewportOwnership,
        executeViewportCommand,
        preemptEntryRestoreTransaction,
        recordRestoreDecisionTelemetry,
        refreshWebTranscriptPrependAnchor,
        resolveViewportCommand,
        resolveWebPrependRefreshOptions,
        resolveWebScrollMetrics,
        restoreWebPrependAnchorThroughViewportCommand,
        viewportCommandController,
        webPrependOwner,
    ]);
    applyWebPrependOwnerEffectsRef.current = applyWebPrependOwnerEffects;

    const restoreWebViewportAnchorThroughViewportCommand = React.useCallback((params: Readonly<{
        anchor: WebTranscriptViewportAnchor;
        itemIndex?: number | null;
        reason?: Extract<TranscriptViewportTelemetryScrollReason, 'content-size-change' | 'entry-restore'>;
    }>): WebTranscriptViewportAnchorRestoreResult => {
        return commandHost.restoreWebVisibleAnchor({
            anchor: params.anchor,
            animated: false,
            itemIndex: params.itemIndex,
            reason: params.reason,
            sessionId: props.sessionId,
        });
    }, [commandHost, props.sessionId]);

    React.useLayoutEffect(() => {
        if (Platform.OS !== 'web') return;
        const pending = pendingWebLocalHeightChangeAnchorRef.current;
        if (!pending) return;
        if (pending.sessionId !== props.sessionId) {
            pendingWebLocalHeightChangeAnchorRef.current = null;
            return;
        }
        pendingWebLocalHeightChangeAnchorRef.current = null;
        restoreWebViewportAnchorThroughViewportCommand({
            anchor: pending.anchor,
            reason: 'content-size-change',
        });
    }, [
        expandedToolCallsAnchorMessageIds,
        listContentHeight,
        listData.length,
        props.sessionId,
        restoreWebViewportAnchorThroughViewportCommand,
    ]);

    const observeMountSettleMetrics = React.useCallback((options: Readonly<{
        distanceFromBottom?: number;
        nowMs?: number;
    }> = {}) => {
        lifecycleHost.observeMountSettleMetrics({
            sessionId: props.sessionId,
            nowMs: options.nowMs ?? Date.now(),
            initialFillStatus: sessionOpenLatch.initialFillStatus(),
            listContentHeight: listContentHeightRef.current,
            listLayoutHeight: listLayoutHeightRef.current,
            composerInsetHeight: composerInsetHeightRef.current,
            distanceFromBottom: options.distanceFromBottom ?? lastPinOffsetForIntentRef.current ?? 0,
        });
    }, [props.sessionId]);

    const applyNativeMountSettleIntervalDecision = React.useCallback((params: Readonly<{
        clearIntervalCallback: () => void;
        decision: NativeMountSettleIntervalDecision;
    }>): void => {
        const { clearIntervalCallback, decision } = params;
        if (decision.type === 'continue') return;

        closeEntryViewportOwnership('deadline');
        if (decision.type === 'stable') {
            setNativeMountSettleStable(true);
            nativeMountSettleDeadlineReachedRef.current = false;
            flushPendingNativeMountSettleBottomPinRef.current?.();
            clearIntervalCallback();
            return;
        }

        nativeMountSettleDeadlineReachedRef.current = true;
        setNativeMountSettleDeadlineReached(true);
        if (decision.requestPendingFlush) {
            pendingNativeMountSettleBottomPinRef.current = true;
            flushPendingNativeMountSettleBottomPinRef.current?.();
        }
        clearIntervalCallback();
    }, [closeEntryViewportOwnership]);

    React.useEffect(() => {
        if (!usesNativeFlashListBottomMaintenance) return undefined;
        const tuning = sync.getSyncTuning();
        const intervalMs = tuning.transcriptMountSettleQuiescentWindowMs;
        const deadlineMs = Date.now() + tuning.transcriptInitialFillBudgetMs + intervalMs;
        const intervalId = setInterval(() => {
            const nowMs = Date.now();
            lifecycleHost.sampleMountSettle({ sessionId: props.sessionId, nowMs });
            const mountSettleIntervalDecision = resolveNativeMountSettleIntervalDecision({
                autoPinSuppressed: nativeMountSettleAutoPinSuppressedRef.current,
                deadlineMs,
                nowMs,
                stableSettle: lifecycleHost.getMountSettleSnapshot().stableSettle,
            });
            applyNativeMountSettleIntervalDecision({
                clearIntervalCallback: () => clearInterval(intervalId),
                decision: mountSettleIntervalDecision,
            });
        }, intervalMs);
        return () => clearInterval(intervalId);
    }, [applyNativeMountSettleIntervalDecision, lifecycleHost, props.sessionId, usesNativeFlashListBottomMaintenance]);

    const recordFirstListPaint = React.useCallback(() => {
        setFirstListPaintObserved(true);
        const nowMs = Date.now();
        const telemetryState = firstPaintTelemetryRef.current;
        if (
            telemetryState &&
            telemetryState.sessionId === props.sessionId &&
            telemetryState.recorded === false &&
            syncPerformanceTelemetry.isEnabled()
        ) {
            telemetryState.recorded = true;
            syncPerformanceTelemetry.recordDuration(
                'ui.sessions.transcript.firstPaint',
                readSessionUiTelemetryNowMs() - telemetryState.startedAtMs,
                {
                    committedMessages: props.committedMessagesCount,
                    items: listDataRef.current.length,
                    native: Platform.OS === 'web' ? 0 : 1,
                    routeHydrationPending: props.routeHydrationPending === true ? 1 : 0,
                    web: Platform.OS === 'web' ? 1 : 0,
                },
            );
            recordSessionOpenPaintForSessionUiTelemetry({
                committedMessages: props.committedMessagesCount,
                items: listDataRef.current.length,
                native: Platform.OS === 'web' ? 0 : 1,
                phase: 'firstPaint',
                routeHydrationPending: props.routeHydrationPending === true ? 1 : 0,
                sessionId: props.sessionId,
                web: Platform.OS === 'web' ? 1 : 0,
            });
        }
        lifecycleHost.recordMountSettleFirstListPaint({
            sessionId: props.sessionId,
            nowMs,
        });
        observeMountSettleMetrics({ nowMs });
        releaseNativePaintForIssuedEntryRestore();
	    }, [
        lifecycleHost,
	        observeMountSettleMetrics,
	        props.committedMessagesCount,
        props.routeHydrationPending,
        props.sessionId,
        releaseNativePaintForIssuedEntryRestore,
    ]);

    const handleFlashListLoad = React.useCallback(() => {
        recordFirstListPaint();
        recordNativeVisibleWindowTelemetry('observed');
    }, [
        recordFirstListPaint,
        recordNativeVisibleWindowTelemetry,
    ]);

    const resolveEffectiveListPaintMetrics = React.useCallback(() => {
        if (Platform.OS === 'web') {
            const webMetrics = resolveWebScrollMetrics();
            if (webMetrics && webMetrics.clientHeight > 0 && webMetrics.scrollHeight > 0) {
                return {
                    contentHeight: Math.max(0, Math.trunc(webMetrics.scrollHeight)),
                    distanceFromBottom: Math.max(0, Math.trunc(getWebTranscriptDistanceFromBottom(webMetrics))),
                    layoutHeight: Math.max(0, Math.trunc(webMetrics.clientHeight)),
                };
            }
        }

        const measuredMetrics = readViewportContentMetrics();
        if (measuredMetrics && measuredMetrics.contentHeight > 0) {
            const distanceFromBottom =
                typeof lastPinOffsetForIntentRef.current === 'number' &&
                Number.isFinite(lastPinOffsetForIntentRef.current)
                    ? Math.max(0, Math.trunc(lastPinOffsetForIntentRef.current))
                    : 0;
            return {
                contentHeight: Math.max(0, Math.trunc(measuredMetrics.contentHeight)),
                distanceFromBottom,
                layoutHeight: Math.max(0, Math.trunc(measuredMetrics.layoutHeight)),
            };
        }

        return null;
    }, [readViewportContentMetrics, resolveWebScrollMetrics]);
    const hasWarmStablePaint = hasTranscriptWarmStablePaint({
        committedMessagesCount: props.committedMessagesCount,
        items: listData.length,
        latestCommittedActivityKey: props.latestCommittedActivityKey,
        platform: telemetryPlatform,
        routeHydrationPending: props.routeHydrationPending === true,
        sessionId: props.sessionId,
    });
    const isWarmKeepAliveInstance = props.isWarmKeepAliveInstance === true || hasWarmStablePaint;

    const recordStablePaintTelemetry = React.useCallback((
        paintMetrics: Readonly<{
            contentHeight: number;
            distanceFromBottom: number;
            layoutHeight: number;
        }>,
        options: Readonly<{
            nativeViewportObserved?: boolean;
        }> = {},
    ): boolean => {
        if (options.nativeViewportObserved === true) {
            rememberTranscriptWarmStablePaint({
                committedMessagesCount: props.committedMessagesCount,
                items: listData.length,
                latestCommittedActivityKey: props.latestCommittedActivityKey,
                platform: telemetryPlatform,
                routeHydrationPending: props.routeHydrationPending === true,
                sessionId: props.sessionId,
            });
        }
        const telemetryState = stablePaintTelemetryRef.current;
        if (
            !telemetryState ||
            telemetryState.sessionId !== props.sessionId ||
            telemetryState.recorded === true ||
            !syncPerformanceTelemetry.isEnabled()
        ) {
            return false;
        }
        clearWebStablePaintRetry();
        telemetryState.recorded = true;
        syncPerformanceTelemetry.recordDuration(
            'ui.sessions.transcript.stablePaint',
            readSessionUiTelemetryNowMs() - telemetryState.startedAtMs,
            {
                coldItems: shouldUseWebHotColdSplit ? transcriptHotColdSegments.coldItems.length : 0,
                committedMessages: props.committedMessagesCount,
                contentHeight: paintMetrics.contentHeight,
                distanceFromBottom: paintMetrics.distanceFromBottom,
                firstListPaintObserved: firstListPaintObserved ? 1 : 0,
                hotItems: shouldUseWebHotColdSplit ? transcriptHotColdSegments.hotItems.length : 0,
                items: listData.length,
                layoutHeight: paintMetrics.layoutHeight,
                native: Platform.OS === 'web' ? 0 : 1,
                nativeMountSettleDeadlineReached: nativeMountSettleDeadlineReached ? 1 : 0,
                nativeMountSettleStable: nativeMountSettleStable ? 1 : 0,
                nativeViewportObserved: options.nativeViewportObserved === true ? 1 : 0,
                routeHydrationPending: props.routeHydrationPending === true ? 1 : 0,
                warmKeepAlive: isWarmKeepAliveInstance ? 1 : 0,
                web: Platform.OS === 'web' ? 1 : 0,
                webHotColdSplit: shouldUseWebHotColdSplit ? 1 : 0,
            },
        );
        recordSessionOpenPaintForSessionUiTelemetry({
            committedMessages: props.committedMessagesCount,
            distanceFromBottom: paintMetrics.distanceFromBottom,
            items: listData.length,
            native: Platform.OS === 'web' ? 0 : 1,
            phase: 'stablePaint',
            routeHydrationPending: props.routeHydrationPending === true ? 1 : 0,
            sessionId: props.sessionId,
            web: Platform.OS === 'web' ? 1 : 0,
        });
        return true;
    }, [
        clearWebStablePaintRetry,
        firstListPaintObserved,
        isWarmKeepAliveInstance,
        listData.length,
        nativeMountSettleDeadlineReached,
        nativeMountSettleStable,
        props.committedMessagesCount,
        props.latestCommittedActivityKey,
        props.routeHydrationPending,
        props.sessionId,
        shouldUseWebHotColdSplit,
        telemetryPlatform,
        transcriptHotColdSegments.coldItems.length,
        transcriptHotColdSegments.hotItems.length,
    ]);

    const recordLayoutCommitObserved = React.useCallback(() => {
        const nowMs = Date.now();
        lifecycleHost.recordMountSettleLayoutCommitObserved({
            sessionId: props.sessionId,
            nowMs,
        });
        observeMountSettleMetrics({ nowMs });
        scheduleNativePaintReleaseForEntryRestore();
    }, [lifecycleHost, observeMountSettleMetrics, props.sessionId, scheduleNativePaintReleaseForEntryRestore]);

    const shouldCommitContentHeightState = React.useCallback(() => {
        if (Platform.OS === 'web') return true;
        if (sessionOpenLatch.initialFillStatus() !== 'done') return true;
        return props.jumpToSeq != null;
    }, [props.jumpToSeq]);

    const flashListMvcpThresholdLayoutHeight = listLayoutHeight;
    const mainTranscriptRendererFrameHost = React.useMemo(() => {
        const bottomFollowModeState = bottomFollowModeStateRef.current;
        return resolveMainTranscriptRendererFrameHost({
            autoFollowWhenPinned,
            bottomFollowMode: bottomFollowModeState.mode,
            configuredDrawDistance: configuredFlashListDrawDistance,
            hasOpenViewportTransaction:
                hasOpenEntryRestoreTransactionForSession() || hasOpenNativePrependTransactionForSession(),
            layoutHeight: flashListMvcpThresholdLayoutHeight,
            liveRegionActive: shouldUseNativeHotColdSplit,
            nativeEntryShouldUseBottomMaintenance,
            nativeID: chatListNativeId,
            pinEnabled,
            pinThresholdPx,
            platformOS: Platform.OS,
            targetWindowActive,
        });
    }, [
        autoFollowWhenPinned,
        bottomFollowModeRevision,
        chatListNativeId,
        configuredFlashListDrawDistance,
        flashListMvcpThresholdLayoutHeight,
        hasOpenEntryRestoreTransactionForSession,
        hasOpenNativePrependTransactionForSession,
        nativeEntryShouldUseBottomMaintenance,
        nativeInitialViewportPendingObservation,
        nativePrependTransactionRevision,
        pinEnabled,
        pinThresholdPx,
        shouldUseNativeHotColdSplit,
        targetWindowActive,
    ]);
    nativeFlashListMvcpPolicyRef.current = mainTranscriptRendererFrameHost.telemetryMvcpPolicy;
    nativeFlashListPauseOffsetCorrectionRef.current = mainTranscriptRendererFrameHost.pauseOffsetCorrection;
    const mainTranscriptListShellFrame = mainTranscriptRendererFrameHost.frame;

    const resolveCreatedAtForMessageId = React.useCallback((messageId: string): number | null => {
        const state = getStorage().getState();
        const session = state?.sessionMessages?.[props.sessionId];
        const message = session?.messagesById?.[messageId] ?? session?.messagesMap?.[messageId] ?? null;
        const createdAt = message?.createdAt;
        return typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : null;
    }, [props.sessionId]);

    const resolveSeqForMessageId = React.useCallback((messageId: string): number | null => {
        const state = getStorage().getState();
        const session = state?.sessionMessages?.[props.sessionId];
        const message = session?.messagesById?.[messageId] ?? session?.messagesMap?.[messageId] ?? null;
        const seq = message?.seq;
        return typeof seq === 'number' && Number.isFinite(seq) ? Math.trunc(seq) : null;
    }, [props.sessionId]);

    const resolveRouteMessageIdForMessageId = React.useCallback((messageId: string): string | null => {
        const state = getStorage().getState();
        const session = state?.sessionMessages?.[props.sessionId];
        const messagesById = (session?.messagesById ?? session?.messagesMap ?? {}) as Readonly<Record<string, Message>>;
        return buildSessionMessageRouteId({
            messageId,
            messagesById,
            reducerState: session?.reducerState ?? null,
        });
    }, [props.sessionId]);

    const resolveTranscriptBlockIndexForMessageId = React.useCallback((messageId: string): number | null => {
        const state = getStorage().getState();
        const session = state?.sessionMessages?.[props.sessionId];
        const message = session?.messagesById?.[messageId] ?? session?.messagesMap?.[messageId] ?? null;
        const transcriptBlockIndex = message?.transcriptBlockIndex;
        return typeof transcriptBlockIndex === 'number' && Number.isFinite(transcriptBlockIndex)
            ? Math.trunc(transcriptBlockIndex)
            : null;
    }, [props.sessionId]);

    const resolveRoleForMessageId = React.useCallback((messageId: string): TranscriptJumpTargetRole | null => {
        const state = getStorage().getState();
        const session = state?.sessionMessages?.[props.sessionId];
        const message = session?.messagesById?.[messageId] ?? session?.messagesMap?.[messageId] ?? null;
        if (message?.kind === 'user-text') return 'user';
        if (message?.kind === 'agent-text') return 'assistant';
        if (message?.kind === 'tool-call') return 'tool';
        if (message?.kind === 'agent-event') return 'system';
        return message ? 'unknown' : null;
    }, [props.sessionId]);

    const resolveJumpToSeqIndexFromLoadedItems = React.useCallback((
        targetSeq: number,
        routeMessageId?: string | null,
        transcriptBlockIndex?: number | null,
        role?: TranscriptJumpTargetRole | null,
    ): number | null => {
        if (typeof targetSeq !== 'number' || !Number.isFinite(targetSeq) || targetSeq < 0) return null;
        const normalizedSeq = Math.trunc(targetSeq);
        const normalizedRouteMessageId = typeof routeMessageId === 'string' && routeMessageId.trim().length > 0
            ? routeMessageId.trim()
            : null;
        if (normalizedRouteMessageId) {
            const result = resolveTranscriptJumpTargetIndex({
                target: {
                    kind: 'route-message-id',
                    routeMessageId: normalizedRouteMessageId,
                    seqHint: normalizedSeq,
                    transcriptBlockIndex,
                    role,
                },
                items: itemsRef.current as readonly Record<string, unknown>[],
                resolveSeqForMessageId,
                resolveRouteMessageIdForMessageId,
                resolveTranscriptBlockIndexForMessageId,
                resolveRoleForMessageId,
                hasMoreOlder: hasMoreOlderRef.current !== false,
                hasMoreNewer: targetWindowHostFacts.hasMoreNewer,
            });
            return result.status === 'found' ? result.index : null;
        }
        return resolveTranscriptJumpSeqIndex({
            targetSeq: normalizedSeq,
            items: itemsRef.current,
            resolveSeqForMessageId,
            // Treat unknown as "may have more": resolving the nearest-loaded fallback too
            // early aborts jump materialization, while the load loop self-terminates on
            // `no_more` and flips this latch for the post-exhaustion fallback landing.
            hasMoreOlder: hasMoreOlderRef.current !== false,
        });
    }, [
        resolveRoleForMessageId,
        resolveRouteMessageIdForMessageId,
        resolveSeqForMessageId,
        targetWindowHostFacts.hasMoreNewer,
        resolveTranscriptBlockIndexForMessageId,
    ]);
    resolveJumpToSeqIndexForCommandRef.current = resolveJumpToSeqIndexFromLoadedItems;

    const resolveJumpTargetIndexFromRenderedWindow = React.useCallback((target: TranscriptJumpTarget): TranscriptJumpTargetIndexResult => {
        return resolveTranscriptJumpTargetIndex({
            target,
            items: canonicalWindowedItemsRef.current as readonly Record<string, unknown>[],
            resolveSeqForMessageId,
            resolveRouteMessageIdForMessageId,
            resolveTranscriptBlockIndexForMessageId,
            resolveRoleForMessageId,
            hasMoreOlder: hasMoreOlderRef.current !== false,
            hasMoreNewer: targetWindowHostFacts.hasMoreNewer,
        });
    }, [
        resolveRoleForMessageId,
        resolveRouteMessageIdForMessageId,
        resolveSeqForMessageId,
        targetWindowHostFacts.hasMoreNewer,
        resolveTranscriptBlockIndexForMessageId,
    ]);

    const isTranscriptJumpTargetInRenderedWindow = React.useCallback((target: TranscriptJumpTarget): boolean => {
        return resolveJumpTargetIndexFromRenderedWindow(target).status === 'found';
    }, [resolveJumpTargetIndexFromRenderedWindow]);

    const resolveRestoreAnchorIdentityFromSourceIndex = React.useCallback((index: number): TranscriptViewportAnchorIdentity | null => {
        if (!Number.isFinite(index)) return null;
        const item = itemsRef.current[Math.max(0, Math.trunc(index))] as ChatTranscriptListItem | undefined;
        return item ? resolveTranscriptViewportAnchorDescriptor(item) : null;
    }, []);

    const resolveRestoreAnchorSourceIndexFromLoadedItems = React.useCallback((anchor: TranscriptViewportAnchorIdentity): number | null => {
        return resolveTranscriptViewportAnchorIndex({
            anchor,
            items: itemsRef.current,
        });
    }, []);
    resolveRestoreAnchorIndexForCommandRef.current = resolveRestoreAnchorSourceIndexFromLoadedItems;

    const resolveKindForMessageId = React.useCallback((messageId: string): string | null => {
        const state = getStorage().getState();
        const session = state?.sessionMessages?.[props.sessionId];
        const message = session?.messagesById?.[messageId] ?? session?.messagesMap?.[messageId] ?? null;
        const kind = message?.kind;
        return typeof kind === 'string' ? kind : null;
    }, [props.sessionId]);

    const resolveForkedTurnMessageOrigin = React.useCallback((messageId: string) => {
        const metadata = props.forkMessageMetadataById?.[messageId] ?? null;
        if (!metadata) return null;
        return {
            sessionId: metadata.originSessionId,
            isReadOnlyContext: metadata.isReadOnlyContext,
        };
    }, [props.forkMessageMetadataById]);
    const getTurnMessageOrigin = props.forkedTranscriptEnabled ? resolveForkedTurnMessageOrigin : undefined;

    const toolTimelineChromeMode = useSetting('toolViewTimelineChromeMode');
    const keyExtractor = useCallback((item: ChatTranscriptListItem) => item.id, []);
    const rowWidthBucket = listLayoutWidthBucket;
    const rowFontScaleKey = resolveFontScaleKey();
    const getItemType = useCallback((item: ChatTranscriptListItem): string => (
        resolveTranscriptRowItemType({
            activeThinkingMessageId: resolveTranscriptItemActiveThinkingMessageId(item, props.activeThinkingMessageId),
            getMessageById: getTurnMessageById,
            item,
        })
    ), [getTurnMessageById, props.activeThinkingMessageId]);
    React.useEffect(() => {
        // N1.3 evidence: intra-row content mutations (a rendered turn/tool-group row gaining or
        // losing entries post-mount) — the D6 blind spot no list-level maintenance can absorb.
        if (!isViewportEvidenceTelemetryEnabled()) return;
        const previousCounts = rowEvidenceContentCountsRef.current;
        const nextCounts = new Map<string, number>();
        for (const item of listData) {
            const count = resolveTranscriptRowContentCount(item);
            if (count === undefined) continue;
            nextCounts.set(item.id, count);
            const previousCount = previousCounts.get(item.id);
            if (previousCount !== undefined && previousCount !== count) {
                recordViewportTelemetryEvent({
                    type: 'row-mutated',
                    mode: resolveViewportTelemetryMode(),
                    rowId: item.id,
                    rowKind: getItemType(item),
                    rowContentCount: count,
                    rowPreviousContentCount: previousCount,
                    rowViewportRelation: resolveRowEvidenceViewportRelation(item.id),
                });
            }
        }
        rowEvidenceContentCountsRef.current = nextCounts;
    }, [
        getItemType,
        isViewportEvidenceTelemetryEnabled,
        listData,
        recordViewportTelemetryEvent,
        resolveRowEvidenceViewportRelation,
        resolveViewportTelemetryMode,
    ]);
    const resolveRollbackActionForMessage = React.useCallback((messageId: string): TranscriptRollbackAction | null => {
        return props.rollbackActionsByMessageId[messageId] ?? null;
    }, [props.rollbackActionsByMessageId]);
    const buildRowShellSignature = React.useCallback((item: ChatTranscriptListItem) => (
        buildTranscriptRowShellSignature({
            activeThinkingMessageId: resolveTranscriptItemActiveThinkingMessageId(item, props.activeThinkingMessageId),
            expandedToolCallsAnchorMessageIds,
            forkMessageMetadataById: props.forkMessageMetadataById,
            getMessageById: getTurnMessageById,
            getMessageRevisionById: getTurnMessageRevisionById,
            groupingMode: props.groupingMode,
            item,
            latestCommittedActivityKey: props.latestCommittedActivityKey,
            resolveThinkingExpanded,
            sessionActive: props.sessionActive,
            widthBucket: rowWidthBucket,
            fontScaleKey: rowFontScaleKey,
        })
    ), [
        expandedToolCallsAnchorMessageIds,
        getTurnMessageById,
        getTurnMessageRevisionById,
        props.groupingMode,
        props.activeThinkingMessageId,
        props.forkMessageMetadataById,
        props.latestCommittedActivityKey,
        props.sessionActive,
        resolveThinkingExpanded,
        rowFontScaleKey,
        rowWidthBucket,
    ]);
    const showNativeFirstPaintPlaceholder =
        Platform.OS !== 'web' &&
        sessionOpenLatch.shouldShowNativeFirstPaintPlaceholder({
            firstListPaintObserved,
            hasOpenEntryRestoreTransaction: entryRestoreOwner.hasOpenTransaction(props.sessionId),
            isLoaded: props.isLoaded,
            isWarmKeepAliveInstance,
            itemCount: listData.length,
            jumpToSeqActive: props.jumpToSeq != null,
            lastPinOffsetForIntent: lastPinOffsetForIntentRef.current,
            nativeEntryRestorePaintReleased,
            nativeInitialViewportPendingObservation,
            nativeMountSettleDeadlineReached,
            nativeMountSettleStable,
            nativeViewportPaintObserved,
            pinThresholdPx,
            sessionId: props.sessionId,
            usesNativeFlashListBottomMaintenance,
        });
    const showWebMarkdownRuntimeFirstPaintPlaceholder =
        Platform.OS === 'web' &&
        props.isLoaded &&
        listData.length > 0 &&
        !firstListPaintObserved &&
        !webMarkdownRuntimeReady;
    const showRouteHydrationFirstPaintPlaceholder =
        props.routeHydrationPending === true &&
        props.isLoaded &&
        listData.length > 0;
    const showFirstPaintPlaceholder =
        showNativeFirstPaintPlaceholder ||
        showWebMarkdownRuntimeFirstPaintPlaceholder ||
        showRouteHydrationFirstPaintPlaceholder;
    const applyNativeAcceptedViewportPaintEffects = React.useCallback((
        effects: readonly NativeScrollAcceptedViewportPaintEffect[],
    ): boolean => {
        if (Platform.OS === 'web') return false;
        let applied = false;
        for (const effect of effects) {
            if (
                effect.type !== 'record-accepted-viewport-paint' ||
                effect.sessionId !== props.sessionId
            ) {
                continue;
            }
            applied = true;
            updateNativeViewportPaintObserved(true);
            if (firstPaintTelemetryRef.current?.recorded === false) {
                recordFirstListPaint();
            }
            if (!showFirstPaintPlaceholder) {
                const paintMetrics = resolveEffectiveListPaintMetrics() ?? {
                    contentHeight: effect.fallbackMetrics.contentHeight,
                    distanceFromBottom: effect.fallbackMetrics.distanceFromLiveTailPx,
                    layoutHeight: effect.fallbackMetrics.layoutHeight,
                };
                recordStablePaintTelemetry(paintMetrics, {
                    nativeViewportObserved: true,
                });
            }
        }
        return applied;
    }, [
        recordFirstListPaint,
        recordStablePaintTelemetry,
        resolveEffectiveListPaintMetrics,
        showFirstPaintPlaceholder,
        updateNativeViewportPaintObserved,
        props.sessionId,
    ]);
    const applyLifecycleHostScrollObservationPlan = React.useCallback((
        plan: ScrollObservationPlan,
        callbacks: Readonly<{
            continueAfterEarlyEffects: (input: TranscriptLifecycleScrollObservationPlanContinuationInput) => void;
            recordNativeScrollObservation: (reason: TranscriptViewportTelemetryObservationReason) => void;
        }>,
    ): boolean => {
        return applyTranscriptLifecycleScrollObservationPlan(plan, {
            applyGenericScrollObservationAnchorCaptureCancellationEffects,
            applyGenericScrollObservationReadOnlyVisibleBottomEffects,
            applyGenericScrollObservationSuppressionEffects,
            applyGenericScrollObservationViewportStateEffects,
            applyNativeAcceptedViewportPaintEffects,
            applyNativeBottomFollowCompletionEffects: applyNativeBottomFollowCompletionHostEffects,
            applyNativeSettledReturnToLiveTailDrainEffects,
            applyNativeSettledReturnToLiveTailReturnEffects,
            applyNativeUserScrollTakeoverEffects: applyNativeUserScrollTakeoverHostEffects,
            applyWebPassiveLiveTailCorrectionEffect: (effect) =>
                applyWebPassiveLiveTailCorrectionEffectRef.current(effect),
            applyWebUserScrollIntentTimestampLifecycleEffects,
            applyWebUserScrollTakeoverLifecycleEffects,
            commitBottomFollowModeState,
            continueAfterEarlyEffects: callbacks.continueAfterEarlyEffects,
            markNativeInitialViewportApplied: markNativeInitialViewportAppliedForCurrentSession,
            recordNativeScrollObservation: callbacks.recordNativeScrollObservation,
        });
    }, [
        applyGenericScrollObservationAnchorCaptureCancellationEffects,
        applyGenericScrollObservationReadOnlyVisibleBottomEffects,
        applyGenericScrollObservationSuppressionEffects,
        applyGenericScrollObservationViewportStateEffects,
        applyNativeAcceptedViewportPaintEffects,
        applyNativeBottomFollowCompletionHostEffects,
        applyNativeSettledReturnToLiveTailDrainEffects,
        applyNativeSettledReturnToLiveTailReturnEffects,
        applyNativeUserScrollTakeoverHostEffects,
        applyWebUserScrollIntentTimestampLifecycleEffects,
        applyWebUserScrollTakeoverLifecycleEffects,
        commitBottomFollowModeState,
        markNativeInitialViewportAppliedForCurrentSession,
    ]);
    const nativeFirstPaintReleasedWithoutListLoad =
        Platform.OS !== 'web' &&
        (nativeMountSettleStable || nativeMountSettleDeadlineReached);
    React.useEffect(() => {
        if (Platform.OS === 'web') return;
        if (!usesNativeFlashListBottomMaintenance) return;
        if (!props.isLoaded) return;
        if (listData.length <= 0) return;
        if (nativeViewportPaintObservedRef.current) return;
        if (nativeFirstPaintFallbackReleaseTimeoutRef.current?.sessionId === props.sessionId) return;

        const tuning = sync.getSyncTuning();
        const timeoutMs =
            tuning.transcriptInitialFillBudgetMs +
            tuning.transcriptMountSettleQuiescentWindowMs * 2 +
            1;
        const handle = {
            sessionId: props.sessionId,
            timeoutId: null as unknown as ReturnType<typeof setTimeout>,
        };
        handle.timeoutId = setTimeout(() => {
            if (nativeFirstPaintFallbackReleaseTimeoutRef.current !== handle) return;
            nativeFirstPaintFallbackReleaseTimeoutRef.current = null;
            if (currentSessionIdRef.current !== handle.sessionId) return;
            if (nativeViewportPaintObservedRef.current) return;
            const decision = sessionOpenLatch.onNativeFirstPaintFallbackDeadline({
                nativeViewportPaintObserved: nativeViewportPaintObservedRef.current,
                nowMs: Date.now(),
                sessionId: handle.sessionId,
            });
            applySessionOpenLatchEffectsRef.current(decision.effects);
        }, timeoutMs);
        nativeFirstPaintFallbackReleaseTimeoutRef.current = handle;
    }, [
        listData.length,
        props.isLoaded,
        props.sessionId,
        sessionOpenLatch,
        updateNativeInitialViewportPendingObservation,
        usesNativeFlashListBottomMaintenance,
    ]);
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        if (firstListPaintObserved) return;
        if (!props.isLoaded) return;
        if (listData.length <= 0) return;
        if (showRouteHydrationFirstPaintPlaceholder) return;
        if (!resolveEffectiveListPaintMetrics()) return;

        recordFirstListPaint();
    }, [
        firstListPaintObserved,
        listContentHeight,
        listData.length,
        listLayoutHeight,
        props.isLoaded,
        recordFirstListPaint,
        resolveEffectiveListPaintMetrics,
        showRouteHydrationFirstPaintPlaceholder,
    ]);
    React.useEffect(() => {
        if (!props.isLoaded) return;
        if (listData.length <= 0) return;
        if (showFirstPaintPlaceholder) return;
        if (
            !firstListPaintObserved &&
            !isWarmKeepAliveInstance &&
            !nativeFirstPaintReleasedWithoutListLoad &&
            !nativeEntryRestorePaintReleased &&
            !nativeViewportPaintObserved &&
            !nativeViewportPaintObservedRef.current
        ) {
            return;
        }
        const paintMetrics = resolveEffectiveListPaintMetrics();
        if (!paintMetrics) {
            scheduleWebStablePaintRetry();
            return;
        }
        if (
            Platform.OS === 'web' &&
            sessionEntryViewportRef.current?.shouldFollowBottom !== false &&
            paintMetrics.distanceFromBottom > pinThresholdPx
        ) {
            scheduleWebStablePaintRetry();
            return;
        }
        recordStablePaintTelemetry(paintMetrics, {
            nativeViewportObserved: nativeViewportPaintObserved || nativeViewportPaintObservedRef.current,
        });
    }, [
        firstListPaintObserved,
        isWarmKeepAliveInstance,
        listContentHeight,
        listData.length,
        listLayoutHeight,
        nativeFirstPaintReleasedWithoutListLoad,
        nativeEntryRestorePaintReleased,
        nativeMountSettleDeadlineReached,
        nativeMountSettleStable,
        nativeViewportPaintObserved,
        props.committedMessagesCount,
        props.isLoaded,
        props.routeHydrationPending,
        props.sessionId,
        pinThresholdPx,
        recordStablePaintTelemetry,
        resolveEffectiveListPaintMetrics,
        scheduleWebStablePaintRetry,
        showFirstPaintPlaceholder,
        webStablePaintRetryTick,
    ]);
    const wrapTranscriptItemForAnchor = React.useCallback((item: ChatTranscriptListItem, node: React.ReactNode) => {
        const signature = buildRowShellSignature(item);
        return (
            <TranscriptRowShell
                reconciler={measurementReconciler}
                itemId={item.id}
                onRowLayoutMutation={handleRowLayoutMutation}
                onRowMeasured={handleRowShellMeasured}
                signature={signature}
            >
                {node}
            </TranscriptRowShell>
        );
    }, [buildRowShellSignature, handleRowLayoutMutation, handleRowShellMeasured, measurementReconciler]);

    const captureCurrentWebPrependAnchor = React.useCallback(() => {
        if (Platform.OS !== 'web') return null;
        const metrics = resolveWebScrollMetrics();
        if (!metrics) return null;
        if (!isWebTranscriptScrollable(metrics, 1)) return null;
        if (getWebTranscriptDistanceFromBottom(metrics) <= pinThresholdPx) return null;
        const tuning = sync.getSyncTuning();
        const anchor = captureWebTranscriptPrependAnchor({
            metrics,
            userIntentAtMs: lastUserScrollIntentAtMsRef.current,
            stabilizeForMs: tuning.transcriptWebInitialPinStabilizeMs,
        });
        return anchor;
    }, [pinThresholdPx, resolveWebScrollMetrics]);

    const captureNativePrependOwnerAnchor = React.useCallback((): NativePrependBeginInput['capturedAnchor'] => {
        const layoutHeight = listLayoutHeightRef.current;
        const contentHeight = listContentHeightRef.current;
        if (!Number.isFinite(layoutHeight) || layoutHeight <= 0) return null;
        if (!Number.isFinite(contentHeight) || contentHeight <= layoutHeight + 1) return null;

        const result = captureNativeTranscriptViewportAnchor({
            ref: listRef.current,
            data: listDataRef.current,
            focusOffsetPx: resolveTranscriptViewportAnchorFocusOffsetPx(layoutHeight),
            capturedAtMs: Date.now(),
            resolveAnchor: (item) => resolveTranscriptViewportAnchorDescriptor(item),
        });
        if (result.status !== 'captured') return null;
        // LC-R capture hardening: a non-finite captured offset can never produce a conclusive
        // observation, so skip creating a transaction at all.
        if (!Number.isFinite(result.anchor.itemOffsetPx)) return null;
        const anchorItemId = result.anchor.itemId;
        if (typeof anchorItemId !== 'string' || anchorItemId.length === 0) return null;
        const capturedAnchor: NonNullable<NativePrependBeginInput['capturedAnchor']> = {
            key: { itemId: anchorItemId, messageId: result.anchor.messageId ?? null },
            itemOffsetPx: result.anchor.itemOffsetPx,
            capturedDataLength: listDataRef.current.length,
            capturedFirstItemId: typeof listDataRef.current[0]?.id === 'string'
                ? listDataRef.current[0].id
                : null,
        };
        return capturedAnchor;
    }, []);

    const beginNativePrependOwner = React.useCallback((): boolean => {
        if (Platform.OS === 'web') return false;
        if (wantsPinnedRef.current) return false;

        const buildInput = (): NativePrependBeginInput => ({
            activeOwner: viewportCommandController.activeOwner(),
            capturedAnchor: captureNativePrependOwnerAnchor(),
            contentHeight: listContentHeightRef.current,
            layoutHeight: listLayoutHeightRef.current,
            preservePrependViewport: true,
            sessionId: props.sessionId,
        });

        const firstEffects = nativePrependOwner.begin(buildInput());
        applyNativePrependOwnerEffects(firstEffects);
        if (firstEffects.some((effect) => effect.type === 'preempt-entry-restore-for-prepend')) {
            const secondEffects = nativePrependOwner.begin(buildInput());
            applyNativePrependOwnerEffects(secondEffects);
        }
        return nativePrependOwner.hasOpenTransaction(props.sessionId);
    }, [
        applyNativePrependOwnerEffects,
        captureNativePrependOwnerAnchor,
        nativePrependOwner,
        props.sessionId,
        viewportCommandController,
    ]);

    const invalidateNativePrependOwner = React.useCallback(() => {
        applyNativePrependOwnerEffects(nativePrependOwner.invalidate({
            activeOwner: viewportCommandController.activeOwner(),
            reason: 'session-entry',
            sessionId: props.sessionId,
        }));
    }, [applyNativePrependOwnerEffects, nativePrependOwner, props.sessionId, viewportCommandController]);
    invalidateNativePrependOwnerRef.current = invalidateNativePrependOwner;

    /**
     * N2b.2: reveals the withheld slice-window rows as ONE prepend-observed data
     * commit (zero scroll writes expected — the corrector/MVCP covers it; the
     * prepend transaction observes the outcome per the N2d rules). Returns the
     * number of revealed rows.
     */
    const revealEntrySliceWindow = React.useCallback((): number => {
        const sliceWindow = entrySliceWindowRef.current;
        if (!sliceWindow || sliceWindow.sessionId !== props.sessionId) return 0;
        const withheldCount = entrySliceWithheldCountRef.current;
        if (withheldCount <= 0) {
            entrySliceWindowRef.current = null;
            setEntrySliceWindow(null);
            return 0;
        }
        // Clear the window ref before beginning the transaction: begin may preempt an
        // open entry transaction whose close hook re-enters this reveal (no-op then).
        // The capture still reads the pre-reveal listData — the data growth only
        // commits on the next render and the transaction observes it (commit armed).
        entrySliceWindowRef.current = null;
        setEntrySliceWindow(null);
        if (beginNativePrependOwner()) {
            const tuning = sync.getSyncTuning();
            const { budgetMs } = resolveTranscriptInitialFillTuning({
                transcriptInitialFillBudgetMs: tuning.transcriptInitialFillBudgetMs,
                transcriptInitialFillMaxNoProgressLoads: tuning.transcriptInitialFillMaxNoProgressLoads,
            });
            applyNativePrependOwnerEffects(nativePrependOwner.armCommit({
                layoutTimeoutMs: budgetMs,
                sessionId: props.sessionId,
            }));
        }
        return withheldCount;
    }, [applyNativePrependOwnerEffects, beginNativePrependOwner, nativePrependOwner, props.sessionId]);
    revealEntrySliceWindowRef.current = revealEntrySliceWindow;

    const observeNativePrependOwner = React.useCallback(() => {
        if (Platform.OS === 'web') return;
        applyNativePrependOwnerEffects(nativePrependOwner.observe(
            resolveNativePrependObservationInput(props.sessionId),
        ));
    }, [
        applyNativePrependOwnerEffects,
        nativePrependOwner,
        props.sessionId,
        resolveNativePrependObservationInput,
    ]);
    observeNativePrependOwnerRef.current = observeNativePrependOwner;

    const captureCurrentViewportAnchor = React.useCallback((): SessionViewportAnchorSnapshot | null => {
        if (wantsPinnedRef.current) return null;

        const capturedAtMs = Date.now();
        if (Platform.OS === 'web') {
            const metrics = resolveWebScrollMetrics();
            if (!metrics) return null;
            const anchor = captureWebTranscriptViewportAnchor({ container: metrics.element });
            if (!anchor) return null;
            return {
                ...anchor,
                capturedAtMs,
            };
        }

        const result = captureNativeTranscriptViewportAnchor({
            ref: listRef.current,
            data: listDataRef.current,
            focusOffsetPx: resolveTranscriptViewportAnchorFocusOffsetPx(listLayoutHeightRef.current),
            capturedAtMs,
            resolveAnchor: (item) => resolveTranscriptViewportAnchorDescriptor(item),
        });
        return result.status === 'captured' ? result.anchor : null;
    }, [resolveWebScrollMetrics]);

    const emitViewportAnchorCapture = React.useCallback((
        state: TranscriptViewportChangeState,
        generation: number,
        wantsPinned: boolean,
        emit: ((nextState: TranscriptViewportChangeState) => void) | undefined,
        captureAnchor: () => SessionViewportAnchorSnapshot | null,
        sessionId: string,
    ) => {
        const recordCaptureOutcome = (
            reason: 'anchor-captured' | 'anchor-capture-empty' | 'anchor-capture-dropped',
            anchorItemOffsetPx?: number,
        ) => {
            recordViewportTelemetryEvent({
                type: 'anchor-capture',
                mode: 'user-unpinned',
                reason,
                distanceFromBottom: typeof state.offsetY === 'number' ? state.offsetY : undefined,
                anchorItemOffsetPx,
            }, { sessionId });
        };
        if (viewportAnchorCaptureGenerationRef.current !== generation) {
            recordCaptureOutcome('anchor-capture-dropped');
            return;
        }
        // Session guard (plan A3): a capture scheduled for session A must never run against
        // session B's mounted list/data — it would write B's anchor into A's viewport memory.
        // Exit flushes happen synchronously in the session-entry render block, before the
        // current-session ref flips, so legitimate flushes pass this guard.
        if (sessionId !== currentSessionIdRef.current) {
            recordCaptureOutcome('anchor-capture-dropped');
            return;
        }
        if (shouldSuppressGenericViewportStateForProtectedJumpSeq()) {
            recordCaptureOutcome('anchor-capture-dropped');
            return;
        }
        if (state.shouldRestoreViewport !== true || state.isPinned === true || wantsPinned) {
            recordCaptureOutcome('anchor-capture-dropped');
            return;
        }

        const anchor = captureAnchor();
        recordCaptureOutcome(
            anchor ? 'anchor-captured' : 'anchor-capture-empty',
            anchor?.itemOffsetPx,
        );
        emit?.({
            ...state,
            anchor,
        });
    }, [recordViewportTelemetryEvent, shouldSuppressGenericViewportStateForProtectedJumpSeq]);

    const scheduleViewportAnchorCapture = React.useCallback((
        state: TranscriptViewportChangeState,
        options?: Readonly<{ suppressAnchorCapture?: boolean }>,
    ) => {
        if (shouldSuppressGenericViewportStateForProtectedJumpSeq()) return;
        if (options?.suppressAnchorCapture === true) {
            // Plan P2: an unattributable (churn) frame must not initiate or refresh a capture,
            // but it no longer destroys a pending user-attributed capture — the debounced
            // capture re-reads the anchor from the live list at fire time, so it stays
            // truthful even when churn moves content in between. Recycled-jump pollution is
            // no worse than the already-persisted distance from the same frames (FW3 delta).
            return;
        }

        if (state.shouldRestoreViewport !== true || state.isPinned === true) {
            viewportAnchorCaptureGenerationRef.current += 1;
            cancelScheduledViewportAnchorCapture();
            return;
        }

        const debounceMs = sync.getSyncTuning().transcriptViewportAnchorCaptureDebounceMs;
        const captureAnchor = captureCurrentViewportAnchor;
        const dueAtMs = Date.now() + debounceMs;
        const emit = emitViewportChange;
        const generation = viewportAnchorCaptureGenerationRef.current;
        const sessionId = currentSessionIdRef.current;
        const wantsPinned = wantsPinnedRef.current;
        const existing = scheduledViewportAnchorCaptureRef.current;
        if (existing && existing.generation === generation && existing.sessionId === sessionId) {
            existing.captureAnchor = captureAnchor;
            existing.dueAtMs = dueAtMs;
            existing.emit = emit;
            existing.state = state;
            existing.wantsPinned = wantsPinned;
            return;
        }
        cancelScheduledViewportAnchorCapture();
        const armTimeout = (delayMs: number): ReturnType<typeof setTimeout> => {
            const timeoutId = setTimeout(() => {
                const scheduled = scheduledViewportAnchorCaptureRef.current;
                if (!scheduled || scheduled.timeoutId !== timeoutId) return;
                const remainingMs = scheduled.dueAtMs - Date.now();
                if (remainingMs > 0) {
                    scheduled.timeoutId = armTimeout(remainingMs);
                    return;
                }
                scheduledViewportAnchorCaptureRef.current = null;
                emitViewportAnchorCapture(
                    scheduled.state,
                    scheduled.generation,
                    scheduled.wantsPinned,
                    scheduled.emit,
                    scheduled.captureAnchor,
                    scheduled.sessionId,
                );
            }, Math.max(0, delayMs));
            return timeoutId;
        };
        const timeoutId = armTimeout(debounceMs);
        scheduledViewportAnchorCaptureRef.current = { captureAnchor, dueAtMs, emit, generation, sessionId, state, timeoutId, wantsPinned };
    }, [cancelScheduledViewportAnchorCapture, captureCurrentViewportAnchor, emitViewportAnchorCapture, emitViewportChange, shouldSuppressGenericViewportStateForProtectedJumpSeq]);
    scheduleViewportAnchorCaptureRef.current = scheduleViewportAnchorCapture;

    const flushScheduledViewportAnchorCapture = React.useCallback((options?: Readonly<{ deferEmit?: boolean }>) => {
        const scheduled = scheduledViewportAnchorCaptureRef.current;
        if (!scheduled) return;
        scheduledViewportAnchorCaptureRef.current = null;
        clearTimeout(scheduled.timeoutId);
        if (scheduled.generation !== viewportAnchorCaptureGenerationRef.current) return;
        // Session guard (plan A3): only flush a capture that still belongs to the session the
        // refs currently point at; otherwise drop it instead of polluting another session.
        if (scheduled.sessionId !== currentSessionIdRef.current) return;
        if (shouldSuppressGenericViewportStateForProtectedJumpSeq()) {
            recordViewportTelemetryEvent({
                type: 'anchor-capture',
                mode: 'user-unpinned',
                reason: 'anchor-capture-dropped',
                distanceFromBottom: typeof scheduled.state.offsetY === 'number' ? scheduled.state.offsetY : undefined,
            }, { sessionId: scheduled.sessionId });
            return;
        }
        if (scheduled.state.shouldRestoreViewport !== true || scheduled.state.isPinned === true || scheduled.wantsPinned) {
            return;
        }
        // Capture against the still-mounted list synchronously; the render-phase exit flush
        // defers only the emit so it never writes to the sync store mid-render.
        const anchor = scheduled.captureAnchor();
        recordViewportTelemetryEvent({
            type: 'anchor-capture',
            mode: 'user-unpinned',
            reason: anchor ? 'anchor-captured' : 'anchor-capture-empty',
            distanceFromBottom: typeof scheduled.state.offsetY === 'number' ? scheduled.state.offsetY : undefined,
            anchorItemOffsetPx: anchor?.itemOffsetPx,
        }, { sessionId: scheduled.sessionId });
        const emit = scheduled.emit;
        const state = scheduled.state;
        if (options?.deferEmit === true) {
            queueMicrotask(() => {
                emit?.({ ...state, anchor });
            });
            return;
        }
        emit?.({ ...state, anchor });
    }, [recordViewportTelemetryEvent, shouldSuppressGenericViewportStateForProtectedJumpSeq]);

    React.useLayoutEffect(() => {
        flushViewportAnchorCaptureRef.current = flushScheduledViewportAnchorCapture;
    }, [flushScheduledViewportAnchorCapture]);

    /**
     * Exit-flush live-tail intent (plan P3): on navigation away/unmount, when the viewport
     * visibly sits within the pin threshold of the bottom, persist an explicit live-tail
     * report ({isPinned:true, shouldRestoreViewport:false}) for the exiting session. The B8
     * arrival emission only fires on trusted arrivals — passive settles and swallowed
     * momentum tails leave the stored viewport unpinned, which reopens slightly above the
     * bottom and poisons catch-up. The report intentionally bypasses the sync seam's
     * observed-unpinned preserve branch (shouldRestoreViewport:false routes straight to
     * markSessionLiveTailIntent): exit-time bottom is a deliberate, deterministic signal.
    */
    const flushExitLiveTailIntent = React.useCallback((options?: Readonly<{ deferEmit?: boolean }>) => {
        if (Platform.OS === 'web') return;
        // Real navigation detaches the list ref before the passive unmount cleanup runs —
        // fall back to the last observed distance (kept honest by the passive bottom-arrival
        // branch) when the live read is unavailable.
        const distanceFromBottom = readCurrentNativeDistanceFromBottom() ?? lastPinOffsetForIntentRef.current;
        if (distanceFromBottom == null || distanceFromBottom > pinThresholdPx) return;
        const emit = onViewportChangeRef.current;
        if (!emit) return;
        const liveTailState = { isPinned: true, offsetY: 0, shouldRestoreViewport: false };
        if (options?.deferEmit === true) {
            queueMicrotask(() => {
                emit(liveTailState);
            });
            return;
        }
        emit(liveTailState);
    }, [pinThresholdPx, readCurrentNativeDistanceFromBottom]);
    React.useLayoutEffect(() => {
        flushExitLiveTailIntentRef.current = flushExitLiveTailIntent;
    }, [flushExitLiveTailIntent]);

    const refreshInFlightWebPrependAnchor = React.useCallback((options?: Readonly<{ userScrolledDuringLoad?: boolean }>) => {
        if (Platform.OS !== 'web') return;
        applyWebPrependOwnerEffects(webPrependOwner.refreshInFlightForUserScroll({
            anchor: captureCurrentWebPrependAnchor(),
            sessionId: props.sessionId,
            userScrolledDuringLoad: options?.userScrolledDuringLoad === true,
        }));
    }, [applyWebPrependOwnerEffects, captureCurrentWebPrependAnchor, props.sessionId, webPrependOwner]);

    const retargetPendingWebPrependAnchorForUserScroll = React.useCallback(() => {
        if (Platform.OS !== 'web') return;
        applyWebPrependOwnerEffects(webPrependOwner.retargetPendingForUserScroll({
            anchor: captureCurrentWebPrependAnchor(),
            sessionId: props.sessionId,
        }));
    }, [applyWebPrependOwnerEffects, captureCurrentWebPrependAnchor, props.sessionId, webPrependOwner]);

    const runWebPrependIndexRecovery = React.useCallback((): boolean => {
        if (Platform.OS !== 'web') return false;
        const facts = webPrependOwner.telemetryFacts({ items: itemsRef.current });
        const recoveryIndex = typeof facts.pendingWebPrependAnchorIndex === 'number'
            ? facts.pendingWebPrependAnchorIndex
            : null;
        const recoveryAnchor = recoveryIndex == null
            ? null
            : resolveRestoreAnchorIdentityFromSourceIndex(recoveryIndex);
        const effects = webPrependOwner.retryPending({
            currentItemIndex: recoveryIndex,
            items: itemsRef.current,
            nowMs: Date.now(),
            recoveryAnchor,
            sessionId: props.sessionId,
        });
        applyWebPrependOwnerEffects(effects);
        return effects.some((effect) => (
            effect.type === 'execute-anchor-recovery' ||
            effect.type === 'execute-web-prepend-restore'
        ));
    }, [
        applyWebPrependOwnerEffects,
        props.sessionId,
        resolveRestoreAnchorIdentityFromSourceIndex,
        webPrependOwner,
    ]);
    runWebPrependIndexRecoveryRef.current = runWebPrependIndexRecovery;

      const renderItem = useCallback(({ item, index }: { item: ChatTranscriptListItem; index: number }) => {
          if (item.kind === 'action-draft') {
              return wrapTranscriptItemForAnchor(item, <SessionActionDraftCard sessionId={props.sessionId} draft={item.draft} />);
          }
        if (item.kind === 'fork-divider') {
            return wrapTranscriptItemForAnchor(item, (
                <TranscriptEnterWrapper id={item.id} createdAt={0}>
                    <ForkDividerRow
                        parentSessionId={item.parentSessionId}
                        childSessionId={item.childSessionId}
                        parentCutoffSeqInclusive={item.parentCutoffSeqInclusive}
                    />
                </TranscriptEnterWrapper>
            ));
        }
        if (item.kind === 'pending-queue') {
            const createdAt = item.pendingMessages[0]?.createdAt ?? item.discardedMessages[0]?.createdAt ?? 0;
            return wrapTranscriptItemForAnchor(item, (
                <TranscriptEnterWrapper id={item.id} createdAt={createdAt}>
                    <PendingMessagesTranscriptBlock
                        sessionId={props.sessionId}
                        pendingMessages={item.pendingMessages}
                        discardedMessages={item.discardedMessages}
                        onEditPendingMessage={props.onEditPendingMessage}
                    />
                </TranscriptEnterWrapper>
            ));
        }
        if (item.kind === 'pending-user-action') {
            return wrapTranscriptItemForAnchor(item, (
                <TranscriptEnterWrapper id={item.id} createdAt={item.createdAt}>
                    <UserActionPromptCard
                        chrome="card"
                        request={item.request}
                        location={null}
                        sessionId={props.sessionId}
                        metadata={props.metadata}
                        canApprovePermissions={props.interaction.permissionDisabledReason === 'inactive'
                            ? true
                            : props.interaction.canApprovePermissions}
                        disabledReason={props.interaction.permissionDisabledReason === 'inactive'
                            ? undefined
                            : props.interaction.permissionDisabledReason}
                    />
                </TranscriptEnterWrapper>
            ));
        }
        if (item.kind === 'tool-calls-group') {
            const interaction = deriveReadOnlyTranscriptInteraction(props.interaction, item.isReadOnlyContext === true);
            return wrapTranscriptItemForAnchor(item, (
                <ToolCallsGroupRowWithSessionCommon
                    sessionId={props.sessionId}
                    toolCallsGroupId={item.id}
                    toolMessageIds={item.toolMessageIds}
                    metadata={props.metadata}
                    expanded={item.toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id))}
                    onSetExpanded={setToolCallsGroupExpanded}
                    interaction={interaction}
                    approvalRequests={props.approvalRequests}
                    getMessageById={props.forkedTranscriptEnabled ? getTurnMessageById : undefined}
                    messagePins={props.messagePins}
                    onToggleToolPin={props.onToggleMessagePin}
                    forkCommon={props.forkCommon}
                    messageDisplayCommon={props.messageDisplayCommon}
                    toolChromeCommon={props.toolChromeCommon}
                    toolRouteCommon={toolRouteCommonRef.current}
                />
            ));
        }
        if (item.kind === 'tool-group-header') {
            const interaction = deriveReadOnlyTranscriptInteraction(props.interaction, item.isReadOnlyContext === true);
            const headerToolMessageIds = item.toolMessageIds;
            const headerGroupId = item.groupId;
            return wrapTranscriptItemForAnchor(item, (
                <ToolCallsGroupUnitHeaderRowWithSessionCommon
                    sessionId={props.sessionId}
                    groupId={item.groupId}
                    metadata={props.metadata}
                    interaction={interaction}
                    toolMessages={resolveToolCallMessagesForIds(item.toolMessageIds)}
                    expanded={item.expanded}
                    setExpanded={(expanded: boolean) => setToolCallsGroupExpanded({
                        toolCallsGroupId: headerGroupId,
                        toolMessageIds: headerToolMessageIds,
                        expanded,
                    })}
                    forkCommon={props.forkCommon}
                    messageDisplayCommon={props.messageDisplayCommon}
                    toolChromeCommon={props.toolChromeCommon}
                    toolRouteCommon={toolRouteCommonRef.current}
                />
            ));
        }
        if (item.kind === 'tool-group-expand') {
            const interaction = deriveReadOnlyTranscriptInteraction(props.interaction, item.isReadOnlyContext === true);
            const expandToolMessageIds = item.toolMessageIds;
            const expandGroupId = item.groupId;
            return wrapTranscriptItemForAnchor(item, (
                <ToolCallsGroupUnitExpandRowWithSessionCommon
                    sessionId={props.sessionId}
                    groupId={item.groupId}
                    metadata={props.metadata}
                    interaction={interaction}
                    hiddenCount={item.hiddenCount}
                    setExpanded={(expanded: boolean) => setToolCallsGroupExpanded({
                        toolCallsGroupId: expandGroupId,
                        toolMessageIds: expandToolMessageIds,
                        expanded,
                    })}
                    forkCommon={props.forkCommon}
                    messageDisplayCommon={props.messageDisplayCommon}
                    toolChromeCommon={props.toolChromeCommon}
                    toolRouteCommon={toolRouteCommonRef.current}
                />
            ));
        }
        if (item.kind === 'tool-group-tool') {
            const interaction = deriveReadOnlyTranscriptInteraction(props.interaction, item.isReadOnlyContext === true);
            const toolMessage = getTurnMessageById(item.toolMessageId);
            return wrapTranscriptItemForAnchor(item, toolMessage?.kind === 'tool-call' ? (
                <ToolCallsGroupUnitToolRowWithSessionCommon
                    sessionId={props.sessionId}
                    groupId={item.groupId}
                    metadata={props.metadata}
                    interaction={interaction}
                    message={toolMessage}
                    expanded={item.expanded}
                    approvalRequests={props.approvalRequests}
                    messagePins={props.messagePins}
                    onToggleToolPin={props.onToggleMessagePin}
                    forkCommon={props.forkCommon}
                    messageDisplayCommon={props.messageDisplayCommon}
                    toolChromeCommon={props.toolChromeCommon}
                    toolRouteCommon={toolRouteCommonRef.current}
                />
            ) : null);
        }
        if (item.kind === 'tool-group-footer') {
            const interaction = deriveReadOnlyTranscriptInteraction(props.interaction, item.isReadOnlyContext === true);
            return wrapTranscriptItemForAnchor(item, (
                <ToolCallsGroupUnitFooterRowWithSessionCommon
                    sessionId={props.sessionId}
                    groupId={item.groupId}
                    metadata={props.metadata}
                    interaction={interaction}
                    forkCommon={props.forkCommon}
                    messageDisplayCommon={props.messageDisplayCommon}
                    toolChromeCommon={props.toolChromeCommon}
                    toolRouteCommon={toolRouteCommonRef.current}
                />
            ));
        }
        if (item.kind === 'turn') {
            const rowActiveThinkingMessageId = resolveTranscriptItemActiveThinkingMessageId(item, props.activeThinkingMessageId);
            const turnCreatedAt =
                (item.turn.userMessageId ? resolveCreatedAtForMessageId(item.turn.userMessageId) : null) ??
                (item.turn.content[0]?.kind === 'message'
                    ? resolveCreatedAtForMessageId(item.turn.content[0].messageId)
                    : item.turn.content[0]?.kind === 'tool_calls'
                        ? (item.turn.content[0].toolMessageIds[0]
                            ? resolveCreatedAtForMessageId(item.turn.content[0].toolMessageIds[0])
                            : null)
                        : null) ??
                0;
            return wrapTranscriptItemForAnchor(item, (
                <TranscriptEnterWrapper id={item.id} createdAt={turnCreatedAt}>
                          <TurnViewWithSessionCommon
                           turn={item.turn}
                           metadata={props.metadata}
                           sessionId={props.sessionId}
                           interaction={props.interaction}
                           activeThinkingMessageId={rowActiveThinkingMessageId}
                           getMessageById={getTurnMessageById}
                           getMessageOrigin={getTurnMessageOrigin}
                           approvalRequests={props.approvalRequests}
                           messagePins={props.messagePins}
                           onToggleMessagePin={props.onToggleMessagePin}
                           rollbackRanges={props.rollbackRanges}
                           resolveRollbackAction={resolveRollbackActionForMessage}
                             resolveThinkingExpanded={resolveThinkingExpanded}
                             setThinkingExpanded={setThinkingExpanded}
                           expandedToolCallsAnchorMessageIds={expandedToolCallsAnchorMessageIds}
                          setToolCallsGroupExpanded={setToolCallsGroupExpanded}
                          forkCommon={props.forkCommon}
                          messageDisplayCommon={props.messageDisplayCommon}
                          toolChromeCommon={props.toolChromeCommon}
                          toolRouteCommon={toolRouteCommonRef.current}
                      />
                  </TranscriptEnterWrapper>
              ));
          }
        if (item.kind === 'message') {
            const rowActiveThinkingMessageId = resolveTranscriptItemActiveThinkingMessageId(item, props.activeThinkingMessageId);
            const toolChromeMode = toolTimelineChromeMode === 'activity_feed' ? 'activity_feed' : 'cards';
            // N3.1: the chronologically-previous (older) row is index - 1 in standard
            // orientation and index + 1 under inverted (rendered order is newest-first).
            // Hot/cold split: cold rows carry a `listData` index, hot-tail rows carry a full
            // `displayItems` index. Resolve the neighbor against whichever array actually holds
            // the item at this index — when the split is OFF both refs are the same array, so this
            // is identical to the full-array lookup (no behavior change).
            const neighborItems = listDataRef.current[index]?.id === item.id
                ? listDataRef.current
                : itemsRef.current;
            const olderNeighborIndex = resolveOlderNeighborRenderedIndex(
                index,
                neighborItems.length,
                listOrientation,
            );
            const prev = olderNeighborIndex != null
                ? neighborItems[olderNeighborIndex]
                : undefined;
            const shouldTightenToolStack =
                toolChromeMode === 'activity_feed' &&
                resolveKindForMessageId(item.messageId) === 'tool-call' &&
                prev?.kind === 'message' &&
                resolveKindForMessageId(prev.messageId) === 'tool-call';
            const wrapperStyle = shouldTightenToolStack ? { marginTop: -12 } : undefined;

            return wrapTranscriptItemForAnchor(item, (
                <TranscriptEnterWrapper id={item.id} createdAt={item.createdAt}>
                    <View style={wrapperStyle}>
                        <ChatListMessageRow
                            sessionId={props.sessionId}
                            messageId={item.messageId}
                            messageOverride={item.originSessionId ? (props.messagesById[item.messageId] ?? null) : undefined}
                            originSessionId={item.originSessionId}
                            isReadOnlyContext={item.isReadOnlyContext}
                            metadata={props.metadata}
                            activeThinkingMessageId={rowActiveThinkingMessageId}
                            resolveThinkingExpanded={resolveThinkingExpanded}
                            setThinkingExpanded={setThinkingExpanded}
                            interaction={props.interaction}
                            rollbackAction={props.rollbackActionsByMessageId[item.messageId] ?? null}
                            rollbackRanges={props.rollbackRanges}
                            approvalRequests={props.approvalRequests}
                            messagePins={props.messagePins}
                            onToggleMessagePin={props.onToggleMessagePin}
                            forkCommon={props.forkCommon}
                            messageDisplayCommon={props.messageDisplayCommon}
                            toolChromeCommon={props.toolChromeCommon}
                            toolRouteCommon={toolRouteCommonRef.current}
                        />
                    </View>
                </TranscriptEnterWrapper>
            ));
        }
        return null;
      }, [expandedToolCallsAnchorMessageIds, getTurnMessageById, getTurnMessageOrigin, listOrientation, props.activeThinkingMessageId, props.approvalRequests, props.forkCommon, props.interaction, props.messageDisplayCommon, props.messagePins, props.metadata, props.onToggleMessagePin, props.rollbackRanges, props.sessionId, props.toolChromeCommon, resolveCreatedAtForMessageId, resolveKindForMessageId, resolveRollbackActionForMessage, resolveThinkingExpanded, resolveToolCallMessagesForIds, setThinkingExpanded, setToolCallsGroupExpanded, toolTimelineChromeMode, wrapTranscriptItemForAnchor]);
    const renderTranscriptItemAtIndex = React.useCallback((item: ChatTranscriptListItem, index: number) => {
        return renderItem({ item, index });
    }, [renderItem]);
    const listHeaderNode = React.useMemo(() => (
        <ListHeader />
    ), []);

    const loadOlder = useCallback(async (options: LoadOlderOptions = {}): Promise<{
        loaded: number;
        hasMore: boolean;
        status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight';
    } | null> => {
        if (!props.isLoaded && props.forkedTranscriptEnabled !== true) return null;
        const showLoadingIndicator = options.showLoadingIndicator !== false;
        const preservePrependViewport = options.preservePrependViewport !== false;
        if (loadOlderInFlight.current || hasMoreOlderRef.current === false || hasMoreOlder === false) {
            if (loadOlderInFlight.current && showLoadingIndicator && options.loadingIndicatorDelayMs === 0) {
                showOlderLoadSpinner();
            }
            return null;
        }
        loadOlderInFlight.current = true;
        const loadingIndicatorDelayMs = typeof options.loadingIndicatorDelayMs === 'number' && Number.isFinite(options.loadingIndicatorDelayMs)
            ? Math.max(0, Math.trunc(options.loadingIndicatorDelayMs))
            : 0;
        if (!showLoadingIndicator) {
            clearOlderLoadSpinnerDelay();
        } else if (loadingIndicatorDelayMs > 0) {
            olderLoadSpinnerDelayTimeoutRef.current = setTimeout(() => {
                olderLoadSpinnerDelayTimeoutRef.current = null;
                setIsLoadingOlder(true);
            }, loadingIndicatorDelayMs);
        } else {
            showOlderLoadSpinner();
        }
        let loadCompleted = false;
        try {
            if (
                preservePrependViewport &&
                entrySliceWindowRef.current?.sessionId === props.sessionId
            ) {
                // N2b.2: a user-triggered older load while the slice window is still
                // active reveals the withheld LOCAL rows first (one prepend-observed
                // commit, no network) — the next load paginates normally.
                const revealed = revealEntrySliceWindowRef.current();
                if (revealed > 0) {
                    loadCompleted = true;
                    return {
                        loaded: revealed,
                        // The top guard already excluded `false`; null means unknown → assume more.
                        hasMore: hasMoreOlderRef.current ?? true,
                        status: 'loaded',
                    };
                }
            }
            if (Platform.OS === 'web') {
                const webPrependAnchorBeforeLoad = preservePrependViewport ? captureCurrentWebPrependAnchor() : null;
                applyWebPrependOwnerEffects(webPrependOwner.beforeLoad({
                    anchor: webPrependAnchorBeforeLoad,
                    preservePrependViewport,
                    sessionId: props.sessionId,
                }));
            }
            const syncLoadOlderOptions = resolveSyncLoadOlderOptions();
            const result = props.forkedTranscriptEnabled
                ? (syncLoadOlderOptions
                    ? await sync.loadOlderMessagesForkAware(props.sessionId, syncLoadOlderOptions)
                    : await sync.loadOlderMessagesForkAware(props.sessionId))
                : (syncLoadOlderOptions
                    ? await sync.loadOlderMessages(props.sessionId, syncLoadOlderOptions)
                    : await sync.loadOlderMessages(props.sessionId));

            if (Platform.OS === 'web') {
                const webPrependAfterLoadEffects = webPrependOwner.afterLoad({
                    activeOwner: viewportCommandController.activeOwner(),
                    loadedRowCount: result.loaded,
                    nowMs: Date.now(),
                    preservePrependViewport,
                    sessionId: props.sessionId,
                });
                applyWebPrependOwnerEffects(webPrependAfterLoadEffects);
            }
            loadCompleted = true;
            if (result.status === 'no_more') {
                hasMoreOlderRef.current = false;
                setHasMoreOlder(false);
            } else if (result.status === 'loaded' || result.status === 'not_ready' || result.status === 'in_flight') {
                hasMoreOlderRef.current = result.hasMore;
                setHasMoreOlder(result.hasMore);
            }
            return {
                loaded: result.loaded,
                hasMore: result.hasMore,
                status: result.status,
            };
        } finally {
            if (Platform.OS === 'web' && !loadCompleted) {
                applyWebPrependOwnerEffects(webPrependOwner.clear({
                    outcome: 'abandoned-identity',
                    sessionId: props.sessionId,
                }));
            }
            if (!loadCompleted && nativePrependOwner.hasOpenTransaction(props.sessionId)) {
                applyNativePrependOwnerEffects(nativePrependOwner.invalidate({
                    activeOwner: viewportCommandController.activeOwner(),
                    reason: 'load-empty',
                    sessionId: props.sessionId,
                }));
            }
            hideOlderLoadSpinner();
            loadOlderInFlight.current = false;
        }
    }, [
        applyNativePrependOwnerEffects,
        applyWebPrependOwnerEffects,
        captureCurrentWebPrependAnchor,
        clearOlderLoadSpinnerDelay,
        hasMoreOlder,
        hideOlderLoadSpinner,
        nativePrependOwner,
        pinThresholdPx,
        props.committedMessagesCount,
        props.forkedTranscriptEnabled,
        props.isLoaded,
        props.sessionId,
        resolveSyncLoadOlderOptions,
        showOlderLoadSpinner,
        viewportCommandController,
        webPrependOwner,
    ]);
    loadOlderForAnchorLookupRef.current = loadOlder;

    const paginationLoadOlder = React.useCallback(async () => {
        if (hasMoreOlderRef.current === false) {
            return { loaded: 0, hasMore: false, status: 'no_more' as const };
        }
        // The hook owns pacing and the loading indicator (plan D2/D3).
        return await loadOlder({ showLoadingIndicator: false });
    }, [loadOlder]);

    // Single owner of user-triggered older pagination (plan D2): machine-driven hook shared
    // with ChainTranscriptList; replaces the deleted dwell scheduler family. Suspension while
    // any viewport transaction is open comes from the ownership machine.
    const olderPagination = useTranscriptOlderPagination({
        enabled: true,
        loadOlder: paginationLoadOlder,
        thresholdPx: resolveBackwardPrefetchThresholdPx(listLayoutHeight),
        cooldownMs: sync.getSyncTuning().transcriptOlderLoadCooldownMs,
        spinnerDelayMs: sync.getSyncTuning().transcriptOlderLoadSpinnerDelayMs,
        isFillDone: () => sessionOpenLatch.initialFillStatus() === 'done',
        isTransactionOpen: () => viewportCommandController.activeOwner() !== 'follow',
    });
    olderPaginationSnapshotRef.current = olderPagination.getSnapshot();
    resetOlderPaginationRef.current = olderPagination.reset;
    const onOlderPaginationScrollObservation = olderPagination.onScrollObservation;

    const observeOlderPaginationScroll = React.useCallback((params: Readonly<{
        offsetY: number;
        layoutHeight: number;
        contentHeight: number;
        distanceFromBottom: number;
        webMetrics?: WebTranscriptScrollMetrics | null;
        trigger?: 'scroll' | 'edge-reached';
    }>) => {
        const usesWebDomMetrics = Platform.OS === 'web' && params.webMetrics != null;
        const layoutHeight = usesWebDomMetrics ? params.webMetrics!.clientHeight : params.layoutHeight;
        const contentHeight = usesWebDomMetrics ? params.webMetrics!.scrollHeight : params.contentHeight;
        const offsetY = usesWebDomMetrics ? params.webMetrics!.scrollTop : params.offsetY;
        const distanceFromBottom = usesWebDomMetrics
            ? getWebTranscriptDistanceFromBottom(params.webMetrics!)
            : params.distanceFromBottom;
        const scrollable = usesWebDomMetrics
            ? isWebTranscriptScrollable(params.webMetrics!, 16)
            : layoutHeight > 0 && contentHeight > layoutHeight + 16;
        // The follow-mode gate stays consumer-side (Lane D contract): no top prefetch while
        // the native mode machine reports 'following' or the viewport wants the bottom.
        const followGateOpen = Platform.OS === 'web'
            ? !(wantsPinnedRef.current && distanceFromBottom <= pinThresholdPx)
            : bottomFollowModeStateRef.current.mode !== 'following' && !wantsPinnedRef.current;
        onOlderPaginationScrollObservation({
            offsetY,
            scrollable: scrollable && followGateOpen,
            trigger: params.trigger,
        });
        if (Platform.OS === 'web') {
            const snapshot = olderPagination.getSnapshot();
            recordViewportTelemetryEvent({
                type: 'scroll-observed',
                mode: resolveViewportTelemetryMode(),
                reason: 'observed',
                offsetY,
                layoutHeight,
                contentHeight,
                distanceFromBottom,
                ...resolveWebViewportTelemetryDiagnostics({
                    metrics: params.webMetrics,
                    flashListContentHeight: params.contentHeight,
                    flashListLayoutHeight: params.layoutHeight,
                    paginationPhase: snapshot.phase,
                    paginationSuspendedReasons: snapshot.suspendedReasons,
                    programmaticWebWrite: false,
                    scrollable: scrollable && followGateOpen,
                    trigger: params.trigger ?? 'scroll',
                }),
            });
        }
    }, [
        olderPagination,
        onOlderPaginationScrollObservation,
        pinThresholdPx,
        recordViewportTelemetryEvent,
        resolveViewportTelemetryMode,
        resolveWebViewportTelemetryDiagnostics,
    ]);

    const resolveActiveTargetWindowContinuationTarget = React.useCallback((): TranscriptJumpTarget | null => {
        const activeWindowState = targetWindowHostFacts.activeWindowState;
        const targetSeq = activeWindowState?.targetSeq;
        if (typeof targetSeq !== 'number' || !Number.isFinite(targetSeq)) return null;
        const normalizedTargetSeq = Math.trunc(targetSeq);
        const rememberedTarget = activeTargetWindowTargetRef.current;
        const rememberedTargetSeq = rememberedTarget?.kind === 'seq'
            ? rememberedTarget.seq
            : rememberedTarget?.seqHint;
        if (
            typeof rememberedTargetSeq === 'number' &&
            Number.isFinite(rememberedTargetSeq) &&
            Math.trunc(rememberedTargetSeq) === normalizedTargetSeq
        ) {
            return rememberedTarget;
        }
        return { kind: 'seq', seq: normalizedTargetSeq };
    }, [targetWindowHostFacts.activeWindowState]);

    const loadTargetWindowPageAtEdge = React.useCallback(async (direction: 'older' | 'newer') => {
        const activeWindowState = targetWindowHostFacts.activeWindowState;
        if (!activeWindowState || !props.sessionId) return;
        if (direction === 'older' && activeWindowState.hasMoreOlder !== true) return;
        if (direction === 'newer' && activeWindowState.hasMoreNewer !== true) {
            if (activeWindowState.hasMoreNewer === false) {
                sync.markSessionLiveTailIntent(props.sessionId);
                activeTargetWindowTargetRef.current = null;
            }
            return;
        }
        if (targetWindowEdgeLoadInFlightRef.current[direction]) return;
        const target = resolveActiveTargetWindowContinuationTarget();
        if (!target) return;
        targetWindowEdgeLoadInFlightRef.current[direction] = true;
        try {
            const routeSeqHint = target.kind === 'route-message-id' && typeof target.seqHint === 'number' && Number.isFinite(target.seqHint)
                ? Math.trunc(target.seqHint)
                : null;
            const loadTarget = target.kind === 'seq'
                ? { kind: 'seq' as const, seq: Math.trunc(target.seq) }
                : routeSeqHint != null
                    ? {
                        kind: 'route-message-id' as const,
                        routeMessageId: target.routeMessageId,
                        seqHint: routeSeqHint,
                    }
                    : null;
            if (!loadTarget) return;
            const result = await sync.loadTargetWindowMessages(props.sessionId, loadTarget, { direction });
            if (result?.status === 'loaded' && result.targetPresent) {
                activeTargetWindowTargetRef.current = target;
            }
        } finally {
            targetWindowEdgeLoadInFlightRef.current[direction] = false;
        }
    }, [
        props.sessionId,
        resolveActiveTargetWindowContinuationTarget,
        targetWindowHostFacts.activeWindowState,
    ]);

    /**
     * FlashList can miss onStartReached (#1785); the older visual edge feeds one
     * more canonical-space observation to the pagination machine. The callback
     * source itself is authoritative: under inverted data-start is visual bottom,
     * and stale ref offsets from a previous frame must never turn that bottom
     * callback into an older-page load.
     */
    const observePaginationEdgeReachedNudge = React.useCallback((visualEdge: 'older' | 'newer') => {
        if (targetWindowActiveRef.current) {
            void loadTargetWindowPageAtEdge(visualEdge);
            return;
        }
        if (visualEdge !== 'older') return;
        const liveWebMetrics = Platform.OS === 'web' ? resolveWebScrollMetrics() : null;
        const rawEdgeOffset = liveWebMetrics
            ? liveWebMetrics.scrollTop
            : readNativeAbsoluteScrollOffset(listRef.current);
        if (typeof rawEdgeOffset !== 'number') return;
        const layoutH = liveWebMetrics?.clientHeight ?? listLayoutHeightRef.current;
        const contentH = liveWebMetrics?.scrollHeight ?? listContentHeightRef.current;
        const nativeObservedOffset = liveWebMetrics
            ? null
            : resolveNativeObservedScrollOffset(rawEdgeOffset, { contentHeight: contentH, layoutHeight: layoutH });
        const canonicalEdgeOffset = liveWebMetrics ? rawEdgeOffset : nativeObservedOffset?.canonicalOffsetY;
        if (typeof canonicalEdgeOffset !== 'number') return;
        observeOlderPaginationScroll({
            offsetY: canonicalEdgeOffset,
            layoutHeight: layoutH,
            contentHeight: contentH,
            distanceFromBottom: liveWebMetrics
                ? Math.max(0, Math.trunc(contentH - layoutH - canonicalEdgeOffset))
                : nativeObservedOffset?.distanceFromLiveTailPx ?? 0,
            webMetrics: liveWebMetrics,
            trigger: 'edge-reached',
        });
    }, [
        loadTargetWindowPageAtEdge,
        observeOlderPaginationScroll,
        resolveNativeObservedScrollOffset,
        resolveWebScrollMetrics,
    ]);

    const observeWebPrependOwner = React.useCallback(() => {
        if (Platform.OS !== 'web') return;
        const effects = webPrependOwner.observePending({
            nowMs: Date.now(),
            sessionId: props.sessionId,
        });
        applyWebPrependOwnerEffects(effects);
    }, [applyWebPrependOwnerEffects, listContentHeight, listData.length, props.sessionId, webPrependOwner]);

    React.useLayoutEffect(() => {
        observeWebPrependOwner();
    }, [listContentHeight, listData.length, observeWebPrependOwner]);

        const tryPinToBottomDom = React.useCallback((reason: TranscriptViewportTelemetryScrollReason = 'initial-open'): boolean => {
            if (reason === 'jump-to-bottom') {
                return executeViewportCommand(resolveViewportCommand({
                    type: 'jump-to-bottom',
                    sessionId: props.sessionId,
                }));
            }
            if (reason === 'initial-open') {
                return executeViewportCommand(resolveViewportCommand({
                    type: 'first-paint',
                    sessionId: props.sessionId,
                    shouldFollowBottom: true,
                    entrySnapshot: null,
                    jumpToSeq: null,
                }));
            }
            if (reason === 'jump-to-seq') {
                return executeViewportCommand(resolveViewportCommand({
                    type: 'pin-bottom',
                    sessionId: props.sessionId,
                    reason,
                    mode: 'jump-to-seq',
                }));
            }
            return executeViewportCommand(resolveViewportCommand({
                type: 'auto-follow',
                sessionId: props.sessionId,
                distanceFromBottom: Number.MAX_SAFE_INTEGER,
                pinThresholdPx,
                recentUserIntent: false,
                wantsPinned: true,
                reason,
            }));
        }, [
            executeViewportCommand,
            pinThresholdPx,
            props.sessionId,
            resolveViewportCommand,
            telemetryPlatform,
        ]);

    const resolveSeqForViewportAnchor = React.useCallback((anchor: SessionViewportAnchorSnapshot): number | null => {
        const anchorMessageId = typeof anchor.messageId === 'string' && anchor.messageId.length > 0
            ? anchor.messageId
            : null;
        const messageSeq = anchorMessageId ? resolveSeqForMessageId(anchorMessageId) : null;
        const normalizeSeq = (value: unknown): number | null => {
            if (typeof value !== 'number' || !Number.isFinite(value)) return null;
            const seq = Math.trunc(value);
            return seq > 0 ? seq : null;
        };
        return normalizeSeq(messageSeq) ?? normalizeSeq(anchor.seq);
    }, [resolveSeqForMessageId]);

    const resolveViewportItemSeqs = React.useCallback((item: ChatTranscriptListItem): number[] => {
        const seqs: number[] = [];
        const addSeq = (seq: number | null | undefined) => {
            if (typeof seq === 'number' && Number.isFinite(seq)) seqs.push(Math.trunc(seq));
        };
        if (item.kind === 'message') {
            addSeq(item.seq ?? resolveSeqForMessageId(item.messageId));
            return seqs;
        }
        if (item.kind === 'tool-calls-group') {
            for (const toolMessageId of item.toolMessageIds) {
                addSeq(resolveSeqForMessageId(toolMessageId));
            }
            return seqs;
        }
        // Per-unit rows: a tool unit resolves its OWN seq; header/expand/footer caps
        // resolve none, so nearest surviving anchors land on a real row.
        if (item.kind === 'tool-group-tool') {
            addSeq(item.seq ?? resolveSeqForMessageId(item.toolMessageId));
            return seqs;
        }
        if (item.kind === 'turn') {
            if (item.turn.userMessageId) {
                addSeq(resolveSeqForMessageId(item.turn.userMessageId));
            }
            for (const content of item.turn.content) {
                if (content.kind === 'message') {
                    addSeq(resolveSeqForMessageId(content.messageId));
                } else if (content.kind === 'tool_calls') {
                    for (const toolMessageId of content.toolMessageIds) {
                        addSeq(resolveSeqForMessageId(toolMessageId));
                    }
                }
            }
        }
        return seqs;
    }, [resolveSeqForMessageId]);

    const resolveNearestSurvivingViewportAnchorIndex = React.useCallback((anchor: SessionViewportAnchorSnapshot): number | null => {
        const anchorSeq = resolveSeqForViewportAnchor(anchor);
        if (anchorSeq == null) return null;

        type AnchorIndexCandidate = { index: number; seq: number };
        let earlier: AnchorIndexCandidate | null = null;
        let later: AnchorIndexCandidate | null = null;

        const items = listDataRef.current;
        for (let index = 0; index < items.length; index += 1) {
            const item = items[index]!;
            for (const normalizedSeq of resolveViewportItemSeqs(item)) {
                if (normalizedSeq < anchorSeq) {
                    if (!earlier || normalizedSeq > earlier.seq) earlier = { index, seq: normalizedSeq };
                    continue;
                }
                if (normalizedSeq > anchorSeq) {
                    if (!later || normalizedSeq < later.seq) later = { index, seq: normalizedSeq };
                }
            }
        }

        return earlier?.index ?? later?.index ?? null;
    }, [resolveSeqForViewportAnchor, resolveViewportItemSeqs]);

    const isViewportAnchorSeqLoaded = React.useCallback((anchorSeq: number, items: readonly ChatTranscriptListItem[]): boolean => {
        const normalizedAnchorSeq = Math.trunc(anchorSeq);
        for (const item of items) {
            if (resolveViewportItemSeqs(item).some((seq) => seq === normalizedAnchorSeq)) return true;
        }
        return false;
    }, [resolveViewportItemSeqs]);

    const resolveEntryRestoreOwnerAnchor = React.useCallback((
        anchor: SessionViewportAnchorSnapshot,
        resolvedIndex: number | null,
    ): EntryRestoreOwnerAnchor | null => {
        const currentIdentity = resolvedIndex != null
            ? resolveRestoreAnchorIdentityFromSourceIndex(resolvedIndex)
            : null;
        const fallbackIdentity = normalizeRestoreAnchorIdentity(anchor);
        const identity = currentIdentity ?? fallbackIdentity;
        if (!identity) return null;
        return {
            ...identity,
            capturedAtMs: anchor.capturedAtMs,
            itemOffsetPx: anchor.itemOffsetPx,
            seq: resolveSeqForViewportAnchor(anchor),
        };
    }, [resolveRestoreAnchorIdentityFromSourceIndex, resolveSeqForViewportAnchor]);

    React.useLayoutEffect(() => {
        observeNativePrependOwner();
    }, [
        listContentHeight,
        listData.length,
        observeNativePrependOwner,
        props.sessionId,
    ]);

    const handleNativeRestoreIndexFailure = React.useCallback((failedIndex: number): boolean => {
        if (Platform.OS === 'web') return false;
        const lastCommand = lastNativeRestoreIndexCommandRef.current;
        if (!lastCommand || lastCommand.sessionId !== props.sessionId || lastCommand.index !== failedIndex) return false;
        if (lastCommand.reason === 'jump-to-seq') return false;

        // entry-restore index failures need no recovery scheduling (plan F2): the transaction
        // either confirms through a later conclusive observation or closes at its deadline.
        return lastCommand.reason === 'entry-restore';
    }, [
        props.sessionId,
    ]);

    const canRequestBoundedEntryViewportMaterialization = React.useCallback((): boolean => {
        if (anchorLookupExhaustedRef.current) return false;
        if (anchorLookupInFlightRef.current) return true;
        if (!loadOlderForAnchorLookupRef.current) return false;
        return anchorLookupLoadCountRef.current < sync.getSyncTuning().transcriptViewportAnchorOlderLookupMaxLoads;
    }, []);

    const resolveEntryRestoreCanonicalMetrics = React.useCallback((): { contentHeight: number; layoutHeight: number } => {
        if (Platform.OS === 'web') {
            const metrics = resolveWebScrollMetrics();
            return {
                contentHeight: metrics ? Math.max(0, Math.trunc(metrics.scrollHeight)) : 0,
                layoutHeight: metrics ? Math.max(0, Math.trunc(metrics.clientHeight)) : 0,
            };
        }
        // A6: ONE canonical native content basis — the scroll-event contentSize. The measured
        // ref carries the composer inset added back by the measurement host, so the canonical
        // basis subtracts it again; entry alignment checks in onScroll read the same basis
        // directly from the scroll event.
        if (!hasNativeContentMeasurementForCurrentSession()) {
            return { contentHeight: 0, layoutHeight: listLayoutHeightRef.current };
        }
        const contentHeight = Math.max(0, Math.trunc(listContentHeightRef.current - composerInsetHeightRef.current));
        return { contentHeight, layoutHeight: listLayoutHeightRef.current };
    }, [hasNativeContentMeasurementForCurrentSession, resolveWebScrollMetrics]);

    const applyEntryRestoreOwnerEffects = React.useCallback((
        effects: readonly EntryRestoreOwnerEffect[],
    ) => {
        for (const effect of effects) {
            switch (effect.type) {
                case 'execute-command': {
                    let issued = false;
                    if (effect.command.type === 'restore-web-anchor-through-command') {
                        const restoreResult = restoreWebViewportAnchorThroughViewportCommand({
                            anchor: {
                                ...effect.command.anchor,
                                messageId: effect.command.anchor.messageId ?? null,
                            },
                            itemIndex: effect.command.itemIndex,
                        });
                        issued = didWebViewportAnchorRestoreSucceed(restoreResult);
                        if (issued) {
                            const metrics = resolveWebScrollMetrics();
                            if (metrics) {
                                applyEntryRestoreOwnerEffectsRef.current(entryRestoreOwner.observeWeb({
                                    contentHeight: metrics.scrollHeight,
                                    layoutHeight: metrics.clientHeight,
                                    nowMs: Date.now(),
                                    observation: { status: 'aligned' },
                                    sessionId: props.sessionId,
                                }));
                            }
                        }
                    } else {
                        const command = resolveViewportCommand(effect.command);
                        const commandWithContentHeight =
                            Platform.OS !== 'web' &&
                            command.kind === 'restore-distance' &&
                            effect.command.type === 'restore-distance' &&
                            typeof effect.command.contentHeight === 'number'
                                ? { ...command, contentHeight: effect.command.contentHeight }
                                : command;
                        issued = executeViewportCommand(commandWithContentHeight);
                    }
                    if (!issued) {
                        applyEntryRestoreOwnerEffectsRef.current(entryRestoreOwner.markInitialCommandFailed({
                            sessionId: props.sessionId,
                        }));
                    }
                    break;
                }
                case 'schedule-entry-deadline': {
                    const scheduled = entryRestoreDeadlineTimeoutRef.current;
                    if (scheduled) {
                        entryRestoreDeadlineTimeoutRef.current = null;
                        clearTimeout(scheduled.timeoutId);
                    }
                    const handle = {
                        sessionId: effect.sessionId,
                        timeoutId: null as unknown as ReturnType<typeof setTimeout>,
                    };
                    handle.timeoutId = setTimeout(() => {
                        if (entryRestoreDeadlineTimeoutRef.current !== handle) return;
                        entryRestoreDeadlineTimeoutRef.current = null;
                        applyEntryRestoreOwnerEffectsRef.current(entryRestoreOwner.runDeadline({
                            nowMs: Number.MAX_SAFE_INTEGER,
                            sessionId: handle.sessionId,
                        }));
                    }, Math.max(0, Math.trunc(effect.deadlineMs)));
                    entryRestoreDeadlineTimeoutRef.current = handle;
                    break;
                }
                case 'clear-entry-deadline': {
                    const scheduled = entryRestoreDeadlineTimeoutRef.current;
                    if (!scheduled) break;
                    entryRestoreDeadlineTimeoutRef.current = null;
                    clearTimeout(scheduled.timeoutId);
                    break;
                }
                case 'set-native-initial-viewport-pending-observation':
                    updateNativeInitialViewportPendingObservation(effect.pending);
                    break;
                case 'set-entry-slice-window':
                    entrySliceWindowRef.current = {
                        anchorRowId: effect.anchorRowId,
                        sessionId: effect.sessionId,
                    };
                    setEntrySliceWindow(entrySliceWindowRef.current);
                    break;
                case 'clear-entry-slice-window':
                    entrySliceWindowRef.current = null;
                    setEntrySliceWindow(null);
                    break;
                case 'request-bounded-materialization':
                    requestBoundedEntryViewportMaterializationRef.current();
                    break;
                case 'request-bottom-follow-write':
                    if (effect.sessionId === props.sessionId) requestBottomFollowScheduledWriteRef.current(null, effect.reason, false, effect.writer);
                    break;
                case 'close-entry-ownership':
                    closeEntryViewportOwnership(effect.outcome);
                    break;
                case 'record-restore-decision':
                    recordRestoreDecisionTelemetry(effect.reason, {
                        mode: effect.mode,
                        offsetY: effect.offsetY,
                        contentHeight: effect.contentHeight,
                        layoutHeight: effect.layoutHeight,
                    });
                    break;
                case 'record-restore-decision-for-session':
                    recordViewportTelemetryEvent({
                        type: 'restore-decision',
                        mode: effect.mode,
                        reason: effect.reason,
                        offsetY: effect.offsetY,
                    }, { sessionId: effect.sessionId });
                    break;
                case 'native-initial-viewport-applied':
                    updateNativeInitialViewportPendingObservation(false);
                    invalidateViewportAnchorCapture();
                    markNativeInitialViewportAppliedForCurrentSession();
                    break;
                case 'schedule-native-entry-paint-release':
                    updateNativeInitialViewportPendingObservation(false);
                    scheduleNativePaintReleaseForEntryRestore({ force: effect.force });
                    break;
                case 'reveal-entry-slice-window':
                    revealEntrySliceWindowRef.current();
                    break;
            }
        }
    }, [
        closeEntryViewportOwnership,
        entryRestoreOwner,
        executeViewportCommand,
        invalidateViewportAnchorCapture,
        markNativeInitialViewportAppliedForCurrentSession,
        props.sessionId,
        recordRestoreDecisionTelemetry,
        recordViewportTelemetryEvent,
        resolveViewportCommand,
        resolveWebScrollMetrics,
        restoreWebViewportAnchorThroughViewportCommand,
        scheduleNativePaintReleaseForEntryRestore,
        updateNativeInitialViewportPendingObservation,
    ]);
    applyEntryRestoreOwnerEffectsRef.current = applyEntryRestoreOwnerEffects;

    /**
     * Disposes an OPEN entry-restore transaction on session exit/unmount (mirror of
     * invalidateNativePrependTransaction): the transaction closes preempted and its outcome
     * is telemetered against the transaction's own session — entry restores must never be
     * dropped silently (plan §4 "every outcome telemetered"). Deliberately applies the
     * owner dispose effects directly: current-session close paths would attribute telemetry
     * to the wrong session across a switch and schedule paint-release work for a lifecycle
     * the exiting session no longer owns.
     */
    const disposeEntryRestoreTransactionForExit = React.useCallback(() => {
        applyEntryRestoreOwnerEffects(entryRestoreOwner.disposeForExit({
            currentSessionId: currentSessionIdRef.current,
        }));
    }, [
        applyEntryRestoreOwnerEffects,
        entryRestoreOwner,
    ]);
    disposeEntryRestoreTransactionForExitRef.current = disposeEntryRestoreTransactionForExit;

    const resolveEntryRestoreDeadlineMs = React.useCallback((): number => {
        const tuning = sync.getSyncTuning();
        return resolveTranscriptInitialFillTuning({
            transcriptInitialFillBudgetMs: tuning.transcriptInitialFillBudgetMs,
            transcriptInitialFillMaxNoProgressLoads: tuning.transcriptInitialFillMaxNoProgressLoads,
        }).budgetMs;
    }, []);

    const requestBoundedEntryViewportMaterialization = React.useCallback((): boolean => {
        if (anchorLookupInFlightRef.current) return true;
        if (anchorLookupExhaustedRef.current) return false;
        const maxLoads = sync.getSyncTuning().transcriptViewportAnchorOlderLookupMaxLoads;
        if (anchorLookupLoadCountRef.current >= maxLoads) return false;
        const loadOlderForAnchorLookup = loadOlderForAnchorLookupRef.current;
        if (!loadOlderForAnchorLookup) return false;

        anchorLookupInFlightRef.current = true;
        anchorLookupLoadCountRef.current += 1;
        fireAndForget((async () => {
            let shouldRetryRestore = false;
            try {
                const result = await loadOlderForAnchorLookup({ preservePrependViewport: false, showLoadingIndicator: false });
                shouldRetryRestore = true;
                if (result && (result.status === 'no_more' || result.hasMore === false)) {
                    anchorLookupExhaustedRef.current = true;
                }
                await Promise.resolve();
                await Promise.resolve();
            } finally {
                anchorLookupInFlightRef.current = false;
            }
            if (shouldRetryRestore) {
                attemptEntryRestoreRef.current();
            }
        })(), { tag: 'ChatList.restoreEntryAnchorLookup' });
        return true;
    }, []);
    requestBoundedEntryViewportMaterializationRef.current = requestBoundedEntryViewportMaterialization;

    /**
     * Web confirm-or-deadline (plan A5): verify the open web entry transaction against live DOM
     * metrics. Conclusive misalignment spends the single correction; stale-height frames are
     * inconclusive and never forwarded (only-conclusive-observations rule).
     */
    const verifyWebEntryRestoreTransaction = React.useCallback(() => {
        if (Platform.OS !== 'web') return;
        const metrics = resolveWebScrollMetrics();
        if (!metrics) return;
        const tolerancePx = Math.max(pinThresholdPx, 2);
        const effects = entryRestoreOwner.observeWebHostFacts({
            contentHeight: metrics.scrollHeight,
            distanceFromBottom: getWebTranscriptDistanceFromBottom(metrics),
            layoutHeight: metrics.clientHeight,
            nowMs: Date.now(),
            resolveAnchorObservation: (anchor) => {
                // A still-open web anchor transaction means the issue-time anchor restore could
                // not see the anchor row (seam scroll-to-index fallback). Once the row mounts, a
                // read-only alignment observation drives confirm or the single DOM correction.
                const alignment = resolveWebTranscriptViewportAnchorAlignment({
                    container: metrics.element,
                    anchor: { ...anchor, messageId: anchor.messageId ?? null },
                    tolerancePx,
                });
                return alignment.status === 'aligned' || alignment.status === 'misaligned'
                    ? { status: alignment.status }
                    : null;
            },
            sessionId: props.sessionId,
            tolerancePx,
            wantsPinned: wantsPinnedRef.current,
        });
        applyEntryRestoreOwnerEffects(effects);
    }, [applyEntryRestoreOwnerEffects, entryRestoreOwner, pinThresholdPx, props.sessionId, resolveWebScrollMetrics]);

    /**
     * Maps a native scroll observation to a CONCLUSIVE transaction observation, or null when
     * the frame is inconclusive (anchor layout unmeasured, stale content metrics): only
     * conclusive aligned|misaligned observations are ever forwarded (Lane A review contract).
     */
    const observeNativeEntryRestoreHostFacts = React.useCallback((params: Readonly<{
        contentHeight: number;
        distanceFromBottom: number;
        layoutHeight: number;
        nowMs: number;
        offsetY: number;
        rawOffsetY?: number;
        targetKind?: 'slice-anchor';
    }>): readonly EntryRestoreOwnerEffect[] => {
        const tolerancePx = Math.max(pinThresholdPx, 2);
        return entryRestoreOwner.observeNativeHostFacts({
            contentHeight: params.contentHeight,
            distanceFromBottom: params.distanceFromBottom,
            layoutHeight: params.layoutHeight,
            nowMs: params.nowMs,
            observedOffsetY: params.offsetY,
            resolveAnchorObservation: (anchor) => {
                const nativeAnchor: SessionViewportAnchorSnapshot = {
                    ...anchor,
                    capturedAtMs: anchor.capturedAtMs ?? Date.now(),
                };
                const anchorIndex = resolveTranscriptViewportAnchorIndex({
                    anchor: nativeAnchor,
                    items: listDataRef.current,
                }) ?? resolveNearestSurvivingViewportAnchorIndex(nativeAnchor);
                if (anchorIndex == null) return null;
                const observation = resolveNativeTranscriptViewportAnchorRestoreObservation({
                    ref: listRef.current,
                    index: anchorIndex,
                    itemOffsetPx: anchor.itemOffsetPx,
                    tolerancePx,
                });
                if (observation.status === 'aligned' || observation.status === 'misaligned') {
                    return { status: observation.status };
                }
                return null;
            },
            resolveSliceObservation: (anchor) => {
                // N2b.2: zero-write entries confirm only when the visible anchor row
                // is still sitting at its saved pixel offset.
                const anchorIndex = resolveTranscriptViewportAnchorIndex({
                    anchor,
                    items: listDataRef.current,
                });
                if (anchorIndex == null) return null;
                const layout = (() => {
                    try {
                        return listRef.current?.getLayout?.(anchorIndex) ?? null;
                    } catch {
                        return null;
                    }
                })();
                const visibleRange = (() => {
                    try {
                        return listRef.current?.computeVisibleIndices?.() ?? null;
                    } catch {
                        return null;
                    }
                })();
                const status = resolveNativeSliceEntryObservation({
                    anchorIndex,
                    anchorLayout: layout,
                    absoluteScrollOffset: params.rawOffsetY ?? params.offsetY,
                    contentHeight: params.contentHeight,
                    itemOffsetPx: anchor.itemOffsetPx,
                    layoutHeight: listLayoutHeightRef.current,
                    tolerancePx,
                    visibleRange,
                });
                return status === 'inconclusive' ? null : { status };
            },
            sessionId: props.sessionId,
            targetKind: params.targetKind,
            tolerancePx,
        });
    }, [
        entryRestoreOwner,
        pinThresholdPx,
        props.sessionId,
        resolveNearestSurvivingViewportAnchorIndex,
    ]);

    /**
     * N2b.2: layout-driven confirmation for slice entries — a write-free entry produces
     * NO scroll events, so the open observe-only transaction is verified from layout/
     * content commits by reading the anchor row position straight off the list ref.
     */
    const verifyNativeSliceEntryRestoreTransaction = React.useCallback(() => {
        if (Platform.OS === 'web') return;
        if (!entryRestoreOwner.hasOpenTransaction(props.sessionId)) return;
        const effects = observeNativeEntryRestoreHostFacts({
            contentHeight: listContentHeightRef.current,
            distanceFromBottom: 0,
            layoutHeight: listLayoutHeightRef.current,
            nowMs: Date.now(),
            offsetY: readNativeAbsoluteScrollOffset(listRef.current) ?? Number.NaN,
            targetKind: 'slice-anchor',
        });
        if (effects.length === 0) return;
        applyEntryRestoreOwnerEffects(effects);
        if (effects.some((effect) => effect.type === 'native-initial-viewport-applied')) {
            updateNativeViewportPaintObserved(true);
        }
    }, [
        applyEntryRestoreOwnerEffects,
        entryRestoreOwner,
        observeNativeEntryRestoreHostFacts,
        props.sessionId,
        updateNativeViewportPaintObserved,
    ]);

    /**
     * Entry-restore resolution driver (plan F2 + Lane A): resolves the entry target through
     * `resolveEntryRestoreTarget`, runs pre-transaction materialization for unresolved anchors
     * and too-deep distances, and creates exactly ONE transaction per session entry whose
     * initial write is issued here. Content-height churn can never re-issue a write: there is
     * no reapply path (evidence E1).
     */
    const runEntryRestoreAttempt = React.useCallback((): void => {
        const entryViewport = sessionEntryViewportRef.current;
        if (!entryViewport || entryViewport.sessionId !== props.sessionId) return;

        const { contentHeight, layoutHeight } = resolveEntryRestoreCanonicalMetrics();
        const items = listDataRef.current;
        const anchor = entryViewport.anchor;
        const exactAnchorIndex = anchor
            ? resolveTranscriptViewportAnchorIndex({ anchor, items })
            : null;
        const nearestAnchorIndex = anchor ? resolveNearestSurvivingViewportAnchorIndex(anchor) : null;
        const anchorSeq = anchor ? resolveSeqForViewportAnchor(anchor) : null;
        const restoredAnchorForOwner = anchor
            ? resolveEntryRestoreOwnerAnchor(anchor, exactAnchorIndex ?? nearestAnchorIndex)
            : null;

        const resolveEntrySliceRenderedAnchor = (sliceTarget: EntryRestoreSliceTarget): EntryRestoreOwnerAnchor | null => {
            const baseAnchor: SessionViewportAnchorSnapshot = {
                kind: anchor?.kind ?? 'message',
                messageId: sliceTarget.anchorMessageId,
                itemId: anchor?.itemId ?? sliceTarget.anchorMessageId,
                itemOffsetPx: sliceTarget.anchorItemOffsetPx,
                capturedAtMs: anchor?.capturedAtMs ?? Date.now(),
            };
            if (resolveTranscriptViewportAnchorIndex({ anchor: baseAnchor, items: listDataRef.current }) != null) {
                return baseAnchor;
            }
            // Rendered ids are runtime-local: map the persisted server id (realID),
            // then the seq, to the rendered message (durable-identity lesson, N2b.1).
            const state = getStorage().getState();
            const session = state?.sessionMessages?.[props.sessionId];
            const messagesById: Record<string, Message | undefined> =
                session?.messagesById ?? session?.messagesMap ?? {};
            let renderedId: string | null = null;
            for (const message of Object.values(messagesById)) {
                if (message?.realID === sliceTarget.anchorMessageId) {
                    renderedId = message.id;
                    break;
                }
            }
            if (renderedId == null && sliceTarget.anchorSeq != null) {
                for (const message of Object.values(messagesById)) {
                    if (
                        typeof message?.seq === 'number' &&
                        Math.trunc(message.seq) === sliceTarget.anchorSeq
                    ) {
                        renderedId = message.id;
                        break;
                    }
                }
            }
            if (renderedId == null) return null;
            return { ...baseAnchor, messageId: renderedId, itemId: renderedId };
        };

        const sliceTarget: EntryRestoreSliceTarget | null =
            Platform.OS !== 'web' &&
            !sessionOpenLatch.isEntrySliceDegraded(props.sessionId) &&
            anchor &&
            typeof anchor.messageId === 'string' &&
            anchor.messageId.trim().length > 0
                ? {
                    kind: 'slice',
                    anchorMessageId: anchor.messageId,
                    anchorSeq,
                    anchorItemOffsetPx: Number.isFinite(anchor.itemOffsetPx) ? anchor.itemOffsetPx : 0,
                }
                : null;
        const renderedSliceAnchor = sliceTarget ? resolveEntrySliceRenderedAnchor(sliceTarget) : null;
        const renderedSliceIndex = renderedSliceAnchor
            ? resolveTranscriptViewportAnchorIndex({ anchor: renderedSliceAnchor, items: listDataRef.current })
            : null;
        const anchorRowId =
            renderedSliceIndex != null && typeof listDataRef.current[renderedSliceIndex]?.id === 'string'
                ? listDataRef.current[renderedSliceIndex].id
                : null;
        const effects = entryRestoreOwner.attempt({
            canMaterializeOlder: canRequestBoundedEntryViewportMaterialization(),
            contentHeight,
            currentSessionId: props.sessionId,
            deadlineMs: resolveEntryRestoreDeadlineMs(),
            exactAnchorIndex,
            fillSettled: sessionOpenLatch.initialFillStatus() === 'done',
            items,
            jumpToSeqActive: props.jumpToSeq != null || latestJumpToSeqRef.current != null,
            layoutHeight,
            nearestAnchorIndex,
            nowMs: Date.now(),
            platform: Platform.OS === 'web' ? 'web' : 'native',
            restoredViewport: {
                anchor: restoredAnchorForOwner,
                anchorSeqLoaded: anchorSeq != null ? isViewportAnchorSeqLoaded(anchorSeq, items) : false,
                offsetY: typeof entryViewport.offsetY === 'number' ? entryViewport.offsetY : null,
                sessionId: entryViewport.sessionId,
                shouldFollowBottom: entryViewport.shouldFollowBottom,
            },
            slice: sliceTarget
                ? {
                    anchorRowId,
                    capable: true,
                    renderedAnchor: renderedSliceAnchor,
                    renderedAnchorIndex: renderedSliceIndex,
                    target: sliceTarget,
                    writeFree: canUseWriteFreeEntrySliceForAnchorOffset(sliceTarget.anchorItemOffsetPx),
                }
                : { capable: false },
            userScrollObserved: lastUserScrollIntentAtMsRef.current !== Number.NEGATIVE_INFINITY,
        });
        if (
            sliceTarget &&
            effects.length === 0 &&
            entryRestoreOwner.telemetryState(props.sessionId) === 'none'
        ) {
            sessionOpenLatch.markEntrySliceDegraded(props.sessionId);
        }
        applyEntryRestoreOwnerEffects(effects);
        if (Platform.OS === 'web' && sessionOpenLatch.initialFillStatus() === 'done') {
            verifyWebEntryRestoreTransaction();
        }
    }, [
        applyEntryRestoreOwnerEffects,
        canRequestBoundedEntryViewportMaterialization,
        entryRestoreOwner,
        props.jumpToSeq,
        props.sessionId,
        isViewportAnchorSeqLoaded,
        resolveEntryRestoreCanonicalMetrics,
        resolveEntryRestoreDeadlineMs,
        resolveEntryRestoreOwnerAnchor,
        resolveNearestSurvivingViewportAnchorIndex,
        resolveSeqForViewportAnchor,
        verifyWebEntryRestoreTransaction,
    ]);
    attemptEntryRestoreRef.current = runEntryRestoreAttempt;

    React.useLayoutEffect(() => {
        runEntryRestoreAttempt();
        if (Platform.OS === 'web') {
            verifyWebEntryRestoreTransaction();
        } else {
            verifyNativeSliceEntryRestoreTransaction();
        }
    }, [runEntryRestoreAttempt, listContentHeight, listData.length, listLayoutHeight, props.sessionId, verifyNativeSliceEntryRestoreTransaction, verifyWebEntryRestoreTransaction]);

	    const captureWebBottomFollowPreviousMetrics = React.useCallback((): WebTranscriptScrollMetrics | null => {
	        if (Platform.OS !== 'web') return null;
	        const metrics = resolveWebScrollMetrics();
	        if (!metrics) return null;
	        return {
	            ...metrics,
	            clientHeight: listLayoutHeightRef.current > 0 ? listLayoutHeightRef.current : metrics.clientHeight,
	            scrollHeight: listContentHeightRef.current > 0 ? listContentHeightRef.current : metrics.scrollHeight,
	        };
	    }, [resolveWebScrollMetrics]);

    // Native analog of captureWebBottomFollowPreviousMetrics (carve only). Snapshots "the user was
    // following the live tail at the inverted bottom" BEFORE a data/layout change, using the
    // bottom-follow MODE (the reliable persisted signal) rather than the post-change distance, which
    // FlashList MVCP offset-correction corrupts on the hot→cold (index-0) insert. Returns false when
    // the carve is OFF (nativeHotTailHeightRef === 0), so flag=0 behavior is byte-for-byte unchanged.
    const captureNativeBottomFollowPreviousFollow = React.useCallback((): boolean => {
        return resolveNativeBottomFollowPreviousFollow({
            autoPinDelayMs: TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS,
            bottomFollowMode: bottomFollowModeStateRef.current.mode,
            isNative: Platform.OS !== 'web',
            lastUserScrollIntentAtMs: lastUserScrollIntentAtMsRef.current,
            nativeHotTailHeightPx: nativeHotTailHeightRef.current,
            nowMs: Date.now(),
            usesNativeFlashListBottomMaintenance,
            wantsPinned: wantsPinnedRef.current,
        });
    }, [usesNativeFlashListBottomMaintenance]);

    const applyWebBottomFollowAdjustment = React.useCallback((
        previousMetrics: WebTranscriptScrollMetrics,
        reason: TranscriptViewportTelemetryScrollReason = 'content-size-change',
        authority?: Readonly<{ reason: TranscriptViewportTelemetryScrollReason; writer: BottomFollowAutomaticWriter }>,
	    ): boolean => {
	        if (Platform.OS !== 'web') return false;
	        return executeViewportCommand(resolveViewportCommand({
	            type: 'preserve-live-tail-distance',
            sessionId: props.sessionId,
            previousDistanceFromLiveTailPx: getWebTranscriptDistanceFromBottom(previousMetrics),
            pinThresholdPx,
            recentUserIntent: Date.now() - lastUserScrollIntentAtMsRef.current < TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS,
            wantsPinned: wantsPinnedRef.current,
            reason,
            schedulerAuthorityReason: authority?.reason,
            schedulerAuthorityWriter: authority?.writer,
        }));
    }, [
        executeViewportCommand,
        pinThresholdPx,
        props.sessionId,
        resolveViewportCommand,
    ]);

    const applyNativeInvertedFollowBottomPinDecision = React.useCallback((
        decision: NativeInvertedFollowBottomPinDecision,
        reason: TranscriptViewportTelemetryScrollReason,
    ): boolean => {
        if (decision.type !== 'handled') return false;
        if (decision.clearPendingMountSettleBottomPin) {
            pendingNativeMountSettleBottomPinRef.current = false;
        }
        if (decision.markInitialViewportApplied) {
            markNativeInitialViewportAppliedForCurrentSession();
        }
        if (decision.issuePinBottomCommand) {
            executeViewportCommand(resolveViewportCommand({
                type: 'pin-bottom',
                sessionId: props.sessionId,
                reason,
                mode: 'follow-bottom',
                animated: false,
            }));
        }
        return true;
    }, [
        executeViewportCommand,
        markNativeInitialViewportAppliedForCurrentSession,
        props.sessionId,
        resolveViewportCommand,
    ]);

    const applyNativeMeasuredBottomPinPreAutoFollowDecision = React.useCallback((
        decision: NativeMeasuredBottomPinPreAutoFollowDecision,
    ): decision is Extract<NativeMeasuredBottomPinPreAutoFollowDecision, { type: 'skip-pin' }> => {
        if (decision.type !== 'skip-pin') return false;
        if (decision.setPendingMountSettleBottomPin) {
            pendingNativeMountSettleBottomPinRef.current = true;
        }
        return true;
    }, []);

    const applyNativeAutomaticPinSameOffsetDecision = React.useCallback((
        decision: NativeAutomaticPinSameOffsetDecision,
    ): boolean => {
        if (decision.type !== 'skip-pin') return false;
        if (decision.markInitialViewportApplied) {
            markNativeInitialViewportAppliedForCurrentSession();
        }
        if (decision.setPendingMountSettleBottomPin) {
            pendingNativeMountSettleBottomPinRef.current = true;
        }
        if (decision.updateInitialViewportPendingObservation) {
            updateNativeInitialViewportPendingObservation(true);
        }
        return true;
    }, [
        markNativeInitialViewportAppliedForCurrentSession,
        updateNativeInitialViewportPendingObservation,
    ]);

    const applyNativeStreamAppendContentVersionDecision = React.useCallback((
        decision: NativeStreamAppendContentVersionDecision,
    ): boolean => {
        if (decision.type !== 'skip-pin') return false;
        if (decision.clearPendingMountSettleBottomPin) {
            pendingNativeMountSettleBottomPinRef.current = false;
        }
        if (decision.markInitialViewportApplied) {
            markNativeInitialViewportAppliedForCurrentSession();
        }
        return true;
    }, [
        markNativeInitialViewportAppliedForCurrentSession,
    ]);

    const applyNativeStreamAppendContentVersionRecord = React.useCallback((
        record: NativeStreamAppendPinContentVersion | null,
    ): void => {
        if (!record) return;
        lastNativeStreamAppendPinRef.current = record;
    }, []);

    const applyNativeSuccessfulBottomPinRecords = React.useCallback((
        records: NativeSuccessfulBottomPinRecords,
    ): void => {
        if (records.lastNativePinOffset != null) {
            lastNativePinOffsetRef.current = records.lastNativePinOffset;
        }
        if (records.bottomFollowPinCommand) {
            lastNativeBottomFollowPinCommandRef.current = {
                offsetY: records.bottomFollowPinCommand.offsetY,
                sessionId: records.bottomFollowPinCommand.sessionId,
                writtenAtMs: Date.now(),
            };
        }
        if (records.automaticBottomPinCommandSessionId) {
            nativeAutomaticBottomPinCommandSessionRef.current =
                records.automaticBottomPinCommandSessionId;
        }
    }, []);

    const applyNativeContentMaterializationAutoPinPostSuccessDecision = React.useCallback((
        decision: NativeContentMaterializationAutoPinPostSuccessDecision,
    ): void => {
        if (decision.clearMaterializationAutoPin) {
            nativeContentMaterializationAutoPinRef.current = null;
        }
    }, []);

    const applyNativeSuccessfulBottomPinInitialViewportEffects = React.useCallback((
        effects: NativeSuccessfulBottomPinInitialViewportEffects,
    ): void => {
        if (effects.markInitialViewportApplied) {
            pendingNativeMountSettleBottomPinRef.current = false;
            markNativeInitialViewportAppliedForCurrentSession();
        }
        if (effects.setPendingMountSettleBottomPin) {
            pendingNativeMountSettleBottomPinRef.current = true;
        }
        if (effects.updateInitialViewportPendingObservation) {
            updateNativeInitialViewportPendingObservation(true);
        }
    }, [
        markNativeInitialViewportAppliedForCurrentSession,
        updateNativeInitialViewportPendingObservation,
    ]);

    const shouldDeferNativeAutomaticPinToSessionOpenLatch = React.useCallback((
        reason: TranscriptViewportTelemetryScrollReason,
    ): boolean => {
        if (Platform.OS === 'web' || !usesNativeFlashListBottomMaintenance) return false;
        if (isExplicitTranscriptBottomFollowCommand(reason)) return false;
        if (reason === 'initial-open' || reason === 'mount-settle') return false;
        const nativeSessionOpenPositioningActive =
            !nativeMountSettleStable &&
            !nativeMountSettleDeadlineReachedRef.current;
        if (
            hasNativeInitialViewportAppliedForCurrentSession() &&
            !nativeSessionOpenPositioningActive
        ) {
            return false;
        }
        const phase = sessionOpenLatch.phase();
        return (
            nativeSessionOpenPositioningActive ||
            phase === 'awaiting-data' ||
            phase === 'awaiting-layout' ||
            phase === 'positioning' ||
            phase === 'confirming'
        );
    }, [
        hasNativeInitialViewportAppliedForCurrentSession,
        nativeMountSettleStable,
        sessionOpenLatch,
        usesNativeFlashListBottomMaintenance,
    ]);

    const applyNativeMeasuredBottomPinPostSuccessEffects = React.useCallback((
        postSuccess: NativeMeasuredBottomPinCommandResultPostSuccessPlan,
    ): void => {
        applyNativeStreamAppendContentVersionRecord(postSuccess.streamAppendRecord);
        applyNativeSuccessfulBottomPinRecords(postSuccess.successfulBottomPinRecords);
        applyNativeContentMaterializationAutoPinPostSuccessDecision(postSuccess.materializationCleanupDecision);
        applyNativeSuccessfulBottomPinInitialViewportEffects(postSuccess.initialViewportEffects);
    }, [
        applyNativeContentMaterializationAutoPinPostSuccessDecision,
        applyNativeStreamAppendContentVersionRecord,
        applyNativeSuccessfulBottomPinInitialViewportEffects,
        applyNativeSuccessfulBottomPinRecords,
    ]);

    const applyNativeMeasuredBottomPinCommandResultPlan = React.useCallback((
        plan: NativeMeasuredBottomPinCommandResultPlan,
    ): boolean => {
        if (!executeViewportCommand(resolveViewportCommand(plan.commandInput))) {
            return false;
        }
        applyNativeMeasuredBottomPinPostSuccessEffects(plan.postSuccess);
        return true;
    }, [
        applyNativeMeasuredBottomPinPostSuccessEffects,
        executeViewportCommand,
        resolveViewportCommand,
    ]);

    const applyNativeMeasuredPinPlanResult = React.useCallback((
        plan: NativeMeasuredPinPlan,
    ): boolean => {
        if (plan.type === 'blocked') return false;
        if (plan.type === 'defer-for-mount-settle') {
            if (plan.effect.sessionId !== props.sessionId) return false;
            pendingNativeMountSettleBottomPinRef.current = true;
            return false;
        }
        if (plan.type === 'not-ready') return false;
        return applyNativeMeasuredBottomPinCommandResultPlan(plan.commandPlan);
    }, [
        applyNativeMeasuredBottomPinCommandResultPlan,
        props.sessionId,
    ]);

    const pinNativeFlashListToBottomIfMeasured = React.useCallback((options?: {
        force?: boolean;
        markInitialViewportApplied?: 'always' | 'when-scrollable';
        telemetryReason?: TranscriptViewportTelemetryScrollReason;
        /**
         * Native carve only: the pre-change "was following the live tail" decision (captured before
         * the data/layout change). When true the inverted bottom command is issued authoritatively,
         * bypassing the post-change distance gate that FlashList MVCP offset-correction corrupts on
         * the hot→cold (index-0) insert. Mirrors web's applyWebBottomFollowAdjustment writing the
         * absolute bottom regardless of the (re-anchored) intermediate offset.
         */
        forceFollowPin?: boolean;
    }): boolean => {
        const telemetryReason = options?.telemetryReason ?? 'content-size-change';
        const isExplicitNativeCommand =
            telemetryReason === 'jump-to-bottom' ||
            telemetryReason === 'jump-to-seq';
        if (shouldDeferNativeAutomaticPinToSessionOpenLatch(telemetryReason)) {
            pendingNativeMountSettleBottomPinRef.current = true;
            return false;
        }
        const viewportContentMetrics = readViewportContentMetrics();
        const shouldDeferInitialViewportAppliedUntilObserved =
            options?.markInitialViewportApplied === 'when-scrollable';
        const shouldMarkInitialViewportApplied =
            !shouldDeferInitialViewportAppliedUntilObserved;
        const measuredPinPlan = lifecycleHost.planMeasuredNativeLiveTailPin({
            autoPinDelayMs: TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS,
            bottomFollowMode: bottomFollowModeStateRef.current.mode,
            canAutoFollow: canAutoFollowForReason(telemetryReason, { explicit: isExplicitNativeCommand }),
            contentHeight: viewportContentMetrics?.contentHeight ?? 0,
            deferInitialViewportAppliedUntilObserved: shouldDeferInitialViewportAppliedUntilObserved,
            distanceFromBottom: readCurrentNativeDistanceFromBottom(),
            force: options?.force === true,
            forceFollowPin: options?.forceFollowPin === true,
            forceMountSettle: options?.force === true && telemetryReason === 'mount-settle',
            hasContentMeasurement: hasNativeContentMeasurementForCurrentSession(),
            hasInitialViewportApplied: hasNativeInitialViewportAppliedForCurrentSession(),
            hasRearmedBottomFollow: hasRearmedNativeBottomFollow(),
            isExplicitNativeCommand,
            isJumpToSeqActive: props.jumpToSeq != null,
            isMountSettleActive: lifecycleHost.getMountSettleSnapshot().isMountSettleActive === true,
            lastNativePinOffset: lastNativePinOffsetRef.current,
            lastStreamAppendPin: lastNativeStreamAppendPinRef.current,
            lastUserScrollIntentAtMs: lastUserScrollIntentAtMsRef.current,
            layoutHeight: viewportContentMetrics?.layoutHeight ?? 0,
            materializationAutoPin: nativeContentMaterializationAutoPinRef.current,
            mountSettleDeadlineReached: nativeMountSettleDeadlineReachedRef.current,
            nativeAutomaticBottomPinCommandSessionId: nativeAutomaticBottomPinCommandSessionRef.current,
            nativeMountSettleStable,
            nowMs: Date.now(),
            pendingMountSettleBottomPin: pendingNativeMountSettleBottomPinRef.current,
            pinThresholdPx,
            reason: telemetryReason,
            sessionId: props.sessionId,
            shouldMarkInitialViewportApplied,
            usesNativeFlashListBottomMaintenance,
            wantsPinned: wantsPinnedRef.current,
        });
        if (measuredPinPlan.type === 'blocked' || measuredPinPlan.type === 'defer-for-mount-settle') {
            return applyNativeMeasuredPinPlanResult(measuredPinPlan);
        }
        if (measuredPinPlan.type === 'not-ready') return false;
        if (applyNativeInvertedFollowBottomPinDecision(
            measuredPinPlan.invertedFollowBottomDecision,
            telemetryReason,
        )) {
            return true;
        }
        if (applyNativeMeasuredBottomPinPreAutoFollowDecision(measuredPinPlan.preAutoFollowDecision)) {
            return true;
        }
        if (applyNativeAutomaticPinSameOffsetDecision(measuredPinPlan.sameOffsetDecision)) {
            return true;
        }

        if (applyNativeStreamAppendContentVersionDecision(measuredPinPlan.streamAppendDecision)) {
            return true;
        }
        return applyNativeMeasuredPinPlanResult(measuredPinPlan);
    }, [
        applyNativeMeasuredPinPlanResult,
        applyNativeMeasuredBottomPinPreAutoFollowDecision,
        applyNativeAutomaticPinSameOffsetDecision,
        applyNativeStreamAppendContentVersionDecision,
        applyNativeInvertedFollowBottomPinDecision,
        canAutoFollowForReason,
        hasRearmedNativeBottomFollow,
        hasNativeContentMeasurementForCurrentSession,
        hasNativeInitialViewportAppliedForCurrentSession,
        lifecycleHost,
        nativeMountSettleStable,
        props.jumpToSeq,
        props.sessionId,
        pinThresholdPx,
        readViewportContentMetrics,
        shouldDeferNativeAutomaticPinToSessionOpenLatch,
        usesNativeFlashListBottomMaintenance,
    ]);

    const applyNativeEntrySettleConfirmationEffects = React.useCallback((
        effects: readonly NativeEntrySettleConfirmationEffect[],
    ) => {
        for (const effect of effects) {
            if (
                effect.type !== 'issue-entry-settle-reconfirm-pin' ||
                effect.sessionId !== props.sessionId
            ) {
                continue;
            }
            authorizeImmediateBottomFollowWriteRef.current('settle-reconfirm', 'mount-settle');
        }
    }, [props.sessionId]);

    const observeNativeConfirmation = React.useCallback((params: Readonly<{
        contentHeight: number;
        distanceFromBottom: number;
        isTrusted: boolean;
        mountSettleStable: boolean;
    }>): boolean => {
        if (Platform.OS === 'web') return false;
        const plan = lifecycleHost.observeNativeScrollConfirmation({
            bottomFollowMode: bottomFollowModeStateRef.current.mode,
            contentHeight: params.contentHeight,
            distanceFromBottom: params.distanceFromBottom,
            isTrusted: params.isTrusted,
            mountSettleDeadlineReached: nativeMountSettleDeadlineReachedRef.current,
            mountSettleStable: params.mountSettleStable,
            pinThresholdPx,
            sessionId: props.sessionId,
            wantsPinned: wantsPinnedRef.current,
        });
        applyNativeExplicitJumpConfirmationEffects(plan.explicitJumpEffects);
        applyNativeEntrySettleConfirmationEffects(plan.entrySettleEffects);
        return plan.consumed;
    }, [
        applyNativeEntrySettleConfirmationEffects,
        applyNativeExplicitJumpConfirmationEffects,
        lifecycleHost,
        pinThresholdPx,
        props.sessionId,
    ]);

    const applyNativeInitialFollowBottomDecision = React.useCallback((
        decision: NativeInitialFollowBottomDecision,
    ): boolean => {
        if (decision.type === 'blocked') return false;
        if (decision.type === 'already-owned') return true;
        return pinNativeFlashListToBottomIfMeasured({
            force: decision.force,
            markInitialViewportApplied: decision.markInitialViewportApplied,
            telemetryReason: decision.telemetryReason,
        });
    }, [pinNativeFlashListToBottomIfMeasured]);

    const pinNativeInitialFollowBottomViewportIfReady = React.useCallback((
        reason: TranscriptViewportTelemetryScrollReason = 'initial-open',
    ): boolean => {
        const decision = resolveNativeInitialFollowBottomDecision({
            autoPinDelayMs: TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS,
            canAutoFollow: canAutoFollowForReason(reason),
            hasInitialViewportApplied: hasNativeInitialViewportAppliedForCurrentSession(),
            hasLastNativePinOffset: lastNativePinOffsetRef.current != null,
            hasRearmedBottomFollow: hasRearmedNativeBottomFollow(),
            isJumpToSeqActive: props.jumpToSeq != null,
            lastUserScrollIntentAtMs: lastUserScrollIntentAtMsRef.current,
            nowMs: Date.now(),
            pendingMountSettleBottomPin: pendingNativeMountSettleBottomPinRef.current,
            reason,
            usesNativeFlashListBottomMaintenance,
        });
        return applyNativeInitialFollowBottomDecision(decision);
    }, [
        applyNativeInitialFollowBottomDecision,
        canAutoFollowForReason,
        hasRearmedNativeBottomFollow,
        hasNativeInitialViewportAppliedForCurrentSession,
        props.jumpToSeq,
        usesNativeFlashListBottomMaintenance,
    ]);

    const shouldKeepPendingNativeMountSettleBottomPin = React.useCallback((): boolean => {
        return resolveNativeMountSettleBottomPinRetention({
            autoPinDelayMs: TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS,
            canAutoFollowMountSettle: canAutoFollowForReason('mount-settle'),
            hasRearmedNativeBottomFollow: hasRearmedNativeBottomFollow(),
            isJumpToSeqActive: props.jumpToSeq != null,
            lastUserScrollIntentAtMs: lastUserScrollIntentAtMsRef.current,
            nowMs: Date.now(),
            usesNativeFlashListBottomMaintenance,
        });
    }, [canAutoFollowForReason, hasRearmedNativeBottomFollow, props.jumpToSeq, usesNativeFlashListBottomMaintenance]);

    const applyNativeExplicitPinCommandEffects = React.useCallback((isExplicitNativeCommand: boolean): void => {
        if (!isExplicitNativeCommand) return;
        pendingNativeMountSettleBottomPinRef.current = false;
    }, []);

    const pinToBottom = React.useCallback((reason: TranscriptViewportTelemetryScrollReason = 'initial-open'): boolean => {
        if (Platform.OS === 'web') {
            // Prefer DOM scroll writes on web: RNW list refs can apply delayed `scrollToOffset` that
            // fights against our pinning and results in visible drift/jitter.
            if (tryPinToBottomDom(reason)) {
                return true;
            }
            // If we cannot reliably locate a DOM scroll container yet, avoid falling back to the
            // list ref scroll APIs on web. Early `scrollToOffset({ offset: 0 })` calls can create
            // visible "scroll to top" jitter during mount while the real scroll container is still
            // being attached/measured.
            return false;
        }
        if (usesNativeFlashListBottomMaintenance) {
            const isExplicitNativeCommand = isExplicitTranscriptBottomFollowCommand(reason);
            applyNativeExplicitPinCommandEffects(isExplicitNativeCommand);
            return pinNativeFlashListToBottomIfMeasured({
                force: isExplicitNativeCommand,
                telemetryReason: reason,
            });
        }
        return executeViewportCommand(resolveViewportCommand(reason === 'jump-to-bottom'
            ? {
                type: 'jump-to-bottom',
                sessionId: props.sessionId,
            }
            : {
                type: 'pin-bottom',
                sessionId: props.sessionId,
                reason,
                mode: reason === 'jump-to-seq' ? 'jump-to-seq' : 'follow-bottom',
                animated: false,
            }));
    }, [
        applyNativeExplicitPinCommandEffects,
        executeViewportCommand,
        pinNativeFlashListToBottomIfMeasured,
        props.sessionId,
        resolveViewportCommand,
        resolveViewportTelemetryMode,
        tryPinToBottomDom,
        usesNativeFlashListBottomMaintenance,
    ]);

    const applyWebPassiveLiveTailCorrectionEffect = React.useCallback((
        effect: WebPassiveLiveTailCorrectionEffect,
    ): boolean => {
        if (Platform.OS !== 'web') return false;
        if (effect.sessionId !== props.sessionId) return false;
        return authorizeImmediateBottomFollowWriteRef.current('web-passive-correction', effect.reason);
    }, [
        props.sessionId,
    ]);
    applyWebPassiveLiveTailCorrectionEffectRef.current = applyWebPassiveLiveTailCorrectionEffect;

    const applyNativeMountSettleMeasuredPinResult = React.useCallback((pinApplied: boolean): boolean => {
        if (!pinApplied) return false;
        if (hasNativeInitialViewportAppliedForCurrentSession()) {
            pendingNativeMountSettleBottomPinRef.current = false;
        }
        return true;
    }, [hasNativeInitialViewportAppliedForCurrentSession]);

    const applyNativeMountSettlePendingRetentionResult = React.useCallback((shouldRetain: boolean): void => {
        if (!shouldRetain) return;
        pendingNativeMountSettleBottomPinRef.current = true;
    }, []);

    const pinToBottomRespectingNativeMountSettle = React.useCallback((
        reason: TranscriptViewportTelemetryScrollReason = 'mount-settle',
        forceFollowPin: boolean = false,
    ) => {
        if (usesNativeFlashListBottomMaintenance) {
            if (pinNativeInitialFollowBottomViewportIfReady(reason)) {
                return;
            }
            if (reason === 'initial-open') {
                return;
            }
            const measuredPinApplied = pinNativeFlashListToBottomIfMeasured({ telemetryReason: reason, forceFollowPin });
            if (applyNativeMountSettleMeasuredPinResult(measuredPinApplied)) {
                return;
            }
            applyNativeMountSettlePendingRetentionResult(shouldKeepPendingNativeMountSettleBottomPin());
            return;
        }
        pinToBottom(reason);
    }, [
        applyNativeMountSettleMeasuredPinResult,
        applyNativeMountSettlePendingRetentionResult,
        pinNativeInitialFollowBottomViewportIfReady,
        pinNativeFlashListToBottomIfMeasured,
        pinToBottom,
        shouldKeepPendingNativeMountSettleBottomPin,
        usesNativeFlashListBottomMaintenance,
    ]);

    const applyAuthorizedBottomFollowWrite = React.useCallback((
        effect: Extract<BottomFollowWriteSchedulerEffect<WebTranscriptScrollMetrics>, { type: 'authorize-write' }>,
    ): boolean => {
        switch (effect.command) {
            case 'web-bottom-follow-adjustment':
                return applyWebBottomFollowAdjustment(effect.previousWebMetrics, effect.reason, { reason: effect.schedulerAuthorityReason, writer: effect.schedulerAuthorityWriter });
            case 'native-respecting-mount-settle':
                pinToBottomRespectingNativeMountSettle(effect.reason, effect.nativePrevFollowAtBottom === true);
                return true;
            case 'pin-to-bottom':
                return pinToBottom(effect.reason);
            default:
                if (effect.writer === 'settle-reconfirm') {
                    return pinNativeFlashListToBottomIfMeasured({
                        force: true,
                        telemetryReason: effect.reason,
                    });
                }
                if (effect.writer === 'hot-tail-carve') {
                    return pinNativeFlashListToBottomIfMeasured({
                        telemetryReason: effect.reason,
                        forceFollowPin: true,
                    });
                }
                if (effect.writer === 'deferred-post-scroll' && usesNativeFlashListBottomMaintenance) {
                    return pinNativeFlashListToBottomIfMeasured({
                        force: true,
                        markInitialViewportApplied: pendingNativeMountSettleBottomPinRef.current || !hasNativeInitialViewportAppliedForCurrentSession()
                            ? 'when-scrollable'
                            : undefined,
                        telemetryReason: effect.reason,
                    });
                }
                if (effect.writer === 'passive-drift') {
                    return pinNativeFlashListToBottomIfMeasured({ telemetryReason: effect.reason });
                }
                return pinToBottom(effect.reason);
        }
    }, [
        applyWebBottomFollowAdjustment,
        hasNativeInitialViewportAppliedForCurrentSession,
        pinNativeFlashListToBottomIfMeasured,
        pinToBottom,
        pinToBottomRespectingNativeMountSettle,
        usesNativeFlashListBottomMaintenance,
    ]);

    const applyBottomFollowWriteSchedulerEffects = React.useCallback((
        effects: readonly BottomFollowWriteSchedulerEffect<WebTranscriptScrollMetrics>[],
    ): void => {
        for (const effect of effects) {
            if (effect.type === 'cancel-scheduled-write') {
                cancelScheduledPinToBottom();
                continue;
            }
            if (effect.type === 'schedule-write') {
                scheduleBottomFollowWriteTimerRef.current?.(effect.write);
                continue;
            }
            if (effect.type === 'authorize-write') {
                if (effect.command === 'web-bottom-follow-adjustment') {
                    if (applyAuthorizedBottomFollowWrite(effect)) return;
                    continue;
                }
                applyAuthorizedBottomFollowWrite(effect);
            }
        }
    }, [
        applyAuthorizedBottomFollowWrite,
        cancelScheduledPinToBottom,
    ]);
    applyBottomFollowWriteSchedulerEffectsRef.current = applyBottomFollowWriteSchedulerEffects;

    const authorizeImmediateBottomFollowWrite = React.useCallback((
        writer: BottomFollowAutomaticWriter,
        reason: TranscriptViewportTelemetryScrollReason,
    ): boolean => {
        const plan = planBottomFollowWriteSchedulerEvent(bottomFollowWriteSchedulerStateRef.current, {
            reason,
            type: 'authorize-immediate-write',
            writer,
        });
        bottomFollowWriteSchedulerStateRef.current = plan.state;
        applyBottomFollowWriteSchedulerEffects(plan.effects);
        return plan.effects.some((effect) => effect.type === 'authorize-write');
    }, [applyBottomFollowWriteSchedulerEffects]);
    authorizeImmediateBottomFollowWriteRef.current = authorizeImmediateBottomFollowWrite;

    const [beginExplicitJumpWriteBarrier, endExplicitJumpWriteBarrier] = useExplicitJumpWriteBarrier(
        { applyEffects: applyBottomFollowWriteSchedulerEffects, schedulerStateRef: bottomFollowWriteSchedulerStateRef },
    );

    const applyNativePendingMountSettleFlushCommandResult = React.useCallback((pinApplied: boolean): void => {
        if (!pinApplied) return;
        if (!hasNativeInitialViewportAppliedForCurrentSession()) return;
        pendingNativeMountSettleBottomPinRef.current = false;
    }, [hasNativeInitialViewportAppliedForCurrentSession]);

    const applyNativeMountSettlePendingPinFlushPlan = React.useCallback((
        plan: NativeMountSettlePendingPinFlushPlan,
    ): void => {
        for (const effect of plan.effects) {
            if (effect.sessionId !== props.sessionId) continue;
            if (effect.type === 'clear-pending-native-mount-settle-bottom-pin') {
                pendingNativeMountSettleBottomPinRef.current = false;
                continue;
            }
            if (effect.type === 'request-measured-native-live-tail-pin') {
                applyNativePendingMountSettleFlushCommandResult(pinNativeFlashListToBottomIfMeasured({
                    markInitialViewportApplied: 'when-scrollable',
                    telemetryReason: effect.reason,
                }));
            }
        }
    }, [
        applyNativePendingMountSettleFlushCommandResult,
        pinNativeFlashListToBottomIfMeasured,
        props.sessionId,
    ]);

    const flushPendingNativeMountSettleBottomPin = React.useCallback(() => {
        const mountSettleFlushPlan = lifecycleHost.planNativeMountSettlePendingPinFlush({
            canRetainPendingMountSettleBottomPin: shouldKeepPendingNativeMountSettleBottomPin(),
            isMountSettleActive: lifecycleHost.getMountSettleSnapshot().isMountSettleActive === true,
            mountSettleDeadlineReached: nativeMountSettleDeadlineReachedRef.current,
            pendingMountSettleBottomPin: pendingNativeMountSettleBottomPinRef.current,
            sessionId: props.sessionId,
        });
        applyNativeMountSettlePendingPinFlushPlan(mountSettleFlushPlan);
    }, [
        applyNativeMountSettlePendingPinFlushPlan,
        lifecycleHost,
        props.sessionId,
        shouldKeepPendingNativeMountSettleBottomPin,
    ]);
    flushPendingNativeMountSettleBottomPinRef.current = flushPendingNativeMountSettleBottomPin;

    // §12 #2/#3: synchronized live-tail pin. Fired from the edge-slot onLayout (same event that
    // measured the height) so the inverted bottom inset compensates for the EXACT rendered hot-tail
    // height. While the carve owns the bottom (#3) the MVCP threshold is withheld, so this
    // authoritative JS force-pin is the sole bottom owner; it only fires while the reader is still
    // following (captured before the change), so a scrolled-up reader is never yanked.
    const pinNativeLiveTailForHotTailHeight = React.useCallback((height: number) => {
        if (Platform.OS === 'web' || !usesNativeFlashListBottomMaintenance) return;
        const carve = liveTailCarveTelemetryRef.current;
        if (!carve.active) return;
        const wasFollowing = captureNativeBottomFollowPreviousFollow();
        if (!wasFollowing) {
            // Reader scrolled up (escaped/released): record the skip so device QA can PROVE the
            // growing live row did not yank the reader, then leave the viewport untouched.
            recordViewportTelemetryEvent({
                type: 'scroll-observed',
                mode: resolveViewportTelemetryMode(),
                reason: 'skipped',
                nativeHotTailHeightPx: height,
                liveRegionActive: true,
                nativeCarvePinIssued: false,
                liveTailAnchorId: carve.anchorId ?? undefined,
                liveTailAnchorKind: carve.anchorKind ?? undefined,
                coldCount: carve.coldCount,
                hotCount: carve.hotCount,
            });
            return;
        }
        // Authoritative inverted bottom pin: bypasses the post-change distance gate MVCP corrupts on
        // the hot→cold index-0 insert (forceFollowPin), reading the just-committed hot-tail height.
        authorizeImmediateBottomFollowWriteRef.current('hot-tail-carve', 'stream-append');
    }, [
        captureNativeBottomFollowPreviousFollow,
        recordViewportTelemetryEvent,
        resolveViewportTelemetryMode,
        usesNativeFlashListBottomMaintenance,
    ]);
    pinNativeLiveTailForHotTailHeightRef.current = pinNativeLiveTailForHotTailHeight;

    const applyNativeMountSettlePendingFlushRequest = React.useCallback((
        decision: NativeMountSettlePendingFlushTriggerDecision,
    ): void => {
        if (decision.type !== 'request-pending-flush') return;
        pendingNativeMountSettleBottomPinRef.current = true;
    }, []);

    const applyNativeMountSettlePendingFlushTriggerDecision = React.useCallback((
        decision: NativeMountSettlePendingFlushTriggerDecision,
    ) => {
        if (decision.type === 'noop') return;
        applyNativeMountSettlePendingFlushRequest(decision);
        flushPendingNativeMountSettleBottomPin();
    }, [
        applyNativeMountSettlePendingFlushRequest,
        flushPendingNativeMountSettleBottomPin,
    ]);

    React.useEffect(() => {
        applyNativeMountSettlePendingFlushTriggerDecision(resolveNativeMountSettlePendingFlushTriggerDecision({
            autoPinSuppressed: false,
            hasInitialViewportApplied: false,
            mountSettleDeadlineReached: false,
            mountSettleStable: nativeMountSettleStable,
        }));
    }, [
        applyNativeMountSettlePendingFlushTriggerDecision,
        nativeMountSettleStable,
    ]);

    React.useEffect(() => {
        applyNativeMountSettlePendingFlushTriggerDecision(resolveNativeMountSettlePendingFlushTriggerDecision({
            autoPinSuppressed: nativeMountSettleAutoPinSuppressedRef.current,
            hasInitialViewportApplied: hasNativeInitialViewportAppliedForCurrentSession(),
            mountSettleDeadlineReached: nativeMountSettleDeadlineReached,
            mountSettleStable: false,
        }));
    }, [
        applyNativeMountSettlePendingFlushTriggerDecision,
        hasNativeInitialViewportAppliedForCurrentSession,
        nativeMountSettleDeadlineReached,
    ]);

    const deferPinToBottomAfterScroll = React.useCallback((
        reason: TranscriptViewportTelemetryScrollReason,
    ) => {
        fireAndForget(Promise.resolve().then(() => {
            authorizeImmediateBottomFollowWriteRef.current('deferred-post-scroll', reason);
        }), { tag: 'ChatList.deferPinToBottomAfterScroll' });
    }, []);

    const jumpToBottom = React.useCallback(() => {
        const plan = lifecycleHost.planExplicitJumpTakeover({
            reason: 'jump-to-bottom',
            sessionId: props.sessionId,
        });
        commitBottomFollowModeState(plan.state.bottomFollowState);
        applyExplicitJumpTakeoverApplyEffects(plan.explicitJumpTakeoverEffects);
        if (usesNativeFlashListBottomMaintenance) {
            const distanceFromBottom = readCurrentNativeDistanceFromBottom();
            if (distanceFromBottom != null && distanceFromBottom <= pinThresholdPxRef.current) {
                lifecycleHost.clearNativeExplicitJumpConfirmation({ sessionId: props.sessionId });
                commitExplicitReturnToLiveTailState('jump-to-bottom');
                invalidateViewportAnchorCapture();
                return;
            }
        }
        if (usesNativeFlashListBottomMaintenance) {
            lifecycleHost.armNativeExplicitJumpConfirmation({
                sessionId: props.sessionId,
                issuedContentHeight: listContentHeightRef.current,
            });
        }
        const command = resolveViewportCommand({
            type: 'jump-to-bottom',
            sessionId: props.sessionId,
        });
        if (!executeViewportCommandWithAnimation(command, jumpAnimateScroll)) {
            pinToBottom('jump-to-bottom');
        }
        commitExplicitReturnToLiveTailState('jump-to-bottom');
        invalidateViewportAnchorCapture();
    }, [applyExplicitJumpTakeoverApplyEffects, commitBottomFollowModeState, commitExplicitReturnToLiveTailState, executeViewportCommandWithAnimation, invalidateViewportAnchorCapture, jumpAnimateScroll, lifecycleHost, pinToBottom, props.sessionId, readCurrentNativeDistanceFromBottom, resolveViewportCommand, usesNativeFlashListBottomMaintenance]);

    React.useLayoutEffect(() => {
        const followBottomIntentKey = props.followBottomIntentKey ?? null;
        if (followBottomIntentKey == null) return;
        if (lastFollowBottomIntentKeyRef.current === followBottomIntentKey) return;

        lastFollowBottomIntentKeyRef.current = followBottomIntentKey;
        commitExplicitReturnToLiveTailState('follow-bottom-intent');
        invalidateViewportAnchorCapture();
        const plan = lifecycleHost.planFollowBottomIntentTakeover({
            sessionId: props.sessionId,
        });
        commitBottomFollowModeState(plan.state.bottomFollowState);
        applyFollowBottomIntentTakeoverApplyEffects(plan.followBottomIntentTakeoverEffects);
        pinToBottom('jump-to-bottom');
    }, [
        applyFollowBottomIntentTakeoverApplyEffects,
        commitBottomFollowModeState,
        commitExplicitReturnToLiveTailState,
        invalidateViewportAnchorCapture,
        lifecycleHost,
        pinToBottom,
        props.followBottomIntentKey,
        props.sessionId,
    ]);

    const resolveAutoPinWaitMs = React.useCallback((reason: TranscriptViewportTelemetryScrollReason): number | null => {
        return resolveTranscriptAutoFollowPinWaitMs({
            autoPinDelayMs: TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS,
            canAutoFollow: canAutoFollowForReason(reason),
            hasRearmedBottomFollow: hasRearmedNativeBottomFollow(),
            lastUserScrollIntentAtMs: lastUserScrollIntentAtMsRef.current,
            nowMs: Date.now(),
        });
    }, [canAutoFollowForReason, hasRearmedNativeBottomFollow]);

    const applyScheduledPinToBottomFire = React.useCallback((handle: ScheduledPinToBottom): void => {
        if (scheduledPinRef.current !== handle) return;
        const firePlan = planBottomFollowWriteSchedulerEvent(bottomFollowWriteSchedulerStateRef.current, {
            observedRawOffsetY: Platform.OS === 'web' ? null : readNativeAbsoluteScrollOffset(listRef.current),
            type: 'fire-pending',
            usesNativeFlashListBottomMaintenance,
            waitMs: resolveAutoPinWaitMs(handle.reason),
        });
        bottomFollowWriteSchedulerStateRef.current = firePlan.state;
        scheduledPinRef.current = null;
        applyBottomFollowWriteSchedulerEffects(firePlan.effects);
    }, [applyBottomFollowWriteSchedulerEffects, resolveAutoPinWaitMs, usesNativeFlashListBottomMaintenance]);

    const scheduleBottomFollowWriteTimer = React.useCallback((
        write: BottomFollowScheduledWrite<WebTranscriptScrollMetrics>,
    ): void => {
        const raf = (globalThis as any)?.requestAnimationFrame as undefined | ((cb: () => void) => any);
        if (write.kind === 'raf' && typeof raf === 'function') {
            const handle: ScheduledPinToBottom = { ...write, id: 0 };
            scheduledPinRef.current = handle;
            handle.id = raf(() => {
                applyScheduledPinToBottomFire(handle);
            });
            return;
        }

        const handle: ScheduledPinToBottom = { ...write, id: null };
        scheduledPinRef.current = handle;
        handle.id = setTimeout(() => {
            applyScheduledPinToBottomFire(handle);
        }, write.delayMs);
    }, [applyScheduledPinToBottomFire]);
    scheduleBottomFollowWriteTimerRef.current = scheduleBottomFollowWriteTimer;

    const requestBottomFollowScheduledWrite = React.useCallback((
        previousWebMetrics: WebTranscriptScrollMetrics | null = null,
        reason: TranscriptViewportTelemetryScrollReason = 'content-size-change',
        nativePrevFollowAtBottom: boolean = false,
        writer: BottomFollowAutomaticWriter = 'automatic-live-tail',
    ) => {
        const raf = (globalThis as any)?.requestAnimationFrame as undefined | ((cb: () => void) => any);
	        const schedulePlan = planBottomFollowWriteSchedulerEvent(bottomFollowWriteSchedulerStateRef.current, {
            canUseAnimationFrame: typeof raf === 'function',
            nativePrevFollowAtBottom,
            platform: Platform.OS === 'web' ? 'web' : 'native',
            previousWebMetrics,
            reason,
            type: 'request-write',
	            usesNativeFlashListBottomMaintenance,
	            waitMs: resolveAutoPinWaitMs(reason),
            writer,
	        });
        bottomFollowWriteSchedulerStateRef.current = schedulePlan.state;
        applyBottomFollowWriteSchedulerEffects(schedulePlan.effects);
    }, [
        applyBottomFollowWriteSchedulerEffects,
        resolveAutoPinWaitMs,
        usesNativeFlashListBottomMaintenance,
    ]);
    requestBottomFollowScheduledWriteRef.current = requestBottomFollowScheduledWrite;

    const applyScheduledContentGrowthLiveTailCommand = React.useCallback((
        params: Readonly<{
            effect: ContentGrowthLiveTailCommandApplyEffect | null;
            nativePrevFollowAtBottom: boolean;
            previousWebMetrics: WebTranscriptScrollMetrics | null;
        }>,
    ): boolean => {
        if (!params.effect) return false;
        if (params.effect.sessionId !== props.sessionId) return false;
        requestBottomFollowScheduledWrite(
            params.previousWebMetrics,
            params.effect.reason,
            params.nativePrevFollowAtBottom,
            'content-growth',
        );
        return true;
    }, [
        props.sessionId,
        requestBottomFollowScheduledWrite,
    ]);

    const requestAutomaticLiveTailPin = React.useCallback((
        previousWebMetrics: WebTranscriptScrollMetrics | null = null,
        reason: TranscriptViewportTelemetryScrollReason = 'content-size-change',
        nativePrevFollowAtBottom: boolean = false,
    ): boolean => {
        const plan = lifecycleHost.planContentGrowthLiveTailCommand({
            reason,
            sessionId: props.sessionId,
            wantsLiveTail: wantsPinnedRef.current,
        });
        commitBottomFollowModeState(plan.state.bottomFollowState);
        return applyScheduledContentGrowthLiveTailCommand({
            effect: plan.contentGrowthLiveTailCommandEffect,
            nativePrevFollowAtBottom,
            previousWebMetrics,
        });
    }, [
        applyScheduledContentGrowthLiveTailCommand,
        commitBottomFollowModeState,
        lifecycleHost,
        props.sessionId,
    ]);

    const requestMeasuredNativeAutomaticLiveTailPin = React.useCallback((
        reason: TranscriptViewportTelemetryScrollReason = 'content-size-change',
    ): boolean => {
        if (Platform.OS === 'web') return false;
        const plan = lifecycleHost.planContentGrowthLiveTailCommand({
            reason,
            sessionId: props.sessionId,
            wantsLiveTail: wantsPinnedRef.current,
        });
        commitBottomFollowModeState(plan.state.bottomFollowState);
        if (!plan.contentGrowthLiveTailCommandEffect) return false;
        return authorizeImmediateBottomFollowWriteRef.current(
            'passive-drift',
            plan.contentGrowthLiveTailCommandEffect.reason,
        );
    }, [
        commitBottomFollowModeState,
        lifecycleHost,
        props.sessionId,
    ]);

    const applySessionScopedMeasuredNativeAutomaticLiveTailPinEffects = React.useCallback((
        effects: readonly NativeMountSettlePassiveDriftRepinEffect[],
    ): void => {
        for (const effect of effects) {
            if (
                effect.type !== 'request-measured-native-automatic-live-tail-pin' ||
                effect.sessionId !== props.sessionId
            ) {
                continue;
            }
            requestMeasuredNativeAutomaticLiveTailPin(effect.reason);
        }
    }, [
        props.sessionId,
        requestMeasuredNativeAutomaticLiveTailPin,
    ]);
    const applyNativeMountSettlePassiveDriftRepinObservation = React.useCallback((params: Readonly<{
        bottomFollowMode: TranscriptBottomFollowModeState['mode'];
        isTrusted: boolean;
        nowMs: number;
        pinThresholdPx: number;
        usesNativeFlashListBottomMaintenance: boolean;
        wantsPinned: boolean;
    }>): void => {
        const preflightDecision = resolveNativeMountSettlePassiveDriftRepinPreflightDecision({
            autoPinDelayMs: TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS,
            bottomFollowMode: params.bottomFollowMode,
            isMountSettleActive: lifecycleHost.getMountSettleSnapshot().isMountSettleActive === true,
            isNative: Platform.OS !== 'web',
            isTrusted: params.isTrusted,
            lastUserScrollIntentAtMs: lastUserScrollIntentAtMsRef.current,
            nowMs: params.nowMs,
            usesNativeFlashListBottomMaintenance: params.usesNativeFlashListBottomMaintenance,
            wantsPinned: params.wantsPinned,
        });
        if (preflightDecision.type !== 'check-current-distance') return;

        // Cold-open open-flicker root fix: a structural `clearLayoutCacheOnUpdate` inside
        // the mount-settle window resets FlashList bottom maintenance and yanks the inverted
        // follow-bottom list toward the visual top. MVCP only MAINTAINS a bottom already
        // reached — it never re-travels there — so the passive-drift bail below would wrongly
        // leave the list yanked. While the mount window is still active and an untrusted frame
        // observes the list off the bottom with no recent user intent, re-issue the canonical
        // inverted bottom pin to catch the yank (and a known ~260ms second-source transient).
        // The pin's own off-bottom guard makes a same-content re-pin a no-op once the bottom
        // is reached, so this cannot loop.
        const distanceFromLiveTailPx = readCurrentNativeDistanceFromBottom();
        const distanceDecision = resolveNativeMountSettlePassiveDriftRepinDistanceDecision({
            distanceFromLiveTailPx,
            pinThresholdPx: params.pinThresholdPx,
        });
        applySessionScopedMeasuredNativeAutomaticLiveTailPinEffects(
            resolveNativeMountSettlePassiveDriftRepinEffects({
                decision: distanceDecision,
                sessionId: props.sessionId,
            }),
        );
    }, [
        applySessionScopedMeasuredNativeAutomaticLiveTailPinEffects,
        props.sessionId,
        readCurrentNativeDistanceFromBottom,
    ]);

    const observeWebGenuineScrollMovement = React.useCallback((params: Readonly<{
        distanceFromBottom: number;
        isTrusted: boolean;
        metrics: WebTranscriptScrollMetrics | null;
        pinThresholdPx: number;
        visualBottomScrollOffset: number | null;
    }>): Readonly<{
        webObservedUpwardIntent: boolean;
        webObservedUserScrollMovement: boolean;
    }> => {
        const metrics = params.metrics;
        if (!metrics) {
            return {
                webObservedUpwardIntent: false,
                webObservedUserScrollMovement: false,
            };
        }
        // Plan E3 / C3b: genuine web scroll (scrollbar drag / keyboard) fires no
        // wheel/pointer/touch handler and is not reliably `isTrusted`, so the single
        // owner `webDomObservation` classifies it as "scrollTop moved to
        // a value that does NOT match the app's own last programmatic write". This is
        // the web release authority fed to the lifecycle below — never the event
        // `isTrusted` flag, which RN-web also sets for our own pin/restore writes (the
        // Q1-WEB-1 root cause). When content height is stable a genuine away-move
        // releases eagerly; while content is reflowing it must be beyond-threshold or
        // sustained so streaming churn cannot masquerade as scrollbar/keyboard intent.
        const movement = webDomObservation.observeGenuineScrollMovement({
            metrics,
            fallbackObservedScrollTop: wantsPinnedRef.current ? params.visualBottomScrollOffset : null,
            distanceFromBottom: params.distanceFromBottom,
            pinThresholdPx: params.pinThresholdPx,
            sustainFrames: TRANSCRIPT_WEB_NON_PROGRAMMATIC_SCROLL_SUSTAIN_FRAMES,
            isTrusted: params.isTrusted,
        });
        if (!movement.isGenuineUserMovement) {
            return {
                webObservedUpwardIntent: false,
                webObservedUserScrollMovement: false,
            };
        }

        if (!movement.upwardIntent) {
            return {
                webObservedUpwardIntent: false,
                webObservedUserScrollMovement: true,
            };
        }

        return {
            webObservedUpwardIntent: true,
            webObservedUserScrollMovement: true,
        };
    }, [webDomObservation]);

    const handleComposerInsetHeightChange = React.useCallback((height: number) => {
        const nextHeight = typeof height === 'number' && Number.isFinite(height) ? Math.max(0, Math.trunc(height)) : 0;
        const previousHeight = composerInsetHeightRef.current;
        if (previousHeight === nextHeight) return;
        composerInsetHeightRef.current = nextHeight;
        setComposerInsetHeight(nextHeight);
        observeMountSettleMetrics();

        requestAutomaticLiveTailPin(null, 'layout-change');
    }, [observeMountSettleMetrics, requestAutomaticLiveTailPin]);

    const listFooterNode = React.useMemo(() => (
        <>
            {webPrependRangeReservePx > 0 ? (
                <View
                    pointerEvents="none"
                    testID="transcript-web-prepend-range-reserve"
                    style={{ height: webPrependRangeReservePx }}
                />
            ) : null}
            <ChatListFooterWithKeyboardInset
                sessionId={props.sessionId}
                bottomNotice={props.bottomNotice}
                controlledByUserOverride={props.controlledByUserOverride}
                controlSwitchTo={props.controlSwitchTo ?? null}
                onRequestSwitchToRemote={props.onRequestSwitchToRemote}
                directControl={props.directControlFooter}
                onComposerInsetHeightChange={handleComposerInsetHeightChange}
            />
        </>
    ), [
        handleComposerInsetHeightChange,
        props.bottomNotice,
        props.controlSwitchTo,
        props.controlledByUserOverride,
        props.directControlFooter,
        props.onRequestSwitchToRemote,
        props.sessionId,
        webPrependRangeReservePx,
    ]);
    const handleNativeHotTailHeightChange = React.useCallback((height: number) => {
        const normalizedHeight =
            typeof height === 'number' && Number.isFinite(height) ? Math.max(0, Math.trunc(height)) : 0;
        if (nativeHotTailHeightRef.current === normalizedHeight) return;
        nativeHotTailHeightRef.current = normalizedHeight;
        pinNativeLiveTailForHotTailHeightRef.current?.(normalizedHeight);
    }, []);
    const flashListFooterNode = React.useMemo(() => {
        if (shouldUseWebHotColdSplit) {
            return (
                <WebTranscriptSplitFooter
                    hotItems={transcriptHotColdSegments.hotItems}
                    startIndex={transcriptHotColdSegments.coldItems.length}
                    renderItemAtIndex={renderTranscriptItemAtIndex}
                    footer={listFooterNode}
                />
            );
        }
        if (shouldUseNativeHotColdSplit) {
            return (
                <TranscriptHotTail
                    hotItems={transcriptHotColdSegments.hotItemsCanonical}
                    startIndex={Math.max(0, transcriptHotColdSegments.hotCount - 1)}
                    displayIndexMode="invertedEdgeSlot"
                    renderItemAtIndex={renderTranscriptItemAtIndex}
                    footer={listFooterNode}
                    testIDPrefix="transcript-native-hot-tail"
                    onHeightChange={handleNativeHotTailHeightChange}
                />
            );
        }
        return listFooterNode;
    }, [
        handleNativeHotTailHeightChange,
        listFooterNode,
        renderTranscriptItemAtIndex,
        shouldUseNativeHotColdSplit,
        shouldUseWebHotColdSplit,
        transcriptHotColdSegments.coldItems.length,
        transcriptHotColdSegments.hotCount,
        transcriptHotColdSegments.hotItems,
        transcriptHotColdSegments.hotItemsCanonical,
    ]);
    // In an inverted FlashList the header slot renders at the data start = visual bottom.
    const mainTranscriptListShellEdgeSlots = React.useMemo(() => resolveTranscriptListShellEdgeSlots({
        frame: mainTranscriptListShellFrame,
        visualTopNode: listHeaderNode,
        visualBottomNode: flashListFooterNode,
    }), [flashListFooterNode, listHeaderNode, mainTranscriptListShellFrame]);
    const mainTranscriptListOlderLoadOverlay =
        (olderPagination.isLoadingOlder || isLoadingOlder) && !showFirstPaintPlaceholder ? (
            <OlderLoadProgressOverlay />
        ) : null;
    const mainTranscriptListCatchUpOverlay = (
        <CatchUpProgressOverlay
            isCatchingUp={showCatchUpOverlay}
            bottomInset={composerInsetHeight}
            spinnerDelayMs={sync.getSyncTuning().transcriptOlderLoadSpinnerDelayMs}
        />
    );
    const layoutObservationApplierEffects = React.useMemo<TranscriptLayoutObservationApplierEffects<WebTranscriptScrollMetrics>>(() => ({
        captureNativeBottomFollowPreviousFollow,
        captureWebBottomFollowPreviousMetrics,
        commitLayoutHeight: (height: number) => {
            listLayoutHeightRef.current = height;
            setListLayoutHeight(height);
        },
        observeMountSettleMetrics,
        observeNativePrependOwner,
        observeWebPrependOwner,
        pinNativeInitialFollowBottomViewportIfReady,
        recordLayoutMeasuredTelemetry: ({ contentHeight, layoutHeight }) => {
            recordViewportTelemetryEvent({
                type: 'layout-measured',
                mode: resolveViewportTelemetryMode(),
                reason: 'layout-change',
                layoutHeight,
                contentHeight,
            });
        },
        recordNativeVisibleWindowTelemetry,
        requestAutomaticLiveTailPin,
        runEntryRestoreAttempt,
        verifyNativeSliceEntryRestoreTransaction,
    }), [
        captureNativeBottomFollowPreviousFollow,
        captureWebBottomFollowPreviousMetrics,
        observeMountSettleMetrics,
        observeNativePrependOwner,
        observeWebPrependOwner,
        pinNativeInitialFollowBottomViewportIfReady,
        recordNativeVisibleWindowTelemetry,
        recordViewportTelemetryEvent,
        requestAutomaticLiveTailPin,
        resolveViewportTelemetryMode,
        runEntryRestoreAttempt,
        verifyNativeSliceEntryRestoreTransaction,
    ]);
    const contentSizeObservationApplierEffects = React.useMemo<TranscriptContentSizeObservationApplierEffects<WebTranscriptScrollMetrics>>(() => ({
        captureNativeBottomFollowPreviousFollow,
        captureWebBottomFollowPreviousMetrics,
        commitContentHeight: (measuredContentHeight: number) => {
            listContentHeightRef.current = measuredContentHeight;
            if (shouldCommitContentHeightState()) {
                setListContentHeight(measuredContentHeight);
            }
        },
        observeMountSettleMetrics,
        observeNativePrependOwner,
        observeWebPrependOwner,
        pinNativeInitialFollowBottomViewportIfReady,
        prepareNativeContentMaterializationAutoPin: (observation) => {
            nativeContentMaterializationAutoPinRef.current =
                resolveNativeContentMaterializationAutoPin({
                    contentHeight: observation.measuredContentHeight,
                    hasInitialViewportApplied: hasNativeInitialViewportAppliedForCurrentSession(),
                    isNative: Platform.OS !== 'web',
                    lastBottomFollowPinCommandSessionId:
                        lastNativeBottomFollowPinCommandRef.current?.sessionId,
                    layoutHeight: listLayoutHeightRef.current,
                    pinThresholdPx,
                    previousContentHeight: observation.previousMeasuredContentHeight,
                    reason: observation.reason,
                    sessionId: props.sessionId,
                    usesNativeFlashListBottomMaintenance,
                    wantsPinned: wantsPinnedRef.current,
                });
        },
        recordContentMeasuredTelemetry: ({ contentHeight, layoutHeight, reason }) => {
            recordViewportTelemetryEvent({
                type: 'content-measured',
                mode: resolveViewportTelemetryMode(),
                reason,
                layoutHeight,
                contentHeight,
            });
        },
        recordNativeVisibleWindowTelemetry,
        observeNativeStreamAppendOffsetEscape,
        requestAutomaticLiveTailPin,
        runEntryRestoreAttempt,
        verifyNativeSliceEntryRestoreTransaction,
    }), [
        captureNativeBottomFollowPreviousFollow,
        captureWebBottomFollowPreviousMetrics,
        hasNativeInitialViewportAppliedForCurrentSession,
        observeMountSettleMetrics,
        observeNativePrependOwner,
        observeWebPrependOwner,
        pinNativeInitialFollowBottomViewportIfReady,
        pinThresholdPx,
        props.sessionId,
        recordNativeVisibleWindowTelemetry,
        recordViewportTelemetryEvent,
        observeNativeStreamAppendOffsetEscape,
        requestAutomaticLiveTailPin,
        resolveViewportTelemetryMode,
        runEntryRestoreAttempt,
        shouldCommitContentHeightState,
        usesNativeFlashListBottomMaintenance,
        verifyNativeSliceEntryRestoreTransaction,
    ]);

    React.useEffect(() => {
        return () => {
            const scheduled = scheduledPinRef.current;
            if (!scheduled) return;
            scheduledPinRef.current = null;
            if (scheduled.kind === 'raf') {
                const caf = (globalThis as any)?.cancelAnimationFrame as undefined | ((id: any) => void);
                if (typeof caf === 'function') {
                    caf(scheduled.id);
                }
            } else {
                clearTimeout(scheduled.id);
            }
        };
    }, []);

    React.useLayoutEffect(() => {
        // When pinned, proactively keep the list at the visual bottom as new activity arrives.
        // This complements `maintainVisibleContentPosition`, especially on platforms where
        // inverted list anchoring can be inconsistent.
        const latestActivityKey = props.latestCommittedActivityKey;
        const hasNewCommittedActivity =
            latestActivityKey != null &&
            lastProactiveAutoFollowActivityKeyRef.current !== latestActivityKey;
        if (latestActivityKey == null) {
            lastProactiveAutoFollowActivityKeyRef.current = null;
        }
        if (hasNewCommittedActivity) {
            lastProactiveAutoFollowActivityKeyRef.current = latestActivityKey;
            const nativeOffsetEscapedBottomFollow = observeNativeStreamAppendOffsetEscape({
                contentHeight: listContentHeightRef.current,
                layoutHeight: listLayoutHeightRef.current,
            });
            if (
                !nativeOffsetEscapedBottomFollow &&
                isPinnedRef.current &&
                canAutoFollowForReason('stream-append') &&
                !usesNativeFlashListBottomMaintenance
            ) {
                // Native flash stream growth pins exactly once per measured content
                // version from onContentSizeChange (plan B3 single writer).
                authorizeImmediateBottomFollowWriteRef.current('proactive-auto-follow', 'stream-append');
            }
        }
        const nextScrollPin = resolveTranscriptScrollPinStateUpdate(
            { ...scrollPinRef.current, isPinned: isPinnedRef.current },
            {
                type: 'newActivity',
                enabled: pinEnabled,
                activityKey: props.latestCommittedActivityKey,
            },
        );
        if (nextScrollPin) {
            commitScrollPinState(nextScrollPin);
        }
    }, [
        canAutoFollowForReason,
        commitScrollPinState,
        pinEnabled,
        props.latestCommittedActivityKey,
        observeNativeStreamAppendOffsetEscape,
        usesNativeFlashListBottomMaintenance,
    ]);

    const beginSessionOpenWebBottomEntry = React.useCallback((deadlineMs: number): boolean => {
        if (Platform.OS !== 'web') return false;
        if (entryRestoreOwner.hasOpenTransaction(props.sessionId)) return true;
        const metrics = resolveWebScrollMetrics();
        if (!metrics) return false;
        pinToBottom('initial-open');
        applyEntryRestoreOwnerEffects(entryRestoreOwner.beginWebBottom({
            contentHeight: Math.max(0, Math.trunc(metrics.scrollHeight)),
            deadlineMs,
            layoutHeight: Math.max(0, Math.trunc(metrics.clientHeight)),
            nowMs: Date.now(),
            sessionId: props.sessionId,
        }));
        return entryRestoreOwner.hasOpenTransaction(props.sessionId);
    }, [
        applyEntryRestoreOwnerEffects,
        entryRestoreOwner,
        pinToBottom,
        props.sessionId,
        resolveWebScrollMetrics,
    ]);

    const executeSessionOpenInitialPinAttempt = React.useCallback((): boolean => {
        if (Platform.OS === 'web') {
            if (wantsPinnedRef.current === false) {
                preemptEntryRestoreTransaction();
                initialWebPinStabilizingRef.current = false;
                return true;
            }
            if (Date.now() - lastUserScrollIntentAtMsRef.current < TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS) return false;
            let pinApplied = false;
            if (!entryRestoreOwner.hasOpenTransaction(props.sessionId)) {
                pinApplied = pinToBottom('initial-open');
            }
            if (entryRestoreOwner.hasOpenTransaction(props.sessionId)) {
                verifyWebEntryRestoreTransaction();
            }
            if (!entryRestoreOwner.hasOpenTransaction(props.sessionId)) {
                if (!pinApplied) {
                    return false;
                }
                initialWebPinStabilizingRef.current = false;
                return true;
            }
            return false;
        }
        pinToBottomRespectingNativeMountSettle('initial-open');
        return false;
    }, [
        entryRestoreOwner,
        pinToBottom,
        pinToBottomRespectingNativeMountSettle,
        preemptEntryRestoreTransaction,
        props.sessionId,
        verifyWebEntryRestoreTransaction,
    ]);

    const scheduleSessionOpenWebInitialPinRetry = React.useCallback((deadlineAtMs: number, retryIndex = 0): void => {
        if (Platform.OS !== 'web') return;
        if (jumpToSeqActiveRef.current) return;
        const existing = sessionOpenWebInitialPinRetryTimeoutRef.current;
        if (existing) {
            if (existing.sessionId === props.sessionId && existing.deadlineAtMs <= deadlineAtMs) return;
            clearTimeout(existing.timeoutId);
            sessionOpenWebInitialPinRetryTimeoutRef.current = null;
        }
        initialWebPinStabilizingRef.current = true;
        const timeoutId = setTimeout(() => {
            const handle = sessionOpenWebInitialPinRetryTimeoutRef.current;
            if (!handle || handle.timeoutId !== timeoutId) return;
            sessionOpenWebInitialPinRetryTimeoutRef.current = null;
            if (handle.sessionId !== currentSessionIdRef.current) return;
            if (jumpToSeqActiveRef.current) return;
            const completed = executeSessionOpenInitialPinAttempt();
            if (
                !completed &&
                wantsPinnedRef.current !== false &&
                !entryRestoreOwner.hasOpenTransaction(handle.sessionId) &&
                Date.now() - lastUserScrollIntentAtMsRef.current >= TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS
            ) {
                pinToBottom('initial-open');
            }
            const retryPlan = resolveSessionOpenWebInitialPinRetryPlan(sync.getSyncTuning());
            const nextRetryIndex = handle.retryIndex + 1;
            const nextRetryDelayMs = retryPlan.retryDelaysMs[nextRetryIndex];
            if (
                !jumpToSeqActiveRef.current &&
                wantsPinnedRef.current !== false &&
                typeof nextRetryDelayMs === 'number' &&
                Number.isFinite(nextRetryDelayMs) &&
                Date.now() - lastUserScrollIntentAtMsRef.current >= TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS
            ) {
                scheduleSessionOpenWebInitialPinRetry(
                    sessionOpenWebInitialPinRetryArmAtMsRef.current + Math.max(0, Math.trunc(nextRetryDelayMs)),
                    nextRetryIndex,
                );
            }
        }, Math.max(0, deadlineAtMs - Date.now()));
        sessionOpenWebInitialPinRetryTimeoutRef.current = {
            deadlineAtMs,
            retryIndex,
            sessionId: props.sessionId,
            timeoutId,
        };
    }, [
        entryRestoreOwner,
        executeSessionOpenInitialPinAttempt,
        pinToBottom,
        props.sessionId,
    ]);

    const scheduleFirstSessionOpenWebInitialPinRetry = React.useCallback((): void => {
        if (Platform.OS !== 'web' || sessionOpenWebInitialPinRetryTimeoutRef.current) return;
        const [retryDelayMs] = resolveSessionOpenWebInitialPinRetryPlan(sync.getSyncTuning()).retryDelaysMs;
        if (typeof retryDelayMs !== 'number' || !Number.isFinite(retryDelayMs)) return;
        scheduleSessionOpenWebInitialPinRetry(
            sessionOpenWebInitialPinRetryArmAtMsRef.current + Math.max(0, Math.trunc(retryDelayMs)),
            0,
        );
    }, [scheduleSessionOpenWebInitialPinRetry]);
    scheduleFirstSessionOpenWebInitialPinRetryRef.current = scheduleFirstSessionOpenWebInitialPinRetry;

    React.useEffect(() => {
        if (
            Platform.OS !== 'web' ||
            !props.sessionId ||
            !props.isLoaded ||
            props.jumpToSeq != null ||
            (
                sessionEntryViewportRef.current !== null &&
                (
                    sessionEntryViewportRef.current.sessionId !== props.sessionId ||
                    sessionEntryViewportRef.current.shouldFollowBottom === false
                )
            ) ||
            entryRestoreOwner.hasOpenTransaction(props.sessionId)
        ) {
            return;
        }
        scheduleFirstSessionOpenWebInitialPinRetry();
    }, [
        entryRestoreOwner,
        props.isLoaded,
        props.jumpToSeq,
        props.sessionId,
        scheduleFirstSessionOpenWebInitialPinRetry,
    ]);

    const applySessionOpenLatchEffects = React.useCallback((effects: readonly SessionOpenLatchEffect[]): void => {
        for (const effect of effects) {
            switch (effect.type) {
                case 'apply-arm-reset-plan':
                    applySessionOpenArmResetPlan(effect.plan);
                    continue;
                case 'apply-dispose-reset-plan':
                    applySessionOpenDisposeResetPlan(effect.plan);
                    continue;
                case 'hold-native-first-paint-placeholder':
                    continue;
                case 'release-native-first-paint-placeholder':
                    nativeMountSettleDeadlineReachedRef.current = true;
                    setNativeMountSettleDeadlineReached(true);
                    updateNativeInitialViewportPendingObservation(false);
                    break;
                case 'request-initial-pin': {
                    const completed = executeSessionOpenInitialPinAttempt();
                    if (!completed) scheduleFirstSessionOpenWebInitialPinRetry();
                    break;
                }
                case 'begin-web-bottom-entry':
                    if (beginSessionOpenWebBottomEntry(effect.deadlineMs)) {
                        verifyWebEntryRestoreTransaction();
                    }
                    break;
                case 'schedule-web-initial-pin-retry':
                    scheduleSessionOpenWebInitialPinRetry(effect.deadlineAtMs);
                    break;
                case 'request-initial-fill':
                    requestSessionOpenInitialFillRef.current();
                    break;
                case 'request-entry-restore-attempt':
                    runEntryRestoreAttempt();
                    verifyWebEntryRestoreTransaction();
                    break;
            }
        }
    }, [
        applySessionOpenArmResetPlan,
        applySessionOpenDisposeResetPlan,
        beginSessionOpenWebBottomEntry,
        executeSessionOpenInitialPinAttempt,
        props.sessionId,
        runEntryRestoreAttempt,
        scheduleFirstSessionOpenWebInitialPinRetry,
        scheduleSessionOpenWebInitialPinRetry,
        updateNativeInitialViewportPendingObservation,
        verifyWebEntryRestoreTransaction,
    ]);
    applySessionOpenLatchEffectsRef.current = applySessionOpenLatchEffects;

    React.useLayoutEffect(() => {
        if (!props.sessionId || !props.isLoaded || props.jumpToSeq != null) return;
        const sessionEntryViewport = sessionEntryViewportRef.current;
        if (
            Platform.OS === 'web' &&
            (
                sessionEntryViewport === null ||
                (
                    sessionEntryViewport.sessionId === props.sessionId &&
                    sessionEntryViewport.shouldFollowBottom !== false
                )
            )
        ) {
            const completed = executeSessionOpenInitialPinAttempt();
            if (!completed) scheduleFirstSessionOpenWebInitialPinRetry();
        }
        applySessionOpenLatchEffects(sessionOpenLatch.onHostFacts({
            contentHeight: listContentHeightRef.current,
            hasEntrySliceWindow: entrySliceWindowRef.current?.sessionId === props.sessionId,
            isLoaded: props.isLoaded,
            isScrollable: false,
            itemCount: props.items.length,
            layoutHeight: listLayoutHeightRef.current,
            nowMs: Date.now(),
            sessionId: props.sessionId,
            userWantsPinned: wantsPinnedRef.current,
        }).effects);
    }, [
        applySessionOpenLatchEffects,
        executeSessionOpenInitialPinAttempt,
        props.isLoaded,
        props.items.length,
        props.jumpToSeq,
        props.sessionId,
        scheduleFirstSessionOpenWebInitialPinRetry,
        sessionOpenLatch,
    ]);

    React.useEffect(() => {
        if (!props.sessionId || !props.isLoaded || props.jumpToSeq != null) return;
        const sessionEntryViewport = sessionEntryViewportRef.current;
        if (
            Platform.OS === 'web' &&
            (
                sessionEntryViewport === null ||
                (
                    sessionEntryViewport.sessionId === props.sessionId &&
                    sessionEntryViewport.shouldFollowBottom !== false
                )
            )
        ) {
            const completed = executeSessionOpenInitialPinAttempt();
            if (!completed) scheduleFirstSessionOpenWebInitialPinRetry();
        }
        applySessionOpenLatchEffects(sessionOpenLatch.onHostFacts({
            contentHeight: listContentHeightRef.current,
            hasEntrySliceWindow: entrySliceWindowRef.current?.sessionId === props.sessionId,
            isLoaded: props.isLoaded,
            isScrollable: false,
            itemCount: props.items.length,
            layoutHeight: listLayoutHeightRef.current,
            nowMs: Date.now(),
            sessionId: props.sessionId,
            userWantsPinned: wantsPinnedRef.current,
        }).effects);
    }, [
        applySessionOpenLatchEffects,
        executeSessionOpenInitialPinAttempt,
        props.isLoaded,
        props.items.length,
        props.jumpToSeq,
        props.sessionId,
        scheduleFirstSessionOpenWebInitialPinRetry,
        sessionOpenLatch,
    ]);

    const isScrollable = React.useCallback((): boolean => {
        // On web, list content height can include collapsed/offscreen subtrees (e.g. tool-call group bodies),
        // which can cause false positives. Prefer DOM scroll metrics when available.
        if (Platform.OS === 'web') {
            try {
                const metrics = resolveWebScrollMetrics();
                if (metrics) {
                    return isWebTranscriptScrollable(metrics, 1);
                }
            } catch {
                // fall through to measurement-based heuristic
            }
        }

        const layout = listLayoutHeight;
        const content = listContentHeight;
        if (!Number.isFinite(layout) || layout <= 0) return false;
        if (!Number.isFinite(content) || content <= 0) return false;
        return content > layout + 16;
    }, [listContentHeight, listLayoutHeight, resolveWebScrollMetrics]);

    const flashListStartReachedThreshold = React.useMemo(() => {
        if (!Number.isFinite(listLayoutHeight) || listLayoutHeight <= 0) {
            return TRANSCRIPT_EDGE_PREFETCH_FALLBACK_VIEWPORT_RATIO;
        }
        const thresholdPx = resolveBackwardPrefetchThresholdPx(listLayoutHeight);
        if (thresholdPx <= 0) return 0;
        return thresholdPx / listLayoutHeight;
    }, [listLayoutHeight, resolveBackwardPrefetchThresholdPx]);

    const resolveToolCallsCollapsedPreviewCount = React.useCallback((): number => {
        return resolveTranscriptToolCallsCollapsedPreviewCount(transcriptToolCallsCollapsedPreviewCountSetting);
    }, [transcriptToolCallsCollapsedPreviewCountSetting]);

    const tryAutoExpandNewestToolCallsGroup = React.useCallback((): boolean => {
        const previewCount = resolveToolCallsCollapsedPreviewCount();
        // The visitor needs turn/tool-calls-group shapes, so it scans the
        // PRE-decomposition source (always oldest-first) rather than the rendered
        // (possibly per-unit decomposed, possibly legacy-reversed) list data.
        const items = preDecompositionItemsRef.current;
        const shouldAutoExpandGroup = (toolMessageIds: readonly string[]): boolean => (
            shouldAutoExpandToolCallsGroupForShortTranscript({
                toolMessageCount: toolMessageIds.length,
                collapsedPreviewCount: previewCount,
                maxTurnEntriesPerListItem: props.maxTurnEntriesPerListItem,
            })
        );

        const visitItem = (it: ChatTranscriptListItem | null | undefined): boolean => {
            if (!it) return false;
            if (it.kind === 'tool-calls-group') {
                const toolMessageIds = it.toolMessageIds;
                if (!shouldAutoExpandGroup(toolMessageIds)) return false;
                if (toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id))) return false;
                applyToolCallsGroupExpanded({ toolCallsGroupId: it.id, toolMessageIds, expanded: true });
                return true;
            }
            if (it.kind === 'turn') {
                const content = it.turn?.content;
                if (!Array.isArray(content) || content.length === 0) return false;
                for (let j = content.length - 1; j >= 0; j -= 1) {
                    const c = content[j];
                    if (c.kind !== 'tool_calls') continue;
                    const toolMessageIds = c.toolMessageIds;
                    if (!shouldAutoExpandGroup(toolMessageIds)) continue;
                    if (toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id))) continue;
                    applyToolCallsGroupExpanded({ toolCallsGroupId: c.id, toolMessageIds, expanded: true });
                    return true;
                }
            }
            return false;
        };

        for (let i = items.length - 1; i >= 0; i -= 1) {
            if (visitItem(items[i])) return true;
        }
        return false;
    }, [
        applyToolCallsGroupExpanded,
        expandedToolCallsAnchorMessageIds,
        props.maxTurnEntriesPerListItem,
        resolveToolCallsCollapsedPreviewCount,
    ]);

    React.useEffect(() => {
        // Intentionally runs after every render until the transcript becomes scrollable or we succeed.
        // The turns/grouping builder can update in-place as message bodies hydrate, so relying on
        // `items`/`listData` identity is not robust here.
        if (props.jumpToSeq != null) return;
        if (!props.sessionId) return;
        if (sessionOpenLatch.hasAutoExpandedToolCallsGroups(props.sessionId)) return;
        if (isScrollable()) return;

        const expanded = tryAutoExpandNewestToolCallsGroup();
        if (!expanded) return;

        sessionOpenLatch.markAutoExpandedToolCallsGroups(props.sessionId);
        fireAndForget((async () => {
            await Promise.resolve();
            await Promise.resolve();
            if (sessionEntryViewportRef.current?.shouldFollowBottom === false) return;
            pinToBottom('content-size-change');
        })(), { tag: 'ChatList.autoExpandToolCallsGroup' });
    });

    const isWebTranscriptSeqMounted = React.useCallback((seq: number): boolean => {
        return isTranscriptSeqMountedInWebRenderedWindow({
            hasAnyTestId: hasAnyWebTranscriptDataTestId,
            hotTailTestIdPrefix: TRANSCRIPT_WEB_HOT_TAIL_ITEM_TEST_ID_PREFIX,
            items: canonicalWindowedItemsRef.current, platformOS: Platform.OS,
            prependAnchorTestIdPrefix: TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX,
            resolveContainer: () => resolveWebScrollMetrics()?.element,
            resolveItemId: (item) => item.id, resolveSeq: resolveTargetWindowItemSeq, seq,
        });
    }, [resolveTargetWindowItemSeq, resolveWebScrollMetrics]);

    const jumpToTranscriptTarget = React.useCallback(async (
        target: TranscriptJumpTarget,
        options?: Readonly<{ align?: TranscriptViewportJumpAlignment; preferTargetWindow?: boolean }>,
    ): Promise<TranscriptJumpResult> => {
        const targetRequest = resolveTranscriptJumpTargetRequest(target);
        if (!targetRequest) return { status: 'not-found', reason: 'invalid-target' };
        const { normalizedTargetSeq, routeMessageId, transcriptBlockIndex, role } = targetRequest;
        const sessionId = props.sessionId;
        if (!sessionId) return { status: 'not-found', reason: 'unavailable' };
        beginExplicitJumpWriteBarrier();

        const scrollToTarget = (): boolean => {
            const command = resolveViewportCommand({
                type: 'jump-to-seq',
                sessionId,
                seq: normalizedTargetSeq,
                routeMessageId,
                transcriptBlockIndex,
                role,
                ...(options?.align ? { align: options.align } : {}),
            });
            const applied = executeViewportCommandWithAnimation(command, true);
            if (applied && Platform.OS === 'web') {
                pendingJumpSeqViewportPromotionRef.current = {
                    emitViewportChange: onViewportChangeRef.current,
                    seq: normalizedTargetSeq,
                    sessionId,
                };
                const metrics = resolveWebScrollMetrics();
                if (metrics) {
                    promotePendingJumpSeqViewportSnapshot({
                        distanceFromBottom: getWebTranscriptDistanceFromBottom(metrics),
                        metrics,
                        requireRestorableAnchor: true,
                        scrollOffsetPx: metrics.scrollTop,
                    });
                }
            }
            return applied;
        };

        try {
            const result = await executeTranscriptTargetWindowJump({
                align: options?.align,
                canRenderTargetWindow: options?.preferTargetWindow === true && !props.forkedTranscriptEnabled,
                forceTargetWindow: options?.preferTargetWindow === true,
                isTargetInRenderedWindow: () => isTranscriptJumpTargetInRenderedWindow(target),
                isTargetMounted: () => Platform.OS === 'web'
                    ? isWebTranscriptSeqMounted(normalizedTargetSeq)
                    : true,
                loadTargetWindow: async ({ target: windowTarget, direction }) => {
                    const loadTarget = resolveTranscriptTargetWindowLoadTarget(windowTarget, normalizedTargetSeq);
                    const result = await sync.loadTargetWindowMessages(sessionId, loadTarget, {
                        direction: direction ?? 'initial',
                    });
                    if (result?.status === 'stale') return { status: 'stale' as const };
                    if (result?.status === 'loaded' && result.targetPresent) {
                        activeTargetWindowTargetRef.current = windowTarget;
                        return {
                            windowId: result.windowId,
                            targetSeq: result.targetSeq,
                            newerCursor: result.newerCursor,
                            hasMoreNewer: result.hasMoreNewer,
                        };
                    }
                    return null;
                },
                onJumpLanded: props.onJumpLanded,
                pageTowardTarget: async () => {
                    const syncLoadOlderOptions = resolveSyncLoadOlderOptions();
                    const loadOlderResult = props.forkedTranscriptEnabled
                        ? (syncLoadOlderOptions
                            ? await sync.loadOlderMessagesForkAware(sessionId, syncLoadOlderOptions)
                            : await sync.loadOlderMessagesForkAware(sessionId))
                        : (syncLoadOlderOptions
                            ? await sync.loadOlderMessages(sessionId, syncLoadOlderOptions)
                            : await sync.loadOlderMessages(sessionId));
                    if (loadOlderResult.status === 'no_more') {
                        return { status: 'not-found', reason: 'exhausted' };
                    }
                    await Promise.resolve();
                    await Promise.resolve();
                    return scrollToTarget()
                        ? { status: 'scrolled', target }
                        : { status: 'not-found', reason: 'unavailable' };
                },
                platformOS: Platform.OS,
                readScrollTop: () => resolveWebScrollMetrics()?.scrollTop ?? null,
                resolveTargetIndex: () => resolveJumpTargetIndexFromRenderedWindow(target),
                scrollToTarget,
                target,
                targetSeq: normalizedTargetSeq,
                hasGenuineUserMovementSince: (sinceMs) =>
                    lastRouteJumpProtectionClearingWebMovementAtMsRef.current > sinceMs,
                waitForNextLandingFrame: async () => {
                    await waitForVisualUpdateWithTimeout({
                        waitForNextVisualUpdate,
                        timeoutMs: TRANSCRIPT_VISUAL_UPDATE_FALLBACK_TIMEOUT_MS,
                    });
                },
            });
            return result;
        } finally {
            endExplicitJumpWriteBarrier();
        }
    }, [beginExplicitJumpWriteBarrier, endExplicitJumpWriteBarrier, props.forkedTranscriptEnabled, props.onJumpLanded, props.sessionId, executeViewportCommandWithAnimation, isWebTranscriptSeqMounted, isTranscriptJumpTargetInRenderedWindow, promotePendingJumpSeqViewportSnapshot, resolveJumpTargetIndexFromRenderedWindow, resolveSyncLoadOlderOptions, resolveWebScrollMetrics, resolveViewportCommand, waitForNextVisualUpdate]);

    const handleTranscriptNavigationRailJump = React.useCallback((
        entry: TranscriptNavigationEntry,
        request: TranscriptNavigationJumpRequest,
    ): Promise<TranscriptJumpResult> | undefined => {
        const plan = resolveTranscriptNavigationJumpPlan({
            entry,
            isTargetInRenderedWindow: isTranscriptJumpTargetInRenderedWindow,
            request,
            sessionId: props.sessionId,
        });
        if (!plan) return;
        const result = jumpToTranscriptTarget(plan.target, {
            align: plan.align,
            preferTargetWindow: plan.preferTargetWindow,
        });
        fireAndForget(result, { tag: 'ChatList.transcriptNavigationRailJump' });
        return result;
    }, [isTranscriptJumpTargetInRenderedWindow, jumpToTranscriptTarget, props.sessionId]);

    const handleTranscriptNavigationPaneEntryPress = React.useCallback((entry: TranscriptNavigationEntry): Promise<TranscriptJumpResult> | undefined => {
        const request = resolveTranscriptNavigationPaneJumpRequest(entry, props.sessionId);
        return request ? handleTranscriptNavigationRailJump(entry, request) : undefined;
    }, [handleTranscriptNavigationRailJump, props.sessionId]);

    React.useLayoutEffect(() => {
        transcriptNavigationPaneStore.set(props.sessionId, {
            activeEntryId: transcriptNavigationRailVisibilitySnapshot.currentAnchorId,
            entries: props.transcriptNavigationEntries,
            onEntryPress: handleTranscriptNavigationPaneEntryPress,
        });
        return () => {
            transcriptNavigationPaneStore.set(props.sessionId, null);
        };
    }, [handleTranscriptNavigationPaneEntryPress, props.sessionId, props.transcriptNavigationEntries, transcriptNavigationRailVisibilitySnapshot.currentAnchorId]);

    React.useEffect(() => {
        const normalizedTarget = resolveTranscriptRouteJumpSeqPlan({
            committedMessagesCount: props.committedMessagesCount,
            hasUsableWebMetrics: () => {
                const metrics = resolveWebScrollMetrics();
                return !!metrics && metrics.clientHeight > 0 && metrics.scrollHeight > 0;
            },
            inFlightJumpSeq: inFlightJumpSeqRef.current,
            isLoaded: props.isLoaded,
            jumpToSeq: props.jumpToSeq,
            lastJumpSeq: lastJumpSeqRef.current,
            listContentHeight,
            listLayoutHeight,
            platformOS: Platform.OS,
            sessionId: props.sessionId,
        });
        if (normalizedTarget == null) return;

        inFlightJumpSeqRef.current = normalizedTarget;
        fireAndForget((async () => {
            try {
                const result = await jumpToTranscriptTarget(
                    { kind: 'seq', seq: normalizedTarget },
                    { preferTargetWindow: true },
                );
                if (result.status === 'scrolled' || result.status === 'window-rendered') {
                    lastJumpSeqRef.current = normalizedTarget;
                }
            } finally {
                if (inFlightJumpSeqRef.current === normalizedTarget) {
                    inFlightJumpSeqRef.current = null;
                }
            }
        })(), { tag: 'ChatList.jumpToTranscriptSeq' });
    }, [props.committedMessagesCount, props.isLoaded, props.jumpToSeq, props.sessionId, jumpToTranscriptTarget, listContentHeight, listLayoutHeight, resolveWebScrollMetrics]);

    React.useEffect(() => {
        if (!props.isLoaded) return;
        if (props.jumpToSeq != null) return;
        if (!props.sessionId) return;
        if (sessionOpenLatch.initialFillStatus() !== 'idle') return;

        // Wait for at least one layout + content measurement pass before deciding whether to fill.
        if (listLayoutHeight <= 0 || listContentHeight <= 0) return;

        if (!sessionOpenLatch.markInitialFillInProgress(props.sessionId)) return;
        initialFillAbortRef.current?.abort();
        const controller = new AbortController();
        initialFillAbortRef.current = controller;
        const signal = controller.signal;
        const shouldPinDuringInitialFill = sessionEntryViewportRef.current?.shouldFollowBottom !== false;
        fireAndForget((async () => {
            if (shouldPinDuringInitialFill) {
                // Pin once up front for follow-bottom entries; observed unpinned restores must keep
                // their reading viewport while initial fill fetches older pages.
                pinToBottomRespectingNativeMountSettle('initial-open');
                if (Platform.OS === 'web') {
                    // D5 (evidence E10): rAF starvation in background tabs must not stall fill.
                    await waitForVisualUpdateWithTimeout({
                        waitForNextVisualUpdate,
                        timeoutMs: TRANSCRIPT_VISUAL_UPDATE_FALLBACK_TIMEOUT_MS,
                    });
                }
            }

            const tuning = sync.getSyncTuning();
            const startedAtMs = Date.now();
            const { budgetMs, maxNoProgressLoads } = resolveTranscriptInitialFillTuning({
                transcriptInitialFillBudgetMs: tuning.transcriptInitialFillBudgetMs,
                transcriptInitialFillMaxNoProgressLoads: tuning.transcriptInitialFillMaxNoProgressLoads,
            });
            let consecutiveNoProgressLoads = 0;

            while (true) {
                if (signal.aborted) return;
                // If the transcript is scrollable and we have at least one visible committed message,
                // stop prefetching older pages.
                if (isScrollable() && props.committedMessagesCount > 0) break;
                // N2b.2: the slice decided WHAT to fill — a sliced window is its own fill
                // verdict (under-filled sliced entries stay write-free by construction;
                // filling above the anchor would only grow the withheld range).
                if (entrySliceWindowRef.current?.sessionId === props.sessionId) break;
                if (Date.now() - startedAtMs >= budgetMs) break;

                const result = await loadOlder({ preservePrependViewport: false, showLoadingIndicator: false });
                if (!result) break;
                if (result.status === 'no_more') break;

                const madeProgress = result.status === 'loaded' && result.loaded > 0;
                consecutiveNoProgressLoads = madeProgress ? 0 : consecutiveNoProgressLoads + 1;

                // Yield to allow store updates + list re-render + content size update.
                await Promise.resolve();
                await Promise.resolve();
                if (shouldPinDuringInitialFill && wantsPinnedRef.current) {
                    pinToBottomRespectingNativeMountSettle('initial-open');
                }
                if (consecutiveNoProgressLoads >= maxNoProgressLoads) break;
            }
            if (signal.aborted) return;
            applySessionOpenLatchEffects(sessionOpenLatch.onInitialFillSettled({
                nowMs: Date.now(),
                sessionId: props.sessionId,
            }).effects);
            observeMountSettleMetrics();
            if (!shouldPinDuringInitialFill) {
                // Fill settled: resolve (and verify on web) the entry-restore transaction.
                runEntryRestoreAttempt();
                verifyWebEntryRestoreTransaction();
            }
        })(), { tag: 'ChatList.initialFillOlderMessages' });
    }, [
        isScrollable,
        listContentHeight,
        listLayoutHeight,
        loadOlder,
        observeMountSettleMetrics,
        applySessionOpenLatchEffects,
        pinToBottomRespectingNativeMountSettle,
        props.committedMessagesCount,
        props.isLoaded,
        props.jumpToSeq,
        props.sessionId,
        runEntryRestoreAttempt,
        sessionOpenLatch,
        verifyWebEntryRestoreTransaction,
        waitForNextVisualUpdate,
    ]);
    requestSessionOpenInitialFillRef.current = requestSessionOpenInitialFill;

    React.useEffect(() => {
        if (!props.sessionId) return;
        const decision = sessionOpenLatch.onHostFacts({
            contentHeight: listContentHeight,
            hasEntrySliceWindow: entrySliceWindowRef.current?.sessionId === props.sessionId,
            isLoaded: props.isLoaded,
            isScrollable: isScrollable(),
            itemCount: displayItems.length,
            layoutHeight: listLayoutHeight,
            nowMs: Date.now(),
            sessionId: props.sessionId,
            userWantsPinned: wantsPinnedRef.current,
        });
        applySessionOpenLatchEffects(decision.effects);
    }, [
        applySessionOpenLatchEffects,
        isScrollable,
        displayItems.length,
        listContentHeight,
        listLayoutHeight,
        props.isLoaded,
        props.sessionId,
        sessionOpenLatch,
    ]);

    const transcriptScrollIngressPlatform: TranscriptScrollIngressPlatform =
        Platform.OS === 'web' ? 'web' : 'native';
    const transcriptScrollIngressCallbacks: TranscriptScrollIngressCallbacks = {
        activeViewportCommandOwner: () => viewportCommandController.activeOwner(),
        applyEntryRestoreOwnerEffects,
        applyNativeMountSettlePassiveDriftRepinObservation,
        applyNativePrependOwnerEffects,
        applyScrollObservationPlan: applyLifecycleHostScrollObservationPlan,
        commitOpenNativeEntryRestoreVisibleState(distanceFromLiveTailPx) {
            if (props.isLoaded && listDataRef.current.length > 0) {
                updateNativeViewportPaintObserved(true);
                if (firstPaintTelemetryRef.current?.recorded === false) {
                    recordFirstListPaint();
                }
            }
            const visibleDistanceFromBottom =
                entryRestoreOwner.visibleDistanceForOpenNativeEntry({
                    observedDistanceFromBottom: distanceFromLiveTailPx,
                    sessionId: props.sessionId,
                });
            if (visibleDistanceFromBottom == null) return;
            commitJumpToBottomDistanceForVisibility(visibleDistanceFromBottom);
            commitScrollPinEvent({
                type: 'scroll',
                enabled: pinEnabled,
                offsetY: visibleDistanceFromBottom,
                pinnedOffsetThresholdPx: pinThresholdPx,
            });
        },
        drainDeferredNewerMessages,
        hasOpenNativeEntryRestoreTransaction: () =>
            entryRestoreOwner.hasOpenTransaction(props.sessionId),
        hasOpenNativePrependTransaction: () =>
            nativePrependOwner.hasOpenTransaction(props.sessionId),
        invalidateViewportAnchorCapture,
        lifecycleHost,
        observeMountSettleMetrics,
        observeNativeConfirmation,
        observeNativeEntryRestoreHostFacts,
        observeNativePrependOwner,
        observeOlderPaginationScroll,
        observeWebGenuineScrollMovement,
        observeWebTranscriptNavigationVisibility: observeWebTranscriptNavigationVisibilityForSession,
        preemptEntryRestoreTransaction,
        promotePendingJumpSeqViewportSnapshot,
        recordNativeScrollObservation(input) {
            recordScrollObservedTelemetry({
                offsetY: input.canonicalOffsetY,
                rawOffsetY: input.rawOffsetY,
                canonicalOffsetY: input.canonicalOffsetY,
                layoutHeight: input.layoutHeight,
                contentHeight: input.contentHeight,
                distanceFromBottom: input.distanceFromBottom,
                reason: input.reason,
            });
        },
        recordWebRouteJumpProtectionClearingMovement(timestampMs) {
            lastRouteJumpProtectionClearingWebMovementAtMsRef.current = timestampMs;
        },
        recordNativeVisibleWindowTelemetry,
        refreshInFlightWebPrependAnchor,
        resolveWebScrollMetrics,
        retargetPendingWebPrependAnchorForUserScroll,
        shouldIgnoreNativeInvalidScrollObservation,
        trustedNativePrependScroll: (input) => nativePrependOwner.trustedScroll(input),
        updateNativeViewportPaintObserved,
        verifyWebEntryRestoreTransaction,
    };

    return (
        <TranscriptMotionProvider sessionKey={props.sessionId} config={motionConfig}>
            <View
              style={{ flex: 1 }}
              {...(Platform.OS === 'web'
                ? ({
                                        onWheel: stopScrollEventPropagationOnWeb,
                                        onTouchMove: stopScrollEventPropagationOnWeb,
                                        onPointerDown: markUserScrollIntentOnWeb,
                                        onMouseDown: markUserScrollIntentOnWeb,
                                  } as any)
                : {})}
            >
                  <TranscriptListShell<ChatTranscriptListItem>
                      ref={(node: TranscriptListShellRef<ChatTranscriptListItem> | null) => {
                          listRef.current = node as unknown as ScrollableChatListRef | null;
                      }}
                      frame={mainTranscriptListShellFrame}
                      onCommitLayoutEffect={recordLayoutCommitObserved}
                      platformInteractionProps={mainTranscriptListShellPlatformInteractionProps}
                      data={listData}
                      extraData={transcriptListExtraData}
                      key={props.sessionId}
                      keyExtractor={keyExtractor}
                        overrideProps={nativeFlashListScrollOverrideProps}
                        getItemType={getItemType}
                      onLoad={handleFlashListLoad}
                      onViewableItemsChanged={shouldAttachNativeViewability ? handleNativeViewableItemsChanged : undefined}
                      viewabilityConfig={nativeViewabilityConfig}
	                      onLayout={(e: LayoutChangeEvent) => {
	                          const layout = e?.nativeEvent?.layout;
	                          recordListLayoutWidth(layout?.width);
	                          const h = layout?.height;
	                          applyTranscriptLayoutObservation({
	                              contentHeight: listContentHeightRef.current,
	                              layoutHeight: typeof h === 'number' ? h : Number.NaN,
	                              layoutHeightChanged: listLayoutHeightRef.current !== h,
	                              platformOS: Platform.OS,
	                              shouldRestoreNativeEntry: sessionEntryViewportRef.current?.shouldFollowBottom === false,
	                          }, layoutObservationApplierEffects);
	                      }}
	                          onContentSizeChange={(_: number, h: number) => {
	                                  const contentSizeObservation = measurementHost.observeContentSizeChange({
	                                      composerInsetHeight: composerInsetHeightRef.current,
	                                      latestCommittedActivityKey: props.latestCommittedActivityKey,
                                      platform: Platform.OS === 'web' ? 'web' : 'native',
                                      previousMeasuredContentHeight: listContentHeightRef.current,
                                      rawContentHeight: h,
	                                      sessionActive: props.sessionActive,
	                                      sessionId: props.sessionId,
	                                  });
	                                  applyTranscriptContentSizeObservation({
	                                      layoutHeight: listLayoutHeightRef.current,
	                                      observation: contentSizeObservation,
	                                      platformOS: Platform.OS,
	                                      shouldRestoreNativeEntry: sessionEntryViewportRef.current?.shouldFollowBottom === false,
	                                  }, contentSizeObservationApplierEffects);
	                      }}
                        onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
                            observeTranscriptScrollIngress({
                                bottomFollowModeState: bottomFollowModeStateRef.current,
                                configuredBottomDistanceNoiseFloorPx:
                                    resolveTranscriptMountSettleTuning().bottomDistanceNoiseFloorPx,
                                eventNativeEvent: e?.nativeEvent,
                                hasNativeContentMeasurement: hasNativeContentMeasurementForCurrentSession(),
                                hasNativeInitialViewportApplied: hasNativeInitialViewportAppliedForCurrentSession(),
                                hasRenderedItems: listDataRef.current.length > 0,
                                isLoaded: props.isLoaded,
                                isWarmKeepAliveInstance,
                                lastNativePinOffset: lastNativePinOffsetRef.current,
                                lastScrollOffsetForIntent: lastScrollOffsetForIntentRef.current,
                                lastUserScrollIntentAtMs: lastUserScrollIntentAtMsRef.current,
                                loadOlderInFlight: loadOlderInFlight.current,
                                measuredContentHeight: listContentHeightRef.current,
                                measuredLayoutHeight: listLayoutHeightRef.current,
                                nativeListDragActive: nativeListDragActiveRef.current,
                                nativeMomentumScrollActive: nativeMomentumScrollActiveRef.current,
                                nativeMountSettleDeadlineReached:
                                    nativeMountSettleDeadlineReachedRef.current,
                                nativeMountSettleStable,
                                nowMs: Date.now(),
                                pendingBottomPin: pendingNativeMountSettleBottomPinRef.current,
                                pinEnabled,
                                pinThresholdPx,
                                platform: transcriptScrollIngressPlatform,
                                sessionEntry: {
                                    sessionId: sessionEntryViewportRef.current?.sessionId ?? null,
                                    shouldFollowBottom:
                                        sessionEntryViewportRef.current?.shouldFollowBottom,
                                },
                                sessionId: props.sessionId,
                                userIntentRecentMs: TRANSCRIPT_SCROLL_USER_INTENT_RECENT_MS,
                                usesNativeFlashListBottomMaintenance,
                                wantsPinned: wantsPinnedRef.current,
                            }, transcriptScrollIngressCallbacks);
                        }}
                            onScrollBeginDrag={() => {
                                recordNativeListDragEscapeIntent();
                            }}
                            onScrollEndDrag={recordNativeListDragEndIntent}
                            onMomentumScrollBegin={recordNativeMomentumScrollBeginIntent}
                            onMomentumScrollEnd={recordNativeMomentumScrollEndSettle}
                            renderItem={renderItem}
                            onStartReachedThreshold={flashListStartReachedThreshold}
                            onStartReached={() => {
                                observePaginationEdgeReachedNudge(resolveViewportReachedEdge('start'));
                            }}
                            onEndReachedThreshold={flashListStartReachedThreshold}
                            onEndReached={() => {
                                observePaginationEdgeReachedNudge(resolveViewportReachedEdge('end'));
                            }}
                            onScrollToIndexFailed={(info: { index: number; averageItemLength: number }) => {
                                      if (handleNativeRestoreIndexFailure(info.index)) return;
                                      if (props.jumpToSeq == null) return;
	                                      executeViewportCommand(resolveViewportCommand({
	                                      type: 'recover-jump-to-seq',
	                                      sessionId: props.sessionId,
	                                  failedRenderedIndex: info.index,
	                                  averageItemLengthPx: info.averageItemLength,
	                                  animated: true,
	                              }));
	                          }}
                      header={mainTranscriptListShellEdgeSlots.listHeaderNode}
                      footer={mainTranscriptListShellEdgeSlots.listFooterNode}
                      olderLoadOverlay={mainTranscriptListOlderLoadOverlay}
                      catchUpOverlay={mainTranscriptListCatchUpOverlay}
                  />
              <TranscriptNavigationRail
                  currentAnchorId={transcriptNavigationRailVisibilitySnapshot.currentAnchorId}
                  entries={props.transcriptNavigationEntries}
                  onJumpToEntry={handleTranscriptNavigationRailJump}
                  paneHeightPx={listLayoutHeight}
                  paneWidthPx={listLayoutWidthPx}
                  transcriptContentWidthPx={Math.min(listLayoutWidthPx, transcriptContentMaxWidth)}
                  transcriptMaxWidthPx={transcriptContentMaxWidth}
                  visibleAnchorIds={transcriptNavigationRailVisibilitySnapshot.visibleAnchorIds}
              />
              {showFirstPaintPlaceholder ? (
                  <TranscriptFirstPaintPlaceholder reducedMotion={reducedMotionPreferred} />
              ) : null}
              {jumpToBottomAffordance.isVisible ? (
                  <ComposerKeyboardFloatingInset
                      testID="transcript-jump-to-bottom-keyboard-offset"
                      baseBottom={12}
                      style={{ position: 'absolute', right: 12 }}
                  >
                      <JumpToBottomButton
                          testID="transcript-jump-to-bottom"
                          count={jumpToBottomAffordance.count}
                          onPress={jumpToBottom}
                          presentation={jumpToBottomAffordance.presentation}
                    />
                </ComposerKeyboardFloatingInset>
            ) : null}
            </View>
        </TranscriptMotionProvider>
    )
});
