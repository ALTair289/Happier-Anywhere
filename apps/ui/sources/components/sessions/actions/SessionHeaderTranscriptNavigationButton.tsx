import * as React from 'react';
import { Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useSessionCockpitChromeRegistration } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { t } from '@/text';
import { useOptionalSessionScreenTestId } from '../shell/sessionScreenTestIds';

export function useOpenTranscriptNavigationSurface(params: Readonly<{
    scopeId: string;
    sessionId?: string | null;
}>): () => void {
    const pane = useAppPaneScope(params.scopeId);
    const cockpitChrome = useSessionCockpitChromeRegistration();

    return React.useCallback(() => {
        if (params.sessionId && cockpitChrome?.sessionId === params.sessionId) {
            cockpitChrome.switchSurface('navigation');
            return;
        }
        pane.openRight({ tabId: 'navigation' });
        pane.setRightTab('navigation');
    }, [cockpitChrome, pane, params.sessionId]);
}

export const SessionHeaderTranscriptNavigationButton = React.memo((props: Readonly<{
    scopeId: string;
    sessionId?: string | null;
}>) => {
    const { theme } = useUnistyles();
    const testId = useOptionalSessionScreenTestId('session-header-transcript-navigation-button');
    const onPress = useOpenTranscriptNavigationSurface(props);

    return (
        <Pressable
            testID={testId}
            onPress={onPress}
            hitSlop={15}
            style={({ pressed }) => ({
                width: 44,
                height: 44,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.7 : 1,
            })}
            accessibilityRole="button"
            accessibilityLabel={t('session.openTranscriptNavigation')}
        >
            <Ionicons name="list-outline" size={22} color={theme.colors.chrome.header.foreground} />
        </Pressable>
    );
});
