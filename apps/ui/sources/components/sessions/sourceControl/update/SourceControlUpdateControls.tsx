import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { StyleSheet as RNStyleSheet } from 'react-native';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';

export type SourceControlUpdateTheme = Readonly<{
    colors: Readonly<{
        background?: string | Readonly<{ canvas?: string }>;
        border: Readonly<{
            default: string;
            subtle: string;
        }>;
        primary?: string;
        surface: Readonly<{
            base?: string;
            inset: string;
        }>;
        text: Readonly<{
            primary: string;
            secondary: string;
        }>;
        state: Readonly<{
            danger: Readonly<{ foreground: string }>;
        }>;
        button?: Readonly<{
            primary?: Readonly<{
                background?: string;
                tint?: string;
                disabled?: string;
            }>;
        }>;
        input?: Readonly<{
            background?: string;
            border?: string;
            placeholder?: string;
            text?: string;
        }>;
    }>;
}>;

function resolveCanvasBackgroundColor(background: SourceControlUpdateTheme['colors']['background']): string | undefined {
    if (typeof background === 'string') return background;
    return background?.canvas;
}

export function SourceControlUpdateSection(props: Readonly<{
    theme: SourceControlUpdateTheme;
    title: string;
    testID?: string;
    children: React.ReactNode;
}>) {
    return (
        <View
            testID={props.testID}
            style={{
                paddingHorizontal: 12,
                paddingTop: 12,
                paddingBottom: 12,
                borderBottomWidth: 1,
                borderBottomColor: props.theme.colors.border.default,
                gap: 10,
            }}
        >
            <Text
                style={{
                    fontSize: 12,
                    color: props.theme.colors.text.secondary,
                    ...Typography.default('semiBold'),
                }}
            >
                {props.title}
            </Text>
            {props.children}
        </View>
    );
}

export function SourceControlUpdateInput(props: Readonly<{
    theme: SourceControlUpdateTheme;
    testID: string;
    value: string;
    placeholder: string;
    accessibilityLabel: string;
    editable?: boolean;
    onChangeText: (value: string) => void;
}>) {
    return (
        <TextInput
            testID={props.testID}
            accessibilityLabel={props.accessibilityLabel}
            value={props.value}
            placeholder={props.placeholder}
            placeholderTextColor={props.theme.colors.input?.placeholder ?? props.theme.colors.text.secondary}
            editable={props.editable !== false}
            autoCapitalize="none"
            autoCorrect={false}
            style={{
                minHeight: 34,
                borderWidth: 1,
                borderColor: props.theme.colors.input?.border ?? props.theme.colors.border.default,
                backgroundColor: props.theme.colors.input?.background ?? props.theme.colors.surface.inset,
                color: props.theme.colors.input?.text ?? props.theme.colors.text.primary,
                borderRadius: 8,
                paddingHorizontal: 10,
                paddingVertical: 7,
                fontSize: 12,
                opacity: props.editable === false ? 0.6 : 1,
            }}
            onChangeText={props.onChangeText}
        />
    );
}

/**
 * Kept as a named export because ten call sites in the update tab pass the narrowed `theme` prop,
 * but it is no longer a second implementation: the same small labelled button as every other
 * toolbar, through the canonical owner. `theme` is now unused for styling — `ToolbarButton` reads
 * the live theme itself — and stays only so those callers do not all have to change at once.
 */
export function SourceControlUpdateButton(props: Readonly<{
    theme: SourceControlUpdateTheme;
    label: string;
    testID: string;
    onPress: () => void;
    disabled?: boolean;
    kind?: 'primary' | 'secondary' | 'danger';
}>) {
    const kind = props.kind ?? 'secondary';
    // The shared button reads the live theme, but this one is handed a theme explicitly by every
    // call site in the update tab, so the injected values win where they differ.
    const injectedPrimary = kind === 'primary'
        ? {
            backgroundColor: props.theme.colors.button?.primary?.background ?? props.theme.colors.primary,
            borderWidth: 0,
        }
        : undefined;
    const injectedLabelColor = kind === 'primary'
        ? props.theme.colors.button?.primary?.tint
        : kind === 'danger'
            ? props.theme.colors.state.danger.foreground
            : props.theme.colors.text.primary;

    return (
        <ToolbarButton
            size="md"
            testID={props.testID}
            label={props.label}
            onPress={props.onPress}
            disabled={props.disabled}
            tone={kind === 'primary' ? 'primary' : kind === 'danger' ? 'danger' : 'default'}
            labelColor={injectedLabelColor}
            style={injectedPrimary}
        />
    );
}
