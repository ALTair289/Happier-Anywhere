import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SelectionListOption, SelectionListProps } from '@/components/ui/selectionList';
import { renderScreen } from '@/dev/testkit';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const textSpies = vi.hoisted(() => ({
    translate: vi.fn((key: string, _params?: Record<string, unknown>) => key),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: textSpies.translate as never });
});

const capturedSelectionLists: SelectionListProps[] = [];

vi.mock('@/components/ui/selectionList', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/ui/selectionList')>();
    return {
        ...actual,
        SelectionList: (props: SelectionListProps) => {
            capturedSelectionLists.push(props);
            return React.createElement('SelectionList', { testID: props.testID });
        },
    };
});

const CANDIDATES = [
    { profileId: 'work', title: 'Work', subtitle: 'work@example.com' },
    { profileId: 'backup', title: 'Backup', subtitle: 'backup@example.com' },
    { profileId: 'extra', title: 'Extra', subtitle: 'extra@example.com' },
] as const;

function latestListProps(): SelectionListProps {
    const props = capturedSelectionLists[capturedSelectionLists.length - 1];
    if (!props) throw new Error('SelectionList was not rendered');
    return props;
}

function optionById(id: string): SelectionListOption {
    for (const section of latestListProps().rootStep.sections) {
        if (section.kind !== 'static') continue;
        const option = section.options.find((candidate) => candidate.id === id);
        if (option) return option;
    }
    throw new Error(`option not found: ${id}`);
}

function isSelected(id: string): boolean {
    return optionById(id).rightAccessory != null;
}

async function renderEditor(overrides: Partial<{
    initialSelectedProfileIds: ReadonlyArray<string>;
    onSubmit: (next: ReadonlyArray<string>) => void;
    onClose: () => void;
}> = {}) {
    capturedSelectionLists.length = 0;
    const onSubmit = overrides.onSubmit ?? vi.fn();
    const onClose = overrides.onClose ?? vi.fn();
    const { PoolMembershipEditorModal } = await import('./PoolMembershipEditorModal');
    const screen = await renderScreen(
        <PoolMembershipEditorModal
            candidates={CANDIDATES}
            initialSelectedProfileIds={overrides.initialSelectedProfileIds ?? ['work', 'backup']}
            onSubmit={onSubmit}
            onClose={onClose}
        />,
    );
    return { screen, onSubmit, onClose };
}

async function toggle(screen: Awaited<ReturnType<typeof renderEditor>>['screen'], id: string) {
    const list = latestListProps();
    await act(async () => {
        list.onSelect(id, optionById(id));
        await Promise.resolve();
    });
}

beforeEach(() => {
    textSpies.translate.mockClear();
    capturedSelectionLists.length = 0;
});

describe('PoolMembershipEditorModal', () => {
    it('presents every candidate as a searchable row with the profiles search placeholder', async () => {
        await renderEditor();
        const list = latestListProps();

        expect(list.rootStep.inputPlaceholder).toBe(
            'connectedServices.detail.groupActions.searchMembersPlaceholder',
        );
        const ids = list.rootStep.sections
            .flatMap((section) => (section.kind === 'static' ? section.options : []))
            .map((option) => option.id);
        expect(ids).toEqual(['work', 'backup', 'extra']);
    });

    it('pre-checks the initial members and shows the enabled/total subtitle', async () => {
        await renderEditor({ initialSelectedProfileIds: ['work', 'backup'] });

        expect(isSelected('work')).toBe(true);
        expect(isSelected('backup')).toBe(true);
        expect(isSelected('extra')).toBe(false);
        expect(textSpies.translate).toHaveBeenCalledWith(
            'connectedServices.detail.groupDetail.membersSubtitle',
            { enabled: 2, total: 3 },
        );
    });

    it('multi-selects: toggling checks an unselected row and unchecks a selected one', async () => {
        const { screen } = await renderEditor({ initialSelectedProfileIds: ['work', 'backup'] });

        await toggle(screen, 'extra');
        expect(isSelected('extra')).toBe(true);

        await toggle(screen, 'backup');
        expect(isSelected('backup')).toBe(false);
    });

    it('confirm submits the exact target selection (batch add + remove) and closes', async () => {
        const { screen, onSubmit, onClose } = await renderEditor({ initialSelectedProfileIds: ['work', 'backup'] });

        await toggle(screen, 'extra');
        await toggle(screen, 'backup');

        await screen.pressByTestIdAsync('pool-membership-editor:confirm');

        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledWith(['work', 'extra']);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('cancel applies nothing and closes', async () => {
        const { screen, onSubmit, onClose } = await renderEditor({ initialSelectedProfileIds: ['work', 'backup'] });

        await toggle(screen, 'extra');
        await screen.pressByTestIdAsync('pool-membership-editor:cancel');

        expect(onSubmit).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
