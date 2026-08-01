import * as React from 'react';
import { Platform, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';

import { useComposerKeyboardLayout } from './ComposerKeyboardContext';
import type { ComposerKeyboardLayout } from './ComposerKeyboardContext';

function normalizeInsetHeight(height: number): number {
    'worklet';
    return typeof height === 'number' && Number.isFinite(height)
        ? Math.max(0, height)
        : 0;
}

function resolveNativeCurrentInsetHeight(layout: ComposerKeyboardLayout): number {
    return normalizeInsetHeight(
        layout.composerHeight.value
        + Math.max(layout.keyboardHeightForInset.value, layout.bottomInset.value),
    );
}

function resolveCurrentInsetHeight(layout: ComposerKeyboardLayout | null): number {
    if (!layout) return 0;
    if (Platform.OS === 'web') {
        return normalizeInsetHeight(layout.listBottomInset.value);
    }
    return resolveNativeCurrentInsetHeight(layout);
}

export function ComposerKeyboardScrollInset(props: Readonly<{
    onHeightChange?: (height: number) => void;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}>): React.ReactElement | null {
    const layout = useComposerKeyboardLayout();
    const lastReportedHeightRef = React.useRef<number | null>(null);
    const reportHeight = React.useCallback((nextHeight: number) => {
        const normalizedHeight = normalizeInsetHeight(nextHeight);
        if (lastReportedHeightRef.current !== normalizedHeight) {
            lastReportedHeightRef.current = normalizedHeight;
            props.onHeightChange?.(normalizedHeight);
        }
    }, [props.onHeightChange]);

    React.useEffect(() => {
        if (!layout) {
            reportHeight(0);
            return undefined;
        }
        const subscribeListBottomInset = layout.subscribeListBottomInset;
        if (!subscribeListBottomInset) {
            reportHeight(resolveCurrentInsetHeight(layout));
            return undefined;
        }
        // The notified payload is computed by the writer from its own fresh inputs and is
        // the canonical SETTLED inset on every platform. Re-deriving from shared-value reads at
        // delivery time is stale on native: guest-runtime writes are async, so `.value` lags the
        // payload by one step and the final composer-growth update is lost (live-diagnosed
        // 2026-07-09: transcript rows rendered under the composer).
        //
        // Subscribing FIRST is what keeps that rule true for every later effect run too: the
        // writer replays its last notified total synchronously, so the local derivation is
        // only ever a seed for a layout that has never notified one. Applying it before the
        // subscription republished a superseded inset on every re-subscribe — after a send
        // that is the pre-collapse composer height, and `onHeightChange` carries it to the
        // transcript viewport owner as a usable-geometry change that never happened.
        let replayedNotifiedInset = false;
        const unsubscribe = subscribeListBottomInset((nextHeight) => {
            replayedNotifiedInset = true;
            reportHeight(nextHeight);
        });
        if (!replayedNotifiedInset) {
            reportHeight(resolveCurrentInsetHeight(layout));
        }
        return unsubscribe;
    }, [reportHeight, layout]);

    // The rendered height comes from the continuously tracked inset, not from the notified
    // settled total. Both describe the same quantity and agree at rest, but only the animated
    // one keeps moving while the JS thread is busy — and this spacer is what every visible
    // transcript row sits on, so a single-commit collapse here translates the whole transcript
    // in one frame (measured 2026-08-01: 190-257 px per send, 11/11 sends, while the keyboard
    // was still mid-dismissal). `onHeightChange` above keeps reporting the settled total, which
    // is what JS-side consumers must agree on.
    const animatedInsetStyle = useAnimatedStyle(() => ({
        height: normalizeInsetHeight(layout ? layout.listBottomInsetAnimated.value : 0),
    }), [layout]);

    if (!layout) {
        return null;
    }

    return (
        <Animated.View
            pointerEvents="none"
            testID={props.testID}
            style={[props.style, animatedInsetStyle]}
        />
    );
}
