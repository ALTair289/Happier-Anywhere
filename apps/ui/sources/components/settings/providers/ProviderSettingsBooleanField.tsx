import React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type { ProviderSettingFieldDef } from '@/agents/providers/shared/providerSettingsPlugin';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';

import { resolveProviderSettingsText } from './providerSettingsText';
import { Icon } from '@/components/ui/icons/Icon';

export const ProviderSettingsBooleanField = React.memo(function ProviderSettingsBooleanField(props: Readonly<{
    field: ProviderSettingFieldDef;
    value: unknown;
    setFieldValue: (field: ProviderSettingFieldDef, value: unknown) => void;
}>) {
    const { theme } = useUnistyles();
    const boolValue = Boolean(props.value);

    return (
        <Item
            testID={`settings-provider-field-${props.field.key}`}
            title={resolveProviderSettingsText(props.field.title) ?? ''}
            subtitle={resolveProviderSettingsText(props.field.subtitle)}
            icon={<Icon name="sliders-horizontal" size={29} color={theme.colors.text.secondary} />}
            rightElement={<Switch value={boolValue} onValueChange={(v) => props.setFieldValue(props.field, v)} />}
            showChevron={false}
            onPress={() => props.setFieldValue(props.field, !boolValue)}
        />
    );
});
