import * as React from 'react';
import { Pressable } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { ActivitySpinner, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import { IconAction } from '@/components/ui/buttons/IconAction';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import type { ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import { applyFileDiscardAction } from '@/scm/operations/applyFileDiscardAction';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t } from '@/text';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';

export type ScmChangeDiscardButtonProps = Readonly<{
    sessionId: string;
    sessionPath: string | null;
    snapshot: ScmWorkingSnapshot | null;
    scmWriteEnabled: boolean;
    commitStrategy: ScmCommitStrategy;
    file: ScmFileStatus;
    surface: 'file' | 'files';
    onAfterDiscard?: () => void | Promise<void>;
}>;

const DISCARD_ICON_SIZE_PX = 14;

export const ScmChangeDiscardButton = React.memo((props: ScmChangeDiscardButtonProps) => {
    const { theme } = useUnistyles();
    const [busy, setBusy] = React.useState(false);

    const supported = props.snapshot?.capabilities?.writeDiscard === true;
    const disabled = busy || !props.scmWriteEnabled || !supported;

    return (
        <IconAction
            size="sm"
            testID={`scm-discard-${toTestIdSafeValue(props.file.fullPath)}`}
            accessibilityLabel={t('files.discardChangesFor', { path: props.file.fullPath })}
            disabled={disabled}
            onPress={(e: any) => {
                e?.stopPropagation?.();
                fireAndForget((async () => {
                    setBusy(true);
                    try {
                        await applyFileDiscardAction({
                            sessionId: props.sessionId,
                            sessionPath: props.sessionPath,
                            file: props.file,
                            snapshot: props.snapshot,
                            scmWriteEnabled: props.scmWriteEnabled,
                            commitStrategy: props.commitStrategy,
                            surface: props.surface,
                        });
                        await props.onAfterDiscard?.();
                    } finally {
                        setBusy(false);
                    }
                })(), { tag: 'ScmChangeDiscardButton.onPress' });
            }}
        >
            {busy ? (
                <ActivitySpinner size={iconMatchedSpinnerSize(DISCARD_ICON_SIZE_PX)} color={theme.colors.text.secondary} />
            ) : (
                <Octicons name="history" size={DISCARD_ICON_SIZE_PX} color={theme.colors.text.secondary} />
            )}
        </IconAction>
    );
});
