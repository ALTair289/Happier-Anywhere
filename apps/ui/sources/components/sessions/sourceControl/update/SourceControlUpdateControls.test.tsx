import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
    findTestInstanceByTypeWithProps,
    flattenTestStyle,
    renderScreen,
} from '@/dev/testkit';

import { SourceControlUpdateButton } from './SourceControlUpdateControls';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const theme = {
    colors: {
        button: {
            primary: {
                background: 'button-primary-background',
                tint: 'button-primary-tint',
            },
        },
        border: { default: 'divider', subtle: 'divider' },
        surface: { inset: 'surface-high' },
        text: {
            primary: 'text',
            secondary: 'text-secondary',
        },
        state: {
            danger: { foreground: 'danger' },
        },
    },
};

describe('SourceControlUpdateControls', () => {
    it('uses app primary button colors for primary update actions', async () => {
        const screen = await renderScreen(
            <SourceControlUpdateButton
                theme={theme}
                testID="source-control-update-primary"
                label="Primary"
                kind="primary"
                onPress={vi.fn()}
            />,
        );

        const button = screen.findByTestId('source-control-update-primary');
        // The shared button composes its style as an array; flatten rather than assume a single object.
        const buttonStyle = flattenTestStyle(button?.props.style({ pressed: false }));
        const text = findTestInstanceByTypeWithProps(screen.tree, 'Text' as any, {
            children: 'Primary',
        });

        expect(buttonStyle.backgroundColor).toBe('button-primary-background');
        expect(flattenTestStyle(text?.props.style).color).toBe('button-primary-tint');
    });
});
