import * as React from 'react';

import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
import { t } from '@/text';

import { useDesktopAutostart } from './useDesktopAutostart';
import { Icon } from '@/components/ui/icons/Icon';

export const DesktopSettingsSection = React.memo(function DesktopSettingsSection() {
    const { theme } = useUnistyles();
    const autostart = useDesktopAutostart();

    if (!autostart.supported) {
        return null;
    }

    return (
        <ItemGroup
            title={t('settingsDesktop.title')}
            footer={t('settingsDesktop.footer')}
        >
            <Item
                testID="settings-desktop-autostart-enabled"
                title={t('settingsDesktop.startOnLoginTitle')}
                subtitle={autostart.error ?? t('settingsDesktop.startOnLoginSubtitle')}
                icon={<Icon name="desktop" size={29} color={theme.colors.accent.blue} />}
                rightElement={(
                    <Switch
                        value={autostart.enabled}
                        disabled={autostart.loading}
                        onValueChange={(value) => {
                            void autostart.setEnabled(Boolean(value));
                        }}
                    />
                )}
                showChevron={false}
            />
        </ItemGroup>
    );
});
