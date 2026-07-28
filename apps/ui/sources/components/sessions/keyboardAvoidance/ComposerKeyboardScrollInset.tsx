import * as React from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';

import { useComposerKeyboardLayout } from './ComposerKeyboardContext';
import type { ComposerKeyboardLayout } from './ComposerKeyboardContext';

function normalizeInsetHeight(height: number): number {
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
    const [height, setHeight] = React.useState(() => resolveCurrentInsetHeight(layout));
    const lastReportedHeightRef = React.useRef<number | null>(null);
    const applyHeight = React.useCallback((nextHeight: number) => {
        const normalizedHeight = normalizeInsetHeight(nextHeight);
        setHeight((current) => (current === normalizedHeight ? current : normalizedHeight));
        if (lastReportedHeightRef.current !== normalizedHeight) {
            lastReportedHeightRef.current = normalizedHeight;
            props.onHeightChange?.(normalizedHeight);
        }
    }, [props.onHeightChange]);

    React.useEffect(() => {
        if (!layout) {
            applyHeight(0);
            return undefined;
        }
        const subscribeListBottomInset = layout.subscribeListBottomInset;
        if (!subscribeListBottomInset) {
            applyHeight(resolveCurrentInsetHeight(layout));
            return undefined;
        }
        // The notified payload is computed by the writer from its own fresh inputs and is
        // the canonical inset on every platform. Re-deriving from shared-value reads at
        // delivery time is stale on native: guest-runtime writes are async, so `.value`
        // lags the payload by one step and the final composer-growth update is lost
        // (live-diagnosed 2026-07-09: transcript rows rendered under the composer).
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
            applyHeight(nextHeight);
        });
        if (!replayedNotifiedInset) {
            applyHeight(resolveCurrentInsetHeight(layout));
        }
        return unsubscribe;
    }, [applyHeight, layout]);

    if (!layout) {
        return null;
    }

    return (
        <View
            pointerEvents="none"
            testID={props.testID}
            style={[props.style, { height }]}
        />
    );
}
