export type ClaudeUnifiedDialogQuestionInput = Readonly<{
    happierDialog?: unknown;
    questions: readonly Readonly<{
        header: string;
        question: string;
        multiSelect: boolean;
        options: readonly Readonly<{
            choice?: string | undefined;
            label: string;
            description: string;
        }>[];
    }>[];
}>;

type ClaudeUnifiedDialogNoticeTranslationKey =
    | 'tools.askUserQuestion.claudeDialogNotice.header'
    | 'tools.askUserQuestion.claudeDialogNotice.question'
    | 'tools.askUserQuestion.claudeDialogNotice.openTerminal'
    | 'tools.askUserQuestion.claudeDialogNotice.description';

export function isClaudeUnifiedOpenTerminalNotice(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const dialog = value as Record<string, unknown>;
    return dialog.kind === 'unrecognized'
        && dialog.mode === 'notice'
        && dialog.dialogId === 'unrecognized_confirmation'
        && dialog.action === 'open_terminal';
}

export function hasClaudeUnifiedOpenTerminalSecondaryAction(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const dialog = value as Record<string, unknown>;
    const supportedEnvelope = dialog.kind === 'recognized'
        || (dialog.kind === 'unrecognized'
            && dialog.mode === 'generic'
            && dialog.dialogId === 'unrecognized_confirmation'
            && typeof dialog.signature === 'string');
    return supportedEnvelope && dialog.secondaryAction === 'open_terminal';
}

export function resolveClaudeUnifiedDialogQuestionPresentation<T extends ClaudeUnifiedDialogQuestionInput>(
    input: T,
    translate: (key: ClaudeUnifiedDialogNoticeTranslationKey) => string,
): ClaudeUnifiedDialogQuestionInput {
    if (!isClaudeUnifiedOpenTerminalNotice(input.happierDialog)) return input;
    const firstQuestion = input.questions[0];
    if (!firstQuestion) return input;
    return {
        ...input,
        questions: [{
            ...firstQuestion,
            header: translate('tools.askUserQuestion.claudeDialogNotice.header'),
            question: translate('tools.askUserQuestion.claudeDialogNotice.question'),
            options: [],
        }],
    };
}
