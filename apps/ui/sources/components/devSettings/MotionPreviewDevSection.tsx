/**
 * Phase 1A.11 — Motion primitive variants preview (Lane L).
 *
 * Side-by-side variants demonstrating the unified slide transition primitives:
 *   - Discrete switch (SelectionList-style): `SlideTransitionSwitch`, blur off, compact preset
 *   - Carousel drag + tap-Continue (StoryDeck-style): `StoryDeckSlideTransition`, blur on, soft preset
 *
 * Each variant exposes toggles for: blur on/off, preset (soft/compact), reduced motion.
 * Visual QA harness only — not consumed by production flows.
 */

import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { Icon } from '@/components/ui/icons/Icon';
import {
    SlideTransitionSwitch,
    StoryDeckSlideTransition,
    type SlideTransitionPreset,
    type StoryDeckSlideTransitionHandle,
} from '@/components/ui/motion';

type VariantState = Readonly<{
    blur: boolean;
    preset: SlideTransitionPreset;
    reducedMotion: boolean;
}>;

function ToggleRow(props: Readonly<{
    label: string;
    value: boolean;
    onChange: (next: boolean) => void;
}>): React.ReactElement {
    return (
        <Pressable
            onPress={() => props.onChange(!props.value)}
            style={styles.toggleRow}
        >
            <Text style={styles.toggleLabel}>{props.label}</Text>
            <Text style={styles.toggleValue}>{props.value ? 'on' : 'off'}</Text>
        </Pressable>
    );
}

function PresetRow(props: Readonly<{
    value: SlideTransitionPreset;
    onChange: (next: SlideTransitionPreset) => void;
}>): React.ReactElement {
    return (
        <Pressable
            onPress={() => props.onChange(props.value === 'soft' ? 'compact' : 'soft')}
            style={styles.toggleRow}
        >
            <Text style={styles.toggleLabel}>preset</Text>
            <Text style={styles.toggleValue}>{props.value}</Text>
        </Pressable>
    );
}

function VariantControls(props: Readonly<{
    state: VariantState;
    onChange: (next: VariantState) => void;
}>): React.ReactElement {
    return (
        <View style={styles.controlsRow}>
            <ToggleRow
                label="blur"
                value={props.state.blur}
                onChange={(blur) => props.onChange({ ...props.state, blur })}
            />
            <PresetRow
                value={props.state.preset}
                onChange={(preset) => props.onChange({ ...props.state, preset })}
            />
            <ToggleRow
                label="reduced motion"
                value={props.state.reducedMotion}
                onChange={(reducedMotion) => props.onChange({ ...props.state, reducedMotion })}
            />
        </View>
    );
}

function DiscreteSwitchVariant(): React.ReactElement {
    const [index, setIndex] = React.useState(0);
    const previousIndexRef = React.useRef(0);
    const [variant, setVariant] = React.useState<VariantState>({
        blur: false,
        preset: 'compact',
        reducedMotion: false,
    });

    const direction = React.useMemo(() => {
        const previous = previousIndexRef.current;
        previousIndexRef.current = index;
        if (index > previous) return 'forward' as const;
        if (index < previous) return 'backward' as const;
        return 'replace' as const;
    }, [index]);

    return (
        <View style={styles.variantBlock}>
            <Text style={styles.variantTitle}>Discrete switch (SelectionList-style)</Text>
            <VariantControls state={variant} onChange={setVariant} />
            <View style={styles.frame}>
                <SlideTransitionSwitch
                    contentKey={index}
                    direction={direction}
                    blur={variant.blur}
                    preset={variant.preset}
                    reducedMotion={variant.reducedMotion}
                >
                    <View style={styles.panel}>
                        <Text style={styles.panelTitle}>{`Step ${index + 1}`}</Text>
                        <Text style={styles.panelBody}>
                            Discrete adapter for SelectionList. Forward/backward direction is caller-owned; blur defaults off.
                        </Text>
                    </View>
                </SlideTransitionSwitch>
            </View>
            <View style={styles.controlsRow}>
                <Pressable
                    onPress={() => setIndex((current) => Math.max(0, current - 1))}
                    style={styles.button}
                >
                    <Text style={styles.buttonText}>Back</Text>
                </Pressable>
                <Pressable
                    onPress={() => setIndex((current) => Math.min(4, current + 1))}
                    style={styles.button}
                >
                    <Text style={styles.buttonText}>Forward</Text>
                </Pressable>
            </View>
        </View>
    );
}

function CarouselVariant(): React.ReactElement {
    const [activeIndex, setActiveIndex] = React.useState(0);
    const [variant, setVariant] = React.useState<VariantState>({
        blur: true,
        preset: 'soft',
        reducedMotion: false,
    });
    const itemCount = 5;
    // RV-4 / F13.4 — Continue/Back must drive `StoryDeckSlideTransitionHandle`
    // so the dev preview exercises the same imperative-commit spring as
    // production StoryDeckSurface. Mutating `activeIndex` directly here would
    // hide the imperative path entirely from visual QA.
    const handleRef = React.useRef<StoryDeckSlideTransitionHandle | null>(null);

    return (
        <View style={styles.variantBlock}>
            <Text style={styles.variantTitle}>Carousel drag + tap (StoryDeck-style)</Text>
            <VariantControls state={variant} onChange={setVariant} />
            <View style={styles.frame}>
                <StoryDeckSlideTransition
                    ref={handleRef}
                    activeIndex={activeIndex}
                    itemCount={itemCount}
                    blur={variant.blur}
                    preset={variant.preset}
                    reducedMotion={variant.reducedMotion}
                    renderItem={(index: number) => (
                        <View style={styles.panel} key={`carousel-${index}`}>
                            <Text style={styles.panelTitle}>{`Card ${index + 1}`}</Text>
                            <Text style={styles.panelBody}>
                                Drag horizontally past 40% of the width to commit. The Continue/Back buttons fire the same spring.
                            </Text>
                        </View>
                    )}
                    onCommitNext={() => setActiveIndex((current) => Math.min(itemCount - 1, current + 1))}
                    onCommitPrevious={() => setActiveIndex((current) => Math.max(0, current - 1))}
                    testID="dev-motion-preview-carousel"
                />
            </View>
            <View style={styles.controlsRow}>
                <Pressable
                    testID="dev-motion-preview-carousel-back"
                    onPress={() => handleRef.current?.commitPrevious()}
                    style={styles.button}
                >
                    <Text style={styles.buttonText}>Back</Text>
                </Pressable>
                <Pressable
                    testID="dev-motion-preview-carousel-continue"
                    onPress={() => handleRef.current?.commitNext()}
                    style={styles.button}
                >
                    <Text style={styles.buttonText}>Continue</Text>
                </Pressable>
            </View>
        </View>
    );
}

function MotionVariantsPreviewModal(props: Readonly<{ onClose: () => void }>): React.ReactElement {
    const { theme } = useUnistyles();
    return (
        <View style={styles.modal}>
            <View style={styles.header}>
                <Text style={styles.headerTitle}>Motion primitives — variants</Text>
                <Pressable onPress={props.onClose} style={styles.closeButton}>
                    <Icon name="x" size={20} color={theme.colors.text.primary} />
                </Pressable>
            </View>
            <View style={styles.body}>
                <DiscreteSwitchVariant />
                <CarouselVariant />
            </View>
        </View>
    );
}

function showMotionVariantsPreview(): void {
    let id: string | null = null;
    const close = () => {
        if (!id) return;
        Modal.hide(id);
        id = null;
    };
    id = Modal.show({
        component: MotionVariantsPreviewModal,
        props: { onClose: close },
    });
}

export function MotionPreviewDevSection(): React.ReactElement {
    const { theme } = useUnistyles();
    return (
        <ItemGroup title="Motion Primitives" footer="Phase 1A.11 — slide transition variants for visual QA">
            <Item
                testID="dev-motion-preview-slide-variants"
                title="Slide Transition Variants"
                subtitle="Discrete switch + carousel drag/tap, with blur/preset/reduced-motion toggles"
                icon={<Icon name="stack-simple" size={29} color={theme.colors.text.primary} />}
                onPress={showMotionVariantsPreview}
            />
        </ItemGroup>
    );
}

const styles = StyleSheet.create((theme) => ({
    modal: {
        flex: 1,
        backgroundColor: theme.colors.background.canvas,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    headerTitle: {
        color: theme.colors.text.primary,
        fontSize: 18,
        fontWeight: '600',
    },
    closeButton: {
        padding: 8,
    },
    body: {
        flex: 1,
        gap: 24,
        padding: 16,
    },
    variantBlock: {
        gap: 12,
    },
    variantTitle: {
        color: theme.colors.text.primary,
        fontSize: 14,
        fontWeight: '600',
    },
    controlsRow: {
        flexDirection: 'row',
        gap: 8,
        flexWrap: 'wrap',
    },
    toggleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        backgroundColor: theme.colors.surface.elevated,
        borderRadius: 999,
    },
    toggleLabel: {
        color: theme.colors.text.secondary,
        fontSize: 12,
    },
    toggleValue: {
        color: theme.colors.text.primary,
        fontSize: 12,
        fontWeight: '600',
    },
    frame: {
        height: 260,
        backgroundColor: theme.colors.surface.inset,
        borderRadius: 12,
        overflow: 'hidden',
    },
    panel: {
        flex: 1,
        gap: 8,
        padding: 16,
        backgroundColor: theme.colors.surface.base,
    },
    panelTitle: {
        color: theme.colors.text.primary,
        fontSize: 16,
        fontWeight: '700',
    },
    panelBody: {
        color: theme.colors.text.secondary,
        fontSize: 13,
        lineHeight: 18,
    },
    button: {
        paddingHorizontal: 14,
        paddingVertical: 8,
        backgroundColor: theme.colors.button.primary.background,
        borderRadius: 8,
    },
    buttonText: {
        color: theme.colors.button.primary.tint,
        fontSize: 13,
        fontWeight: '600',
    },
}));
