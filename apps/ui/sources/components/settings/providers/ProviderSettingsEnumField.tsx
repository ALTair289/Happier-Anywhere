import React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { ProviderSettingFieldDef } from '@/agents/providers/shared/providerSettingsPlugin';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';

import { resolveProviderSettingsText } from './providerSettingsText';
import { Icon } from '@/components/ui/icons/Icon';

export const ProviderSettingsEnumField = React.memo(function ProviderSettingsEnumField(props: Readonly<{
    field: ProviderSettingFieldDef;
    value: unknown;
    open: boolean;
    setOpen: (open: boolean) => void;
    popoverBoundaryRef: React.RefObject<unknown>;
    setFieldValue: (field: ProviderSettingFieldDef, value: unknown) => void;
}>) {
    const { theme } = useUnistyles();
    const options = props.field.enumOptions ?? [];

    if (options.length === 0) {
        return (
            <Item
                key={props.field.key}
                testID={`settings-provider-field-${props.field.key}`}
                title={resolveProviderSettingsText(props.field.title) ?? ''}
                subtitle={resolveProviderSettingsText(props.field.subtitle) ?? t('settingsProviders.noOptionsAvailable')}
                icon={<Icon name="list" size={29} color={theme.colors.text.secondary} />}
                showChevron={false}
                disabled={true}
            />
        );
    }

    const currentId = typeof props.value === 'string' ? props.value : (options[0]?.id ?? '');
    const selectedOption = options.find((opt) => opt.id === currentId) ?? null;
    const selectedTitle = selectedOption ? resolveProviderSettingsText(selectedOption.title) : null;
    const selectedSubtitle = selectedOption ? resolveProviderSettingsText(selectedOption.subtitle) : undefined;
    const fieldSubtitle = resolveProviderSettingsText(props.field.subtitle) ?? undefined;

    return (
        <DropdownMenu
            key={props.field.key}
            open={props.open}
            onOpenChange={props.setOpen}
            variant="selectable"
            search={false}
            selectedId={currentId}
            showCategoryTitles={false}
            matchTriggerWidth={true}
            connectToTrigger={true}
            rowKind="item"
            popoverBoundaryRef={props.popoverBoundaryRef}
            trigger={({ toggle, open }: { toggle: () => void; open: boolean }) => (
                <Item
                    testID={`settings-provider-field-${props.field.key}`}
                    title={resolveProviderSettingsText(props.field.title) ?? ''}
                    subtitle={fieldSubtitle ?? selectedSubtitle}
                    detail={selectedTitle ?? undefined}
                    icon={<Icon name="list" size={29} color={theme.colors.text.secondary} />}
                    rightElement={<Icon name={open ? 'caret-up' : 'caret-down'} size={20} color={theme.colors.text.secondary} />}
                    onPress={toggle}
                    showChevron={false}
                    selected={false}
                />
            )}
            items={options.map((opt) => ({
                id: opt.id,
                title: resolveProviderSettingsText(opt.title) ?? '',
                subtitle: resolveProviderSettingsText(opt.subtitle),
                icon: (
                    <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                        <Icon name="radio-button" size={20} color={theme.colors.text.secondary} />
                    </View>
                ),
            }))}
            onSelect={(id) => {
                props.setFieldValue(props.field, id);
                props.setOpen(false);
            }}
        />
    );
});

export const ProviderSettingsMultiEnumField = React.memo(function ProviderSettingsMultiEnumField(props: Readonly<{
    field: ProviderSettingFieldDef;
    value: unknown;
    open: boolean;
    setOpen: (open: boolean) => void;
    popoverBoundaryRef: React.RefObject<unknown>;
    setFieldValue: (field: ProviderSettingFieldDef, value: unknown) => void;
}>) {
    const { theme } = useUnistyles();
    const options = props.field.enumOptions ?? [];

    if (options.length === 0) {
        return (
            <Item
                key={props.field.key}
                testID={`settings-provider-field-${props.field.key}`}
                title={resolveProviderSettingsText(props.field.title) ?? ''}
                subtitle={resolveProviderSettingsText(props.field.subtitle) ?? t('settingsProviders.noOptionsAvailable')}
                icon={<Icon name="list" size={29} color={theme.colors.text.secondary} />}
                showChevron={false}
                disabled={true}
            />
        );
    }

    const selectedRaw = Array.isArray(props.value) ? props.value : [];
    const selectedSet = new Set<string>(
        selectedRaw.filter((v): v is string => typeof v === 'string'),
    );
    const orderedSelectedOptions = options.filter((opt) => selectedSet.has(opt.id));
    const detail =
        orderedSelectedOptions.length === 0
            ? t('common.none')
            : orderedSelectedOptions
                .map((opt) => resolveProviderSettingsText(opt.title))
                .filter((label): label is string => Boolean(label))
                .join(', ');

    return (
        <DropdownMenu
            key={props.field.key}
            open={props.open}
            onOpenChange={props.setOpen}
            variant="selectable"
            search={false}
            selectedId={null}
            showCategoryTitles={false}
            matchTriggerWidth={true}
            connectToTrigger={true}
            rowKind="item"
            popoverBoundaryRef={props.popoverBoundaryRef}
            closeOnSelect={false}
            trigger={({ toggle, open }: { toggle: () => void; open: boolean }) => (
                <Item
                    testID={`settings-provider-field-${props.field.key}`}
                    title={resolveProviderSettingsText(props.field.title) ?? ''}
                    subtitle={resolveProviderSettingsText(props.field.subtitle)}
                    detail={detail}
                    icon={<Icon name="list" size={29} color={theme.colors.text.secondary} />}
                    rightElement={<Icon name={open ? 'caret-up' : 'caret-down'} size={20} color={theme.colors.text.secondary} />}
                    onPress={toggle}
                    showChevron={false}
                    selected={false}
                />
            )}
            items={options.map((opt) => {
                const checked = selectedSet.has(opt.id);
                return {
                    id: opt.id,
                    title: resolveProviderSettingsText(opt.title) ?? '',
                    subtitle: resolveProviderSettingsText(opt.subtitle),
                    icon: (
                        <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                            <Icon
                                name={checked ? 'check-square' : 'square'}
                                size={20}
                                color={theme.colors.text.secondary}
                            />
                        </View>
                    ),
                };
            })}
            onSelect={(id) => {
                const next = new Set(selectedSet);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                const ordered = options.map((opt) => opt.id).filter((optId) => next.has(optId));
                props.setFieldValue(props.field, ordered);
            }}
        />
    );
});
