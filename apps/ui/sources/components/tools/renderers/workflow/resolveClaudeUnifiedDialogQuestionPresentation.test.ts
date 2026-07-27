import { describe, expect, it } from 'vitest';

import { resolveClaudeUnifiedDialogQuestionPresentation } from './resolveClaudeUnifiedDialogQuestionPresentation';

describe('resolveClaudeUnifiedDialogQuestionPresentation', () => {
    it('localizes the typed unknown-dialog notice without presenting terminal navigation as an answer', () => {
        const input = {
            happierDialog: {
                kind: 'unrecognized',
                mode: 'notice',
                dialogId: 'unrecognized_confirmation',
                action: 'open_terminal',
            },
            questions: [{
                header: 'Claude dialog',
                question: 'Claude is showing a dialog. Open the terminal to continue.',
                multiSelect: false,
                options: [{
                    choice: 'open_terminal',
                    label: 'Open terminal',
                    description: 'Open the terminal to continue.',
                }],
            }],
        };

        const resolved = resolveClaudeUnifiedDialogQuestionPresentation(input, (key) => `translated:${key}`);

        expect(resolved.questions[0]).toEqual({
            header: 'translated:tools.askUserQuestion.claudeDialogNotice.header',
            question: 'translated:tools.askUserQuestion.claudeDialogNotice.question',
            multiSelect: false,
            options: [],
        });
    });

    it('leaves ordinary provider questions unchanged', () => {
        const input = {
            questions: [{
                header: 'Question',
                question: 'Continue?',
                multiSelect: false,
                options: [{ label: 'Yes', description: 'Continue' }],
            }],
        };

        expect(resolveClaudeUnifiedDialogQuestionPresentation(input, () => 'translated')).toBe(input);
    });
});
