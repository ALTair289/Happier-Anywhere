import * as React from 'react';
import { Animated, Platform } from 'react-native';

import { motionTokens } from '@/components/ui/motion/motionTokens';

import { useTranscriptMotion } from './TranscriptMotionContext';

function scheduleNextVisualFrame(callback: () => void): () => void {
    const raf = globalThis.requestAnimationFrame;
    if (typeof raf !== 'function') {
        callback();
        return () => {};
    }

    let cancelled = false;
    const id = raf(() => {
        if (!cancelled) {
            callback();
        }
    });

    return () => {
        cancelled = true;
        globalThis.cancelAnimationFrame?.(id);
    };
}

export const TranscriptEnterWrapper = React.memo(function TranscriptEnterWrapper(props: {
    id: string;
    createdAt: number;
    children: React.ReactNode;
}) {
    const runtime = useTranscriptMotion();

    const shouldPrepareEnterRef = React.useRef(
        runtime != null &&
        runtime.config.preset !== 'off' &&
        runtime.config.animateNewItemsEnabled === true &&
        runtime.gate.isFresh({ id: props.id, createdAt: props.createdAt }),
    );

    if (!shouldPrepareEnterRef.current || runtime == null) {
        return <>{props.children}</>;
    }

    return (
        <AnimatedTranscriptEnterWrapper
            id={props.id}
            createdAt={props.createdAt}
            runtime={runtime}
        >
            {props.children}
        </AnimatedTranscriptEnterWrapper>
    );
});

/**
 * A fresh row enters by FADE ONLY, on every platform.
 *
 * J/D4 (2026-07-30) — deliberate decision, recorded because the previous code hid the opposite one
 * behind a misnamed flag: `const animateTranslateOnWeb = Platform.OS !== 'web'` is TRUE on native,
 * so native rows faded AND slid 6px while web rows only faded. The 6px slide is removed rather than
 * renamed. Reasons: (1) the reason web opted out — a row translated toward its neighbour briefly
 * overlaps it and intercepts touches — is a platform-neutral hazard, not a web one; (2) a send
 * creates two fresh rows (the pending row, then its committed twin), so it was two native-only 6px
 * movements inside exactly the window whose movement the user is objecting to, on top of the
 * measured MVCP excursion at that handover; (3) it removes a native/web asymmetry that no product
 * decision asked for. Whether new rows animate at all remains owned by the motion preset /
 * `animateNewItemsEnabled`, not by a platform check here.
 */
const AnimatedTranscriptEnterWrapper = React.memo(function AnimatedTranscriptEnterWrapper(props: {
    id: string;
    createdAt: number;
    runtime: NonNullable<ReturnType<typeof useTranscriptMotion>>;
    children: React.ReactNode;
}) {
    const runtime = props.runtime;
    const opacity = React.useRef(new Animated.Value(0)).current;
    const animationStartedRef = React.useRef(false);
    const cancelScheduledStartRef = React.useRef<(() => void) | null>(null);
    const shouldAnimateRef = React.useRef<boolean | null>(null);

    React.useLayoutEffect(() => {
        if (shouldAnimateRef.current == null) {
            shouldAnimateRef.current = runtime.gate.consumeFreshness({
                id: props.id,
                createdAt: props.createdAt,
            });
        }

        if (shouldAnimateRef.current !== true) {
            opacity.setValue(1);
        }
    }, [opacity, props.createdAt, props.id, runtime.gate]);

    const startEnterAnimation = React.useCallback(() => {
        if (animationStartedRef.current) return;
        animationStartedRef.current = true;

        const duration =
            runtime?.config.preset === 'full'
                ? motionTokens.durationMs.base
                : motionTokens.durationMs.fast;
        const useNativeDriver = Platform.OS !== 'web';
        Animated.timing(opacity, {
            toValue: 1,
            duration,
            easing: motionTokens.easing.standard,
            useNativeDriver,
        }).start();
    }, [opacity, runtime?.config.preset]);

    const handleLayout = React.useCallback(() => {
        if (shouldAnimateRef.current !== true) return;
        if (animationStartedRef.current) return;
        if (cancelScheduledStartRef.current) return;

        cancelScheduledStartRef.current = scheduleNextVisualFrame(() => {
            cancelScheduledStartRef.current = null;
            startEnterAnimation();
        });
    }, [startEnterAnimation]);

    React.useEffect(() => {
        return () => {
            cancelScheduledStartRef.current?.();
            cancelScheduledStartRef.current = null;
        };
    }, []);

    return (
        <Animated.View onLayout={handleLayout} style={{ opacity }}>
            {props.children}
        </Animated.View>
    );
});
