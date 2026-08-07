import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { t } from '@/text';

import { resolveTranscriptNavigationRailSoftFadeStyle } from './useTranscriptNavigationRailSoftPresence';

/**
 * Height of the edge band. Deliberately identical to the gradient it carries:
 * the chevron may only sit over markers the fade has already washed out, so
 * revealing it never steals a hit area from a marker the reader can still see.
 */
const EDGE_BAND_HEIGHT_PX = 18;

/**
 * How far the chevron travels outward as it appears. Four pixels reads as a
 * spear out of the rail edge at this scale; the popover token's 8px is tuned
 * for a full overlay and would visibly overshoot a 24px-wide gutter.
 */
const CHEVRON_SPEAR_DISTANCE_PX = 4;

export type TranscriptNavigationRailEdgeAffordanceProps = Readonly<{
    edge: 'top' | 'bottom';
    onPage: (direction: 'up' | 'down') => void;
    reducedMotion: boolean;
    /** Revealed on rail hover or keyboard focus-within; a quiet gradient otherwise. */
    revealed: boolean;
}>;

/**
 * The rail's one edge-affordance owner: the overflow gradient and the paging
 * chevron for a single edge, mounted only for a direction the rail layout owner
 * reports as overflowing. Both parts read that single fact, so the gradient and
 * the chevron can never disagree about whether more markers exist.
 *
 * Composed with `ScrollEdgeFades` rather than folded into it: that primitive is
 * a decorative `pointerEvents: 'none'` gradient with roughly two dozen
 * production consumers, and pushing press handling, reveal state, translated
 * labels and motion into it would hand every one of those call sites an
 * interactive surface they neither want nor pass props for.
 *
 * The chevron carries `tabIndex={-1}` on purpose: the rail is a single roving
 * tabstop whose `aria-activedescendant` tracks the addressed marker, and a
 * focusable chevron would insert itself ahead of the markers in tab order.
 * Keyboard readers page the rail with the arrow, Home and End keys already
 * handled by that tabstop; the chevron stays an addressable button for
 * assistive technology browsing by element.
 */
export function TranscriptNavigationRailEdgeAffordance(props: TranscriptNavigationRailEdgeAffordanceProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const isTop = props.edge === 'top';
    const { onPage } = props;

    const handlePress = React.useCallback(() => {
        onPage(isTop ? 'up' : 'down');
    }, [isTop, onPage]);

    return (
        <View
            // Transparent to the pointer itself so the band never swallows a
            // marker hover; only the revealed chevron inside it is a target.
            pointerEvents="box-none"
            testID={`transcript-navigation-rail.edge.${props.edge}`}
            style={[styles.edge, isTop ? styles.edgeTop : styles.edgeBottom]}
        >
            <ScrollEdgeFades
                color={theme.colors.surface.base}
                edges={isTop ? { top: true } : { bottom: true }}
                size={EDGE_BAND_HEIGHT_PX}
            />
            <Pressable
                accessibilityLabel={isTop
                    ? t('session.transcriptNavigation.railScrollUpA11y')
                    : t('session.transcriptNavigation.railScrollDownA11y')}
                accessibilityRole="button"
                onPress={handlePress}
                tabIndex={-1}
                testID={`transcript-navigation-rail.chevron.${props.edge}`}
                style={[
                    styles.chevron,
                    // A chevron faded to zero must not intercept the pointer,
                    // or an invisible button would eat the edge markers' hover.
                    props.revealed ? null : styles.chevronHidden,
                    resolveTranscriptNavigationRailSoftFadeStyle(props.revealed, props.reducedMotion, {
                        hiddenTranslateYPx: isTop ? CHEVRON_SPEAR_DISTANCE_PX : -CHEVRON_SPEAR_DISTANCE_PX,
                    }),
                ]}
            >
                <Icon
                    name={isTop ? 'caret-up' : 'caret-down'}
                    size={12}
                    color={theme.colors.text.secondary}
                />
            </Pressable>
        </View>
    );
}

const stylesheet = StyleSheet.create(() => ({
    edge: {
        height: EDGE_BAND_HEIGHT_PX,
        left: 0,
        overflow: 'hidden',
        position: 'absolute',
        right: 0,
    },
    edgeTop: {
        top: 0,
    },
    edgeBottom: {
        bottom: 0,
    },
    chevron: {
        alignItems: 'center',
        bottom: 0,
        justifyContent: 'center',
        left: 0,
        position: 'absolute',
        right: 0,
        top: 0,
        // Above the gradient, which paints at zIndex 10.
        zIndex: 11,
    },
    chevronHidden: {
        pointerEvents: 'none',
    },
}));
