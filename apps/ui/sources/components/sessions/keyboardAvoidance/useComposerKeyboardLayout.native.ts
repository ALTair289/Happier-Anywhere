import * as React from 'react';
import { Keyboard, Platform, useWindowDimensions } from 'react-native';
import { useKeyboardHandler, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { runOnJS, useDerivedValue, useSharedValue } from 'react-native-reanimated';

import {
    resolveAvailablePanelHeight,
    resolveComposerBottomOffset,
    resolveListBottomInset,
} from './composerKeyboardGeometry';
import type { ComposerKeyboardLayout } from './ComposerKeyboardContext';

export type ComposerKeyboardLayoutOptions = Readonly<{
    availablePanelMaxHeight?: number;
    headerHeight?: number;
    keyboardLiftSuppressed?: boolean;
    layoutBottomInset?: number;
    safeAreaBottom?: number;
}>;

type KeyboardFinalFrameCoordinates = Readonly<{
    height?: number;
    screenY?: number;
}>;

// Complete input set for a static layout recompute. Guest-runtime (JS-thread) shared-value
// writes are async in Reanimated 4, so a caller that writes a value and then recomputes in the
// same pass must hand the recompute its freshly computed local — reading the shared value back
// would observe the PREVIOUS value. Passing the whole set (rather than a partial override bag)
// keeps that obligation explicit at every call site.
type ComposerStaticLayoutInputs = Readonly<{
    availablePanelMaxHeight: number | undefined;
    composerHeight: number;
    headerHeight: number;
    isInteractiveDismissActive: boolean;
    isKeyboardLiftSuppressed: boolean;
    keyboardHeightAbsolute: number;
    keyboardHeightForInset: number;
    layoutBottomInset: number;
    safeAreaBottom: number;
    scaffoldHeight: number;
    viewportHeight: number;
}>;

function resolveAndroidFinalFrameKeyboardHeight(
    coordinates: KeyboardFinalFrameCoordinates | undefined,
    viewportHeight: number,
): number {
    const reportedHeight = typeof coordinates?.height === 'number' && Number.isFinite(coordinates.height)
        ? Math.max(0, coordinates.height)
        : 0;
    const heightFromScreenY =
        typeof coordinates?.screenY === 'number'
        && Number.isFinite(coordinates.screenY)
        && Number.isFinite(viewportHeight)
            ? Math.max(0, viewportHeight - coordinates.screenY)
            : 0;

    return Math.max(reportedHeight, heightFromScreenY);
}

function resolveKeyboardHeightWithinScaffold(keyboardHeight: number, layoutBottomInset: number): number {
    'worklet';
    return Math.max(0, keyboardHeight - Math.max(0, layoutBottomInset));
}

function clampAvailablePanelHeightToMax(height: number, maxHeight: number | undefined): number {
    'worklet';
    if (typeof maxHeight !== 'number' || !Number.isFinite(maxHeight) || maxHeight <= 0) {
        return height;
    }
    return Math.min(height, maxHeight);
}

function resolveMeasuredViewportHeight(scaffoldHeight: number, fallbackViewportHeight: number): number {
    'worklet';
    return scaffoldHeight > 0 ? scaffoldHeight : fallbackViewportHeight;
}

function resolveMeasuredHeaderHeight(scaffoldHeight: number, fallbackHeaderHeight: number): number {
    'worklet';
    return scaffoldHeight > 0 ? 0 : fallbackHeaderHeight;
}

export function useComposerKeyboardLayout(options: ComposerKeyboardLayoutOptions = {}): ComposerKeyboardLayout {
    const dimensions = useWindowDimensions();
    const safeAreaBottom = options.safeAreaBottom ?? 0;
    const headerHeight = options.headerHeight ?? 0;
    const layoutBottomInset = typeof options.layoutBottomInset === 'number' && Number.isFinite(options.layoutBottomInset)
        ? Math.max(0, options.layoutBottomInset)
        : 0;
    const availablePanelMaxHeight = typeof options.availablePanelMaxHeight === 'number' && Number.isFinite(options.availablePanelMaxHeight)
        ? Math.max(0, options.availablePanelMaxHeight)
        : undefined;
    const keyboardLiftSuppressed = options.keyboardLiftSuppressed === true;

    const keyboardAnimation = useReanimatedKeyboardAnimation();
    const availablePanelHeight = useSharedValue(resolveAvailablePanelHeight({
        viewportHeight: dimensions.height,
        headerHeight,
        keyboardHeight: 0,
        maxHeight: availablePanelMaxHeight,
        reservedHeight: layoutBottomInset,
        safeAreaBottom,
    }));
    const bottomInset = useSharedValue(resolveComposerBottomOffset({ keyboardHeight: 0, safeAreaBottom }));
    const composerHeight = useSharedValue(0);
    const isInteractiveDismissActive = useSharedValue(false);
    const isKeyboardLiftSuppressed = useSharedValue(keyboardLiftSuppressed);
    const isKeyboardLiftRetained = useSharedValue(false);
    const ignoreKeyboardFramesUntilComposerFocus = useSharedValue(false);
    const keyboardHeightForInset = useSharedValue(0);
    const keyboardHeightAbsolute = useSharedValue(0);
    const keyboardHeightLive = useSharedValue(0);
    const keyboardProgress = useSharedValue(0);
    const lastKeyboardEventHeightAbsolute = useSharedValue(0);
    const listBottomInset = useSharedValue(resolveListBottomInset({
        composerHeight: 0,
        keyboardHeightForInset: 0,
        safeAreaBottom,
    }));
    const safeAreaBottomValue = useSharedValue(safeAreaBottom);
    const layoutBottomInsetValue = useSharedValue(layoutBottomInset);
    const availablePanelMaxHeightValue = useSharedValue(availablePanelMaxHeight);
    const headerHeightValue = useSharedValue(headerHeight);
    const scaffoldMeasuredHeight = useSharedValue(0);
    const viewportHeight = useSharedValue(dimensions.height);
    const availablePanelHeightSubscribersRef = React.useRef(new Set<(height: number) => void>());
    const keyboardHeightSnapshotRef = React.useRef(0);
    const keyboardHeightSubscribersRef = React.useRef(new Set<(height: number) => void>());
    const listBottomInsetSubscribersRef = React.useRef(new Set<(height: number) => void>());
    const keyboardRetentionCountRef = React.useRef(0);

    // JS mirror of the last notified panel height: subscribe replay must not read the shared
    // value (guest-runtime writes are async, so `.value` can lag the last computed height).
    const availablePanelHeightSnapshotRef = React.useRef<number | null>(null);
    const notifyAvailablePanelHeight = React.useCallback((height: number) => {
        availablePanelHeightSnapshotRef.current = height;
        for (const listener of availablePanelHeightSubscribersRef.current) {
            listener(height);
        }
    }, []);

    const subscribeAvailablePanelHeight = React.useCallback((listener: (height: number) => void) => {
        availablePanelHeightSubscribersRef.current.add(listener);
        listener(availablePanelHeightSnapshotRef.current ?? availablePanelHeight.value);
        return () => {
            availablePanelHeightSubscribersRef.current.delete(listener);
        };
    }, [availablePanelHeight]);

    const notifyKeyboardHeight = React.useCallback((height: number) => {
        const nextHeight = typeof height === 'number' && Number.isFinite(height) ? Math.max(0, Math.trunc(height)) : 0;
        if (keyboardHeightSnapshotRef.current === nextHeight) return;
        keyboardHeightSnapshotRef.current = nextHeight;
        for (const listener of keyboardHeightSubscribersRef.current) {
            listener(nextHeight);
        }
    }, []);

    const getKeyboardHeight = React.useCallback(() => keyboardHeightSnapshotRef.current, []);

    const subscribeKeyboardHeight = React.useCallback((listener: (height: number) => void) => {
        keyboardHeightSubscribersRef.current.add(listener);
        listener(keyboardHeightSnapshotRef.current);
        return () => {
            keyboardHeightSubscribersRef.current.delete(listener);
        };
    }, []);

    // JS mirror of the last notified inset: subscribe replay must not read the shared value
    // (guest-runtime writes are async, so `.value` can lag the last computed inset).
    const listBottomInsetSnapshotRef = React.useRef<number | null>(null);
    const notifyListBottomInset = React.useCallback((height: number) => {
        listBottomInsetSnapshotRef.current = height;
        for (const listener of listBottomInsetSubscribersRef.current) {
            listener(height);
        }
    }, []);

    const subscribeListBottomInset = React.useCallback((listener: (height: number) => void) => {
        listBottomInsetSubscribersRef.current.add(listener);
        listener(listBottomInsetSnapshotRef.current ?? listBottomInset.value);
        return () => {
            listBottomInsetSubscribersRef.current.delete(listener);
        };
    }, [listBottomInset]);

    // Snapshot of the last synchronized shared-value state. A caller that writes a value in the
    // current pass must override the matching field with its own local before recomputing.
    const readStaticLayoutInputs = React.useCallback((): ComposerStaticLayoutInputs => ({
        availablePanelMaxHeight: availablePanelMaxHeightValue.value,
        composerHeight: composerHeight.value,
        headerHeight: headerHeightValue.value,
        isInteractiveDismissActive: isInteractiveDismissActive.value,
        isKeyboardLiftSuppressed: isKeyboardLiftSuppressed.value,
        keyboardHeightAbsolute: keyboardHeightAbsolute.value,
        keyboardHeightForInset: keyboardHeightForInset.value,
        layoutBottomInset: layoutBottomInsetValue.value,
        safeAreaBottom: safeAreaBottomValue.value,
        scaffoldHeight: scaffoldMeasuredHeight.value,
        viewportHeight: viewportHeight.value,
    }), [
        availablePanelMaxHeightValue,
        composerHeight,
        headerHeightValue,
        isInteractiveDismissActive,
        isKeyboardLiftSuppressed,
        keyboardHeightAbsolute,
        keyboardHeightForInset,
        layoutBottomInsetValue,
        safeAreaBottomValue,
        scaffoldMeasuredHeight,
        viewportHeight,
    ]);

    const recomputeStaticLayout = React.useCallback((inputs: ComposerStaticLayoutInputs) => {
        // Guest-runtime (JS-thread) shared-value writes are async in Reanimated 4: a read
        // immediately after a write observes the PREVIOUS value. Every value that is written
        // and then consumed within this pass must therefore flow through a local, and every
        // subscriber notification must carry the freshly computed local — never a `.value`
        // read-back. (Live-diagnosed 2026-07-09: read-back notifies left the transcript
        // composer inset one growth step behind, rendering rows under the composer.) This
        // recompute therefore reads nothing back: every input arrives from its writer.
        const effectiveComposerHeight = Math.max(0, Math.round(inputs.composerHeight));
        const effectiveScaffoldHeight = Math.max(0, Math.round(inputs.scaffoldHeight));
        const effectiveViewportHeight = resolveMeasuredViewportHeight(effectiveScaffoldHeight, inputs.viewportHeight);
        const effectiveHeaderHeight = resolveMeasuredHeaderHeight(effectiveScaffoldHeight, inputs.headerHeight);
        const liveKeyboardHeight = inputs.isKeyboardLiftSuppressed
            ? 0
            : resolveKeyboardHeightWithinScaffold(inputs.keyboardHeightAbsolute, inputs.layoutBottomInset);
        keyboardHeightLive.value = liveKeyboardHeight;
        const shouldRefreshInsetKeyboardHeight = inputs.isKeyboardLiftSuppressed || !inputs.isInteractiveDismissActive;
        if (shouldRefreshInsetKeyboardHeight) {
            keyboardHeightForInset.value = liveKeyboardHeight;
        }
        notifyKeyboardHeight(liveKeyboardHeight);
        const insetKeyboardHeight = inputs.isKeyboardLiftSuppressed
            ? 0
            : (shouldRefreshInsetKeyboardHeight ? liveKeyboardHeight : inputs.keyboardHeightForInset);
        bottomInset.value = resolveComposerBottomOffset({
            keyboardHeight: liveKeyboardHeight,
            safeAreaBottom: inputs.safeAreaBottom,
        });
        const nextListBottomInset = resolveListBottomInset({
            composerHeight: effectiveComposerHeight,
            keyboardHeightForInset: insetKeyboardHeight,
            safeAreaBottom: inputs.safeAreaBottom,
        });
        listBottomInset.value = nextListBottomInset;
        notifyListBottomInset(nextListBottomInset);
        const absoluteKeyboardHeight = inputs.isKeyboardLiftSuppressed ? 0 : inputs.keyboardHeightAbsolute;
        const nextAvailablePanelHeight = resolveAvailablePanelHeight({
            viewportHeight: effectiveViewportHeight,
            headerHeight: effectiveHeaderHeight,
            keyboardHeight: absoluteKeyboardHeight,
            maxHeight: inputs.availablePanelMaxHeight,
            reservedHeight: absoluteKeyboardHeight > 0 ? 0 : inputs.layoutBottomInset,
            safeAreaBottom: inputs.safeAreaBottom,
        });
        availablePanelHeight.value = nextAvailablePanelHeight;
        notifyAvailablePanelHeight(nextAvailablePanelHeight);
    }, [
        availablePanelHeight,
        bottomInset,
        keyboardHeightForInset,
        keyboardHeightLive,
        listBottomInset,
        notifyKeyboardHeight,
        notifyListBottomInset,
        notifyAvailablePanelHeight,
    ]);

    const applyFinalKeyboardHeightFromJS = React.useCallback((height: number) => {
        // See recomputeStaticLayout: consume locals, never `.value` read-backs, and notify
        // subscribers with the freshly computed values (guest-runtime writes are async).
        const absoluteKeyboardHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
        isInteractiveDismissActive.value = false;
        lastKeyboardEventHeightAbsolute.value = absoluteKeyboardHeight;
        const effectiveAbsoluteKeyboardHeight = isKeyboardLiftSuppressed.value ? 0 : absoluteKeyboardHeight;
        keyboardHeightAbsolute.value = effectiveAbsoluteKeyboardHeight;
        const liveKeyboardHeight = isKeyboardLiftSuppressed.value
            ? 0
            : resolveKeyboardHeightWithinScaffold(effectiveAbsoluteKeyboardHeight, layoutBottomInsetValue.value);
        keyboardHeightLive.value = liveKeyboardHeight;
        keyboardHeightForInset.value = liveKeyboardHeight;
        notifyKeyboardHeight(liveKeyboardHeight);
        keyboardProgress.value = liveKeyboardHeight > 0 ? 1 : 0;
        bottomInset.value = resolveComposerBottomOffset({
            keyboardHeight: liveKeyboardHeight,
            safeAreaBottom: safeAreaBottomValue.value,
        });
        const effectiveViewportHeight = resolveMeasuredViewportHeight(scaffoldMeasuredHeight.value, viewportHeight.value);
        const effectiveHeaderHeight = resolveMeasuredHeaderHeight(scaffoldMeasuredHeight.value, headerHeightValue.value);
        const nextListBottomInset = resolveListBottomInset({
            composerHeight: composerHeight.value,
            keyboardHeightForInset: isKeyboardLiftSuppressed.value ? 0 : liveKeyboardHeight,
            safeAreaBottom: safeAreaBottomValue.value,
        });
        listBottomInset.value = nextListBottomInset;
        notifyListBottomInset(nextListBottomInset);
        const nextAvailablePanelHeight = resolveAvailablePanelHeight({
            viewportHeight: effectiveViewportHeight,
            headerHeight: effectiveHeaderHeight,
            keyboardHeight: isKeyboardLiftSuppressed.value ? 0 : absoluteKeyboardHeight,
            maxHeight: availablePanelMaxHeightValue.value,
            reservedHeight: absoluteKeyboardHeight > 0 ? 0 : layoutBottomInsetValue.value,
            safeAreaBottom: safeAreaBottomValue.value,
        });
        availablePanelHeight.value = nextAvailablePanelHeight;
        notifyAvailablePanelHeight(nextAvailablePanelHeight);
    }, [
        availablePanelHeight,
        availablePanelMaxHeightValue,
        bottomInset,
        composerHeight,
        headerHeightValue,
        isInteractiveDismissActive,
        isKeyboardLiftSuppressed,
        keyboardHeightAbsolute,
        keyboardHeightForInset,
        keyboardHeightLive,
        keyboardProgress,
        lastKeyboardEventHeightAbsolute,
        layoutBottomInsetValue,
        listBottomInset,
        notifyAvailablePanelHeight,
        notifyListBottomInset,
        notifyKeyboardHeight,
        safeAreaBottomValue,
        scaffoldMeasuredHeight,
        viewportHeight,
    ]);

    React.useEffect(() => {
        if (Platform.OS === 'android') return undefined;

        const hideSubscription = Keyboard.addListener('keyboardDidHide', () => {
            if (keyboardRetentionCountRef.current > 0) return;
            ignoreKeyboardFramesUntilComposerFocus.value = true;
            applyFinalKeyboardHeightFromJS(0);
        });

        return () => {
            hideSubscription.remove();
        };
    }, [applyFinalKeyboardHeightFromJS, ignoreKeyboardFramesUntilComposerFocus]);

    React.useEffect(() => {
        if (Platform.OS !== 'android') return undefined;

        const showSubscription = Keyboard.addListener('keyboardDidShow', (event) => {
            applyFinalKeyboardHeightFromJS(resolveAndroidFinalFrameKeyboardHeight(
                event.endCoordinates,
                dimensions.height,
            ));
        });
        const hideSubscription = Keyboard.addListener('keyboardDidHide', () => {
            applyFinalKeyboardHeightFromJS(0);
        });

        return () => {
            showSubscription.remove();
            hideSubscription.remove();
        };
    }, [applyFinalKeyboardHeightFromJS, dimensions.height]);

    React.useEffect(() => {
        // Every value written below is consumed by the recompute in this same pass, so the
        // recompute receives the freshly computed locals; reading them back would replay the
        // previous safe area / header / viewport / suppression state and leave the transcript
        // inset one growth step behind.
        const previousInputs = readStaticLayoutInputs();
        safeAreaBottomValue.value = safeAreaBottom;
        layoutBottomInsetValue.value = layoutBottomInset;
        availablePanelMaxHeightValue.value = availablePanelMaxHeight;
        headerHeightValue.value = headerHeight;
        viewportHeight.value = dimensions.height;
        isKeyboardLiftSuppressed.value = keyboardLiftSuppressed;
        if (keyboardLiftSuppressed) {
            isInteractiveDismissActive.value = false;
            keyboardHeightAbsolute.value = 0;
            keyboardHeightLive.value = 0;
            keyboardHeightForInset.value = 0;
            keyboardProgress.value = 0;
        }
        recomputeStaticLayout({
            ...previousInputs,
            availablePanelMaxHeight,
            headerHeight,
            isInteractiveDismissActive: keyboardLiftSuppressed ? false : previousInputs.isInteractiveDismissActive,
            isKeyboardLiftSuppressed: keyboardLiftSuppressed,
            keyboardHeightAbsolute: keyboardLiftSuppressed ? 0 : previousInputs.keyboardHeightAbsolute,
            keyboardHeightForInset: keyboardLiftSuppressed ? 0 : previousInputs.keyboardHeightForInset,
            layoutBottomInset,
            safeAreaBottom,
            viewportHeight: dimensions.height,
        });
    }, [
        dimensions.height,
        availablePanelMaxHeight,
        availablePanelMaxHeightValue,
        availablePanelHeight,
        bottomInset,
        headerHeight,
        headerHeightValue,
        isInteractiveDismissActive,
        isKeyboardLiftSuppressed,
        keyboardHeightAbsolute,
        keyboardHeightForInset,
        keyboardHeightLive,
        keyboardLiftSuppressed,
        keyboardProgress,
        listBottomInset,
        readStaticLayoutInputs,
        recomputeStaticLayout,
        layoutBottomInset,
        layoutBottomInsetValue,
        safeAreaBottom,
        safeAreaBottomValue,
        viewportHeight,
    ]);

    const shouldRetainAndroidZeroProgressStartFrame = Platform.OS === 'android';

    useKeyboardHandler({
        onStart: (event) => {
            'worklet';
            if (ignoreKeyboardFramesUntilComposerFocus.value) return;
            isInteractiveDismissActive.value = false;
            const nextHeight = Math.max(0, Math.abs(event.height));
            const nextProgress = typeof event.progress === 'number' && Number.isFinite(event.progress)
                ? Math.max(0, event.progress)
                : 0;
            const shouldRetainOpenKeyboardStartFrame = shouldRetainAndroidZeroProgressStartFrame
                && !isKeyboardLiftSuppressed.value
                && nextHeight === 0
                && nextProgress <= 0
                && keyboardHeightAbsolute.value > 0;
            lastKeyboardEventHeightAbsolute.value = nextHeight;
            const retainedHeight = !isKeyboardLiftSuppressed.value
                && (isKeyboardLiftRetained.value || shouldRetainOpenKeyboardStartFrame)
                && nextHeight === 0
                ? keyboardHeightAbsolute.value
                : nextHeight;
            keyboardHeightAbsolute.value = isKeyboardLiftSuppressed.value ? 0 : retainedHeight;
            const storedHeight = isKeyboardLiftSuppressed.value
                ? 0
                : resolveKeyboardHeightWithinScaffold(retainedHeight, layoutBottomInsetValue.value);
            keyboardHeightLive.value = storedHeight;
            keyboardHeightForInset.value = storedHeight;
            runOnJS(notifyKeyboardHeight)(storedHeight);
            keyboardProgress.value = isKeyboardLiftSuppressed.value ? 0 : nextProgress;
            const effectiveLiveHeight = storedHeight;
            const startFrameLiveHeight = nextProgress <= 0 && !shouldRetainOpenKeyboardStartFrame
                ? 0
                : effectiveLiveHeight;
            bottomInset.value = Math.max(safeAreaBottomValue.value, startFrameLiveHeight);
            const nextListBottomInset = composerHeight.value + Math.max(safeAreaBottomValue.value, effectiveLiveHeight);
            listBottomInset.value = nextListBottomInset;
            runOnJS(notifyListBottomInset)(nextListBottomInset);
            const effectiveViewportHeight = resolveMeasuredViewportHeight(scaffoldMeasuredHeight.value, viewportHeight.value);
            const effectiveHeaderHeight = resolveMeasuredHeaderHeight(scaffoldMeasuredHeight.value, headerHeightValue.value);
            const nextAvailablePanelHeight = clampAvailablePanelHeightToMax(Math.max(
                0,
                effectiveViewportHeight
                    - effectiveHeaderHeight
                    - Math.max(safeAreaBottomValue.value, keyboardHeightAbsolute.value)
                    - (keyboardHeightAbsolute.value > 0 ? 0 : layoutBottomInsetValue.value),
            ), availablePanelMaxHeightValue.value);
            availablePanelHeight.value = nextAvailablePanelHeight;
            runOnJS(notifyAvailablePanelHeight)(nextAvailablePanelHeight);
        },
        onMove: (event) => {
            'worklet';
            if (ignoreKeyboardFramesUntilComposerFocus.value) return;
            const eventHeight = Math.max(0, Math.abs(event.height));
            const eventProgress = typeof event.progress === 'number' && Number.isFinite(event.progress)
                ? Math.max(0, event.progress)
                : 0;
            const reanimatedHeight = Math.max(0, Math.abs(keyboardAnimation.height.value));
            const keyboardLiftIsSuppressed = isKeyboardLiftSuppressed.value;
            if (keyboardLiftIsSuppressed) {
                isInteractiveDismissActive.value = false;
            }
            const eventReportsClosedFrame = eventHeight === 0 && eventProgress <= 0;
            const rawAbsoluteLiveHeight = eventReportsClosedFrame
                ? 0
                : Math.max(eventHeight, reanimatedHeight);
            lastKeyboardEventHeightAbsolute.value = rawAbsoluteLiveHeight;
            const absoluteLiveHeight = !keyboardLiftIsSuppressed
                && isKeyboardLiftRetained.value
                && rawAbsoluteLiveHeight === 0
                ? keyboardHeightAbsolute.value
                : rawAbsoluteLiveHeight;
            keyboardHeightAbsolute.value = keyboardLiftIsSuppressed ? 0 : absoluteLiveHeight;
            const liveHeight = keyboardLiftIsSuppressed
                ? 0
                : resolveKeyboardHeightWithinScaffold(absoluteLiveHeight, layoutBottomInsetValue.value);
            const insetHeight = isInteractiveDismissActive.value ? keyboardHeightForInset.value : liveHeight;
            const effectiveLiveHeight = liveHeight;
            const effectiveInsetHeight = keyboardLiftIsSuppressed ? 0 : insetHeight;
            keyboardHeightLive.value = liveHeight;
            if (keyboardLiftIsSuppressed || !isInteractiveDismissActive.value) {
                keyboardHeightForInset.value = insetHeight;
            }
            runOnJS(notifyKeyboardHeight)(liveHeight);
            keyboardProgress.value = keyboardLiftIsSuppressed ? 0 : eventProgress;
            bottomInset.value = Math.max(safeAreaBottomValue.value, effectiveLiveHeight);
            const nextListBottomInset = composerHeight.value + Math.max(safeAreaBottomValue.value, effectiveInsetHeight);
            listBottomInset.value = nextListBottomInset;
            runOnJS(notifyListBottomInset)(nextListBottomInset);
            const effectiveViewportHeight = resolveMeasuredViewportHeight(scaffoldMeasuredHeight.value, viewportHeight.value);
            const effectiveHeaderHeight = resolveMeasuredHeaderHeight(scaffoldMeasuredHeight.value, headerHeightValue.value);
            const nextAvailablePanelHeight = clampAvailablePanelHeightToMax(Math.max(
                0,
                effectiveViewportHeight
                    - effectiveHeaderHeight
                    - Math.max(safeAreaBottomValue.value, keyboardHeightAbsolute.value)
                    - (keyboardHeightAbsolute.value > 0 ? 0 : layoutBottomInsetValue.value),
            ), availablePanelMaxHeightValue.value);
            availablePanelHeight.value = nextAvailablePanelHeight;
            runOnJS(notifyAvailablePanelHeight)(nextAvailablePanelHeight);
        },
        onInteractive: (event) => {
            'worklet';
            if (ignoreKeyboardFramesUntilComposerFocus.value) return;
            const keyboardLiftIsSuppressed = isKeyboardLiftSuppressed.value;
            isInteractiveDismissActive.value = !keyboardLiftIsSuppressed;
            const eventHeight = Math.max(0, Math.abs(event.height));
            lastKeyboardEventHeightAbsolute.value = eventHeight;
            const liveHeight = !keyboardLiftIsSuppressed
                && isKeyboardLiftRetained.value
                && eventHeight === 0
                ? keyboardHeightAbsolute.value
                : eventHeight;
            keyboardHeightAbsolute.value = keyboardLiftIsSuppressed ? 0 : liveHeight;
            const effectiveLiveHeight = keyboardLiftIsSuppressed
                ? 0
                : resolveKeyboardHeightWithinScaffold(liveHeight, layoutBottomInsetValue.value);
            keyboardHeightLive.value = effectiveLiveHeight;
            if (keyboardLiftIsSuppressed) {
                keyboardHeightForInset.value = 0;
            }
            runOnJS(notifyKeyboardHeight)(effectiveLiveHeight);
            keyboardProgress.value = keyboardLiftIsSuppressed ? 0 : event.progress;
            bottomInset.value = Math.max(safeAreaBottomValue.value, effectiveLiveHeight);
            const nextListBottomInset = composerHeight.value + Math.max(
                safeAreaBottomValue.value,
                keyboardLiftIsSuppressed ? 0 : keyboardHeightForInset.value,
            );
            listBottomInset.value = nextListBottomInset;
            runOnJS(notifyListBottomInset)(nextListBottomInset);
            const effectiveViewportHeight = resolveMeasuredViewportHeight(scaffoldMeasuredHeight.value, viewportHeight.value);
            const effectiveHeaderHeight = resolveMeasuredHeaderHeight(scaffoldMeasuredHeight.value, headerHeightValue.value);
            const nextAvailablePanelHeight = clampAvailablePanelHeightToMax(Math.max(
                0,
                effectiveViewportHeight
                    - effectiveHeaderHeight
                    - Math.max(safeAreaBottomValue.value, keyboardHeightAbsolute.value)
                    - (keyboardHeightAbsolute.value > 0 ? 0 : layoutBottomInsetValue.value),
            ), availablePanelMaxHeightValue.value);
            availablePanelHeight.value = nextAvailablePanelHeight;
            runOnJS(notifyAvailablePanelHeight)(nextAvailablePanelHeight);
        },
        onEnd: (event) => {
            'worklet';
            if (ignoreKeyboardFramesUntilComposerFocus.value) return;
            isInteractiveDismissActive.value = false;
            const nextHeight = Math.max(0, Math.abs(event.height));
            lastKeyboardEventHeightAbsolute.value = nextHeight;
            const retainedHeight = !isKeyboardLiftSuppressed.value
                && isKeyboardLiftRetained.value
                && nextHeight === 0
                ? keyboardHeightAbsolute.value
                : nextHeight;
            keyboardHeightAbsolute.value = isKeyboardLiftSuppressed.value ? 0 : retainedHeight;
            const effectiveHeight = isKeyboardLiftSuppressed.value
                ? 0
                : resolveKeyboardHeightWithinScaffold(retainedHeight, layoutBottomInsetValue.value);
            keyboardHeightLive.value = effectiveHeight;
            keyboardHeightForInset.value = effectiveHeight;
            runOnJS(notifyKeyboardHeight)(effectiveHeight);
            keyboardProgress.value = isKeyboardLiftSuppressed.value ? 0 : event.progress;
            bottomInset.value = Math.max(safeAreaBottomValue.value, effectiveHeight);
            const nextListBottomInset = composerHeight.value + Math.max(safeAreaBottomValue.value, effectiveHeight);
            listBottomInset.value = nextListBottomInset;
            runOnJS(notifyListBottomInset)(nextListBottomInset);
            const effectiveViewportHeight = resolveMeasuredViewportHeight(scaffoldMeasuredHeight.value, viewportHeight.value);
            const effectiveHeaderHeight = resolveMeasuredHeaderHeight(scaffoldMeasuredHeight.value, headerHeightValue.value);
            const nextAvailablePanelHeight = clampAvailablePanelHeightToMax(Math.max(
                0,
                effectiveViewportHeight
                    - effectiveHeaderHeight
                    - Math.max(safeAreaBottomValue.value, keyboardHeightAbsolute.value)
                    - (keyboardHeightAbsolute.value > 0 ? 0 : layoutBottomInsetValue.value),
            ), availablePanelMaxHeightValue.value);
            availablePanelHeight.value = nextAvailablePanelHeight;
            runOnJS(notifyAvailablePanelHeight)(nextAvailablePanelHeight);
        },
    }, [
        ignoreKeyboardFramesUntilComposerFocus,
        keyboardAnimation.height,
        notifyAvailablePanelHeight,
        notifyKeyboardHeight,
        notifyListBottomInset,
        scaffoldMeasuredHeight,
        shouldRetainAndroidZeroProgressStartFrame,
    ]);

    // `listBottomInset` above is the SETTLED total. Every keyboard transition opens with
    // `onStart`, which reports the target frame, so that total reaches its end value before the
    // keyboard has moved a pixel — and it then travels to the renderer as React state on the JS
    // thread. Measured 2026-08-01 across 11 real sends
    // (`.project/reviews/2026-08-01-send-transition/traces/S7.csv` t=25605, `S11.csv` t=22917):
    // the transcript's bottom spacer collapsed 258 px in a single frame while the keyboard was
    // still animating away, and every visible row translated with it, because the JS thread was
    // stalled 0.7-3.6 s across the send.
    //
    // This derived value is the same quantity recomputed on the UI thread from the keyboard's
    // own animation, so the rendered spacer tracks the keyboard frame by frame no matter what
    // the JS thread is doing. It applies the same guards as `onMove` — suppression, the
    // post-hide latch, retained lift and the interactive-dismiss freeze — because it reads the
    // raw animation value, which honours none of them on its own.
    const listBottomInsetAnimated = useDerivedValue(() => {
        const liftIsSuppressed = isKeyboardLiftSuppressed.value;
        const framesAreIgnored = ignoreKeyboardFramesUntilComposerFocus.value;
        const interactiveDismissIsActive = isInteractiveDismissActive.value;
        const liftIsRetained = isKeyboardLiftRetained.value;
        const settledInsetKeyboardHeight = keyboardHeightForInset.value;
        const retainedAbsoluteHeight = keyboardHeightAbsolute.value;
        const measuredComposerHeight = composerHeight.value;
        const safeArea = safeAreaBottomValue.value;
        const animatedAbsoluteHeight = Math.max(0, Math.abs(keyboardAnimation.height.value));
        const absoluteHeight = liftIsRetained && animatedAbsoluteHeight === 0
            ? retainedAbsoluteHeight
            : animatedAbsoluteHeight;
        const liveKeyboardHeight = resolveKeyboardHeightWithinScaffold(absoluteHeight, layoutBottomInsetValue.value);
        const insetKeyboardHeight = liftIsSuppressed
            ? 0
            : (framesAreIgnored || interactiveDismissIsActive ? settledInsetKeyboardHeight : liveKeyboardHeight);
        return resolveListBottomInset({
            composerHeight: measuredComposerHeight,
            keyboardHeightForInset: insetKeyboardHeight,
            safeAreaBottom: safeArea,
        });
    }, [keyboardAnimation.height]);

    const retainKeyboardLift = React.useCallback(() => {
        let released = false;
        keyboardRetentionCountRef.current += 1;
        isKeyboardLiftRetained.value = keyboardRetentionCountRef.current > 0;

        return () => {
            if (released) return;
            released = true;
            keyboardRetentionCountRef.current = Math.max(0, keyboardRetentionCountRef.current - 1);
            isKeyboardLiftRetained.value = keyboardRetentionCountRef.current > 0;
            const previousInputs = readStaticLayoutInputs();
            const shouldReleaseKeyboardLift = keyboardRetentionCountRef.current === 0
                && lastKeyboardEventHeightAbsolute.value === 0;
            if (shouldReleaseKeyboardLift) {
                isInteractiveDismissActive.value = false;
                keyboardHeightAbsolute.value = 0;
                keyboardHeightLive.value = 0;
                keyboardHeightForInset.value = 0;
                keyboardProgress.value = 0;
            }
            // The collapse written just above must reach the recompute as locals: a read-back
            // would replay the retained keyboard height for one more step.
            recomputeStaticLayout(shouldReleaseKeyboardLift
                ? {
                    ...previousInputs,
                    isInteractiveDismissActive: false,
                    keyboardHeightAbsolute: 0,
                    keyboardHeightForInset: 0,
                }
                : previousInputs);
        };
    }, [
        isInteractiveDismissActive,
        isKeyboardLiftRetained,
        keyboardHeightAbsolute,
        keyboardHeightForInset,
        keyboardHeightLive,
        keyboardProgress,
        lastKeyboardEventHeightAbsolute,
        readStaticLayoutInputs,
        recomputeStaticLayout,
    ]);

    const setComposerInputFocused = React.useCallback((focused: boolean) => {
        if (Platform.OS !== 'ios') return;
        if (focused) {
            ignoreKeyboardFramesUntilComposerFocus.value = false;
        }
    }, [ignoreKeyboardFramesUntilComposerFocus]);

    // Dedupe guards use plain JS mirrors: guest-runtime shared-value writes are async, so a
    // `.value` read-back cannot see a measurement committed earlier in the same frame.
    const lastMeasuredComposerHeightRef = React.useRef<number | null>(null);
    const setComposerMeasuredHeight = React.useCallback((height: number) => {
        const nextHeight = typeof height === 'number' && Number.isFinite(height) ? Math.max(0, Math.round(height)) : 0;
        if (lastMeasuredComposerHeightRef.current === nextHeight) return;
        lastMeasuredComposerHeightRef.current = nextHeight;
        composerHeight.value = nextHeight;
        recomputeStaticLayout({ ...readStaticLayoutInputs(), composerHeight: nextHeight });
    }, [composerHeight, readStaticLayoutInputs, recomputeStaticLayout]);

    const lastMeasuredScaffoldHeightRef = React.useRef<number | null>(null);
    const setScaffoldMeasuredHeight = React.useCallback((height: number) => {
        const nextHeight = typeof height === 'number' && Number.isFinite(height) ? Math.max(0, Math.round(height)) : 0;
        if (lastMeasuredScaffoldHeightRef.current === nextHeight) return;
        lastMeasuredScaffoldHeightRef.current = nextHeight;
        scaffoldMeasuredHeight.value = nextHeight;
        recomputeStaticLayout({ ...readStaticLayoutInputs(), scaffoldHeight: nextHeight });
    }, [readStaticLayoutInputs, recomputeStaticLayout, scaffoldMeasuredHeight]);

    return React.useMemo(() => ({
        availablePanelHeight,
        bottomInset,
        composerHeight,
        getKeyboardHeight,
        isKeyboardLiftSuppressed,
        keyboardHeightForInset,
        keyboardHeightLive,
        keyboardProgress,
        listBottomInset,
        listBottomInsetAnimated,
        retainKeyboardLift,
        setComposerInputFocused,
        setComposerMeasuredHeight,
        setScaffoldMeasuredHeight,
        subscribeAvailablePanelHeight,
        subscribeKeyboardHeight,
        subscribeListBottomInset,
    }), [
        availablePanelHeight,
        bottomInset,
        composerHeight,
        getKeyboardHeight,
        isKeyboardLiftSuppressed,
        keyboardHeightForInset,
        keyboardHeightLive,
        keyboardProgress,
        listBottomInset,
        listBottomInsetAnimated,
        retainKeyboardLift,
        setComposerInputFocused,
        setComposerMeasuredHeight,
        setScaffoldMeasuredHeight,
        subscribeAvailablePanelHeight,
        subscribeKeyboardHeight,
        subscribeListBottomInset,
    ]);
}
