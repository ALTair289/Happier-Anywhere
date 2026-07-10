import * as React from 'react';
import { Platform } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import {
    ComposerKeyboardProvider,
    ComposerKeyboardScrollInset,
} from '@/components/sessions/keyboardAvoidance';
import {
    createMockComposerKeyboardLayout,
    renderScreen,
} from '@/dev/testkit';
import type { ComposerKeyboardLayout } from './ComposerKeyboardContext';

describe('ComposerKeyboardScrollInset', () => {
    it('renders the current list inset before subscription replay', async () => {
        const onHeightChange = vi.fn();
        const layout = {
            ...createMockComposerKeyboardLayout({
                bottomInset: 68,
                composerHeight: 100,
                keyboardHeightForInset: 68,
                listBottomInset: 168,
            }),
            subscribeListBottomInset: () => () => {},
        } satisfies ComposerKeyboardLayout;

        const screen = await renderScreen(
            <ComposerKeyboardProvider layout={layout}>
                <ComposerKeyboardScrollInset
                    testID="transcript-composer-keyboard-inset"
                    onHeightChange={onHeightChange}
                />
            </ComposerKeyboardProvider>,
        );

        const node = screen.findByTestId('transcript-composer-keyboard-inset');
        if (!node) {
            throw new Error('Expected transcript composer keyboard inset to render.');
        }
        const styles = Array.isArray(node.props.style) ? node.props.style : [node.props.style];
        const height = styles.reduce<number | undefined>((value, style) => (
            typeof style?.height === 'number' ? style.height : value
        ), undefined);

        expect(height).toBe(168);
        expect(onHeightChange).toHaveBeenCalledWith(168);
    });

    it('uses subscribed list inset updates so native lists reserve composer space', async () => {
        const listeners = new Set<(height: number) => void>();
        const layout = {
            ...createMockComposerKeyboardLayout({ listBottomInset: 0 }),
            subscribeListBottomInset: (listener: (height: number) => void) => {
                listeners.add(listener);
                listener(0);
                return () => {
                    listeners.delete(listener);
                };
            },
        } satisfies ComposerKeyboardLayout;

        const screen = await renderScreen(
            <ComposerKeyboardProvider layout={layout}>
                <ComposerKeyboardScrollInset testID="transcript-composer-keyboard-inset" />
            </ComposerKeyboardProvider>,
        );

        const readHeight = () => {
            const node = screen.findByTestId('transcript-composer-keyboard-inset');
            if (!node) {
                throw new Error('Expected transcript composer keyboard inset to render.');
            }
            const styles = Array.isArray(node.props.style) ? node.props.style : [node.props.style];
            return styles.reduce<number | undefined>((height, style) => (
                typeof style?.height === 'number' ? style.height : height
            ), undefined);
        };

        expect(readHeight()).toBe(0);

        await act(async () => {
            layout.composerHeight.value = 120;
            layout.keyboardHeightForInset.value = 72;
            layout.bottomInset.value = 72;
            layout.listBottomInset.value = 192;
            for (const listener of listeners) {
                listener(192);
            }
        });

        expect(readHeight()).toBe(192);
    });

    it('applies notified totals even when guest-runtime shared-value reads lag behind', async () => {
        // Reanimated 4 guest-runtime: JS writes to shared values are async, so `.value`
        // reads at notify-delivery time can be one step behind the writer's computation.
        // The notified payload is computed from the writer's own fresh inputs and is the
        // canonical value; the native listener must apply it rather than re-deriving from
        // (potentially stale) shared-value reads. Live evidence 2026-07-09: composer growth
        // left the transcript inset one step behind and rows rendered under the composer.
        const listeners = new Set<(height: number) => void>();
        const layout = {
            ...createMockComposerKeyboardLayout({
                bottomInset: 267,
                composerHeight: 153, // stale read: the composer already grew to 172
                keyboardHeightForInset: 267,
                listBottomInset: 420, // stale read: the writer just computed 439
            }),
            subscribeListBottomInset: (listener: (height: number) => void) => {
                listeners.add(listener);
                listener(420);
                return () => {
                    listeners.delete(listener);
                };
            },
        } satisfies ComposerKeyboardLayout;

        const screen = await renderScreen(
            <ComposerKeyboardProvider layout={layout}>
                <ComposerKeyboardScrollInset testID="transcript-composer-keyboard-inset" />
            </ComposerKeyboardProvider>,
        );

        const readHeight = () => {
            const node = screen.findByTestId('transcript-composer-keyboard-inset');
            if (!node) {
                throw new Error('Expected transcript composer keyboard inset to render.');
            }
            const styles = Array.isArray(node.props.style) ? node.props.style : [node.props.style];
            return styles.reduce<number | undefined>((height, style) => (
                typeof style?.height === 'number' ? style.height : height
            ), undefined);
        };

        expect(readHeight()).toBe(420);

        await act(async () => {
            for (const listener of listeners) {
                listener(439);
            }
        });

        expect(readHeight()).toBe(439);
    });

    it('settles on the last notified total after the composer and keyboard have collapsed', async () => {
        const onHeightChange = vi.fn();
        const listeners = new Set<(height: number) => void>();
        const layout = {
            ...createMockComposerKeyboardLayout({
                bottomInset: 0,
                composerHeight: 134,
                keyboardHeightForInset: 0,
                listBottomInset: 134,
            }),
            subscribeListBottomInset: (listener: (height: number) => void) => {
                listeners.add(listener);
                listener(layout.listBottomInset.value);
                return () => {
                    listeners.delete(listener);
                };
            },
        } satisfies ComposerKeyboardLayout;

        const screen = await renderScreen(
            <ComposerKeyboardProvider layout={layout}>
                <ComposerKeyboardScrollInset
                    testID="transcript-composer-keyboard-inset"
                    onHeightChange={onHeightChange}
                />
            </ComposerKeyboardProvider>,
        );

        const readHeight = () => {
            const node = screen.findByTestId('transcript-composer-keyboard-inset');
            if (!node) {
                throw new Error('Expected transcript composer keyboard inset to render.');
            }
            const styles = Array.isArray(node.props.style) ? node.props.style : [node.props.style];
            return styles.reduce<number | undefined>((height, style) => (
                typeof style?.height === 'number' ? style.height : height
            ), undefined);
        };

        expect(readHeight()).toBe(134);
        expect(onHeightChange).toHaveBeenCalledWith(134);

        // Collapse settle notifications (keyboard onEnd + keyboardDidHide) are emitted after
        // any in-flight animation-frame payloads, so delivery order on the JS thread ends on
        // the settled total. The listener applies payloads in delivery order and must settle
        // on the last one.
        await act(async () => {
            for (const listener of listeners) {
                listener(303);
            }
            for (const listener of listeners) {
                listener(134);
            }
        });

        expect(readHeight()).toBe(134);
        expect(onHeightChange).toHaveBeenLastCalledWith(134);
    });

    it('falls back to measured composer height when the native list inset has not replayed yet', async () => {
        const onHeightChange = vi.fn();
        const layout = {
            ...createMockComposerKeyboardLayout({
                bottomInset: 0,
                composerHeight: 125,
                listBottomInset: 0,
            }),
            subscribeListBottomInset: () => () => {},
        } satisfies ComposerKeyboardLayout;

        const screen = await renderScreen(
            <ComposerKeyboardProvider layout={layout}>
                <ComposerKeyboardScrollInset
                    testID="transcript-composer-keyboard-inset"
                    onHeightChange={onHeightChange}
                />
            </ComposerKeyboardProvider>,
        );

        const node = screen.findByTestId('transcript-composer-keyboard-inset');
        if (!node) {
            throw new Error('Expected transcript composer keyboard inset to render.');
        }
        const styles = Array.isArray(node.props.style) ? node.props.style : [node.props.style];
        const height = styles.reduce<number | undefined>((value, style) => (
            typeof style?.height === 'number' ? style.height : value
        ), undefined);

        expect(height).toBe(125);
        expect(onHeightChange).toHaveBeenCalledWith(125);
    });

    it('does not reserve composer fallback space on web because the composer is in normal layout flow', async () => {
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
        try {
            const layout = {
                ...createMockComposerKeyboardLayout({
                    bottomInset: 34,
                    composerHeight: 125,
                    listBottomInset: 0,
                }),
                subscribeListBottomInset: () => () => {},
            } satisfies ComposerKeyboardLayout;

            const screen = await renderScreen(
                <ComposerKeyboardProvider layout={layout}>
                    <ComposerKeyboardScrollInset testID="transcript-composer-keyboard-inset" />
                </ComposerKeyboardProvider>,
            );

            const node = screen.findByTestId('transcript-composer-keyboard-inset');
            if (!node) {
                throw new Error('Expected transcript composer keyboard inset to render.');
            }
            const styles = Array.isArray(node.props.style) ? node.props.style : [node.props.style];
            const height = styles.reduce<number | undefined>((value, style) => (
                typeof style?.height === 'number' ? style.height : value
            ), undefined);

            expect(height).toBe(0);
        } finally {
            Object.defineProperty(Platform, 'OS', { value: originalPlatformOS, configurable: true });
        }
    });
});
