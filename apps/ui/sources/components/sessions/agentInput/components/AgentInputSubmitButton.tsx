import { Image } from 'expo-image';
import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { PrimaryCircleIconButton } from '@/components/ui/buttons/PrimaryCircleIconButton';
import { hapticsLight } from '@/components/ui/theme/haptics';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

export const AgentInputSubmitButton = React.memo(function AgentInputSubmitButton(props: Readonly<{
    testID: string;
    sessionId?: string;
    submitAccessibilityLabel?: string;
    disabled: boolean;
    isSending?: boolean;
    isStopping?: boolean;
    hasSendableContent: boolean;
    canStop?: boolean;
    micPressHandler?: (() => void) | undefined;
    micActive: boolean;
    onSend: () => void;
    onStop?: () => void;
}>) {
    const { theme } = useUnistyles();
    const showStopWhenEmpty = !props.hasSendableContent && !props.micPressHandler && props.canStop === true;

    return (
        <PrimaryCircleIconButton
            testID={props.testID}
            active={props.hasSendableContent || props.isSending || Boolean(props.micPressHandler) || showStopWhenEmpty}
            loading={props.isSending || (showStopWhenEmpty && props.isStopping)}
            disabled={props.disabled}
            accessibilityLabel={
                props.hasSendableContent
                    ? (props.submitAccessibilityLabel ?? (props.sessionId ? t('common.send') : t('newSession.title')))
                    : (
                        props.micPressHandler
                            ? t('voiceAssistant.label')
                            : showStopWhenEmpty
                                ? t('runs.stop.stopRunA11y')
                            : (props.submitAccessibilityLabel ?? (props.sessionId ? t('common.send') : t('newSession.title')))
                    )
            }
            accessibilityHint={
                (!props.hasSendableContent && !props.micPressHandler && !showStopWhenEmpty)
                    ? t('session.inputPlaceholder')
                    : undefined
            }
            accessibilityState={{
                disabled: Boolean(props.disabled),
            }}
            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
            onPress={() => {
                hapticsLight();
                if (props.hasSendableContent) {
                    props.onSend();
                } else {
                    if (props.micPressHandler) {
                        props.micPressHandler();
                    } else if (showStopWhenEmpty) {
                        props.onStop?.();
                    }
                }
            }}
            style={{ marginLeft: 8, marginRight: 8 }}
        >
            {props.hasSendableContent ? (
                <Icon
                    name="arrow-up"
                    size={16}
                    color={theme.colors.button.primary.tint}
                    style={{ marginTop: Platform.OS === 'web' ? 2 : 0 }}
                />
            ) : props.micPressHandler ? (
                props.micActive ? (
                    <Icon name="stop-circle" size={20} color={theme.colors.button.primary.tint} />
                ) : (
                    <Image
                        source={require('@/assets/images/icon-voice-white.png')}
                        style={{ width: 24, height: 24 }}
                        tintColor={theme.colors.button.primary.tint}
                    />
                )
            ) : showStopWhenEmpty ? (
                <Icon name="stop" size={16} weight="fill" color={theme.colors.button.primary.tint} />
            ) : (
                <Icon
                    name="arrow-up"
                    size={16}
                    color={theme.colors.button.primary.tint}
                    style={{ marginTop: Platform.OS === 'web' ? 2 : 0 }}
                />
            )}
        </PrimaryCircleIconButton>
    );
});
