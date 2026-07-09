import type { ClaudeScreenState } from './screenState';

export type ClaudeUnifiedRecognizedDialogId =
  | 'switch_model'
  | 'usage_limit'
  | 'resume_choice'
  | 'safeguard_pause'
  | 'effort_change';

export type ClaudeUnifiedDialogId = ClaudeUnifiedRecognizedDialogId | 'unrecognized_confirmation';

export type ClaudeUnifiedDialogDetectorStateKey =
  | 'switchModelDialogVisible'
  | 'usageLimitDialogVisible'
  | 'resumeChoiceDialogVisible'
  | 'safeguardPauseDialogVisible'
  | 'effortChangeDialogVisible';

export type ClaudeUnifiedDialogOwner = 'slash_controls';

export type ClaudeUnifiedDialogOwnerRegistration = Readonly<{
  kind: ClaudeUnifiedDialogOwner;
  controlKeys: readonly ('model' | 'reasoningEffort' | 'launchOption')[];
}>;

export type ClaudeUnifiedDialogOption = Readonly<{
  choice: string;
  label: string;
  description: string;
  answer: Readonly<{
    kind: 'literal_then_enter';
    text: string;
  }>;
}>;

export type ClaudeUnifiedRecognizedDialogRegistryEntry = Readonly<{
  dialogId: ClaudeUnifiedRecognizedDialogId;
  detectorStateKey: ClaudeUnifiedDialogDetectorStateKey;
  owner: ClaudeUnifiedDialogOwnerRegistration | null;
  header: string;
  question: string;
  options: (state: ClaudeScreenState) => readonly ClaudeUnifiedDialogOption[];
}>;

export type ClaudeUnifiedVisibleRecognizedDialog = Readonly<{
  kind: 'recognized';
  dialogId: ClaudeUnifiedRecognizedDialogId;
  detectorStateKey: ClaudeUnifiedDialogDetectorStateKey;
  owner: ClaudeUnifiedDialogOwnerRegistration | null;
  header: string;
  question: string;
  options: readonly ClaudeUnifiedDialogOption[];
}>;

export type ClaudeUnifiedVisibleUnrecognizedDialog = Readonly<{
  kind: 'unrecognized';
  dialogId: 'unrecognized_confirmation';
  owner: null;
  notice: 'open_terminal';
}>;

export type ClaudeUnifiedVisibleDialog =
  | ClaudeUnifiedVisibleRecognizedDialog
  | ClaudeUnifiedVisibleUnrecognizedDialog;

function option(
  choice: string,
  label: string,
  description: string,
  text: string,
): ClaudeUnifiedDialogOption {
  return {
    choice,
    label,
    description,
    answer: { kind: 'literal_then_enter', text },
  };
}

export const CLAUDE_UNIFIED_RECOGNIZED_DIALOG_REGISTRY: readonly ClaudeUnifiedRecognizedDialogRegistryEntry[] = Object.freeze([
  {
    dialogId: 'switch_model',
    detectorStateKey: 'switchModelDialogVisible',
    owner: { kind: 'slash_controls', controlKeys: ['model'] },
    header: 'Claude model',
    question: 'Claude is asking whether to switch models.',
    options: () => [
      option('confirm', 'Switch model', 'Confirm Claude\'s model switch.', '1'),
      option('cancel', 'Keep current model', 'Dismiss the model switch.', '2'),
    ],
  },
  {
    dialogId: 'usage_limit',
    detectorStateKey: 'usageLimitDialogVisible',
    owner: null,
    header: 'Claude usage limit',
    question: 'Claude reached a usage limit. What should it do?',
    options: () => [
      option('wait_for_reset', 'Stop and wait', 'Wait for Claude\'s usage limit to reset.', '1'),
      option('upgrade_plan', 'Upgrade plan', 'Continue with Claude\'s plan-upgrade flow.', '2'),
    ],
  },
  {
    dialogId: 'resume_choice',
    detectorStateKey: 'resumeChoiceDialogVisible',
    owner: null,
    header: 'Claude resume',
    question: 'How should Claude resume this session?',
    options: () => [
      option('resume_from_summary', 'Resume from summary', 'Resume faster from Claude\'s saved summary.', '1'),
      option('resume_full_session', 'Resume full session', 'Load the full session context.', '2'),
    ],
  },
  {
    dialogId: 'safeguard_pause',
    detectorStateKey: 'safeguardPauseDialogVisible',
    owner: null,
    header: 'Claude paused',
    question: 'How should Claude continue?',
    options: (state) => state.safeguardPauseDialogOptions.map((dialogOption, index) => option(
      dialogOption.choice,
      dialogOption.label,
      dialogOption.choice === 'switch_model'
        ? 'Send Claude the chooser option to switch models and continue.'
        : 'Send Claude the chooser option to edit the prompt and retry.',
      String(index + 1),
    )),
  },
  {
    dialogId: 'effort_change',
    detectorStateKey: 'effortChangeDialogVisible',
    owner: { kind: 'slash_controls', controlKeys: ['reasoningEffort', 'launchOption'] },
    header: 'Claude effort',
    question: 'Claude is asking whether to change the effort level.',
    options: (state) => {
      const target = state.effortChangeDialogTarget;
      return [
        option(
          'confirm',
          target ? `Switch to ${target}` : 'Change effort',
          'Apply the effort-level change in Claude.',
          '1',
        ),
        option('cancel', 'Keep current effort', 'Dismiss the effort-level change.', '2'),
      ];
    },
  },
]);

const ENTRY_BY_ID = new Map(
  CLAUDE_UNIFIED_RECOGNIZED_DIALOG_REGISTRY.map((entry) => [entry.dialogId, entry] as const),
);

export function getClaudeUnifiedRecognizedDialogRegistryEntry(
  dialogId: ClaudeUnifiedRecognizedDialogId,
): ClaudeUnifiedRecognizedDialogRegistryEntry {
  const entry = ENTRY_BY_ID.get(dialogId);
  if (!entry) throw new Error(`unknown_claude_unified_dialog:${dialogId}`);
  return entry;
}

export function isClaudeUnifiedRegisteredDialogVisible(
  state: ClaudeScreenState,
  entry: ClaudeUnifiedRecognizedDialogRegistryEntry,
): boolean {
  return state[entry.detectorStateKey] === true;
}

export function resolveClaudeUnifiedRegisteredDialogOption(
  state: ClaudeScreenState,
  entry: ClaudeUnifiedRecognizedDialogRegistryEntry,
  choice: string,
): ClaudeUnifiedDialogOption | null {
  return entry.options(state).find((candidate) => candidate.choice === choice) ?? null;
}

export function resolveClaudeUnifiedVisibleDialog(state: ClaudeScreenState): ClaudeUnifiedVisibleDialog | null {
  for (const entry of CLAUDE_UNIFIED_RECOGNIZED_DIALOG_REGISTRY) {
    if (!isClaudeUnifiedRegisteredDialogVisible(state, entry)) continue;
    return {
      kind: 'recognized',
      dialogId: entry.dialogId,
      detectorStateKey: entry.detectorStateKey,
      owner: entry.owner,
      header: entry.header,
      question: entry.question,
      options: entry.options(state),
    };
  }
  if (state.unrecognizedConfirmationDialogVisible) {
    return {
      kind: 'unrecognized',
      dialogId: 'unrecognized_confirmation',
      owner: null,
      notice: 'open_terminal',
    };
  }
  return null;
}

export function hasClaudeUnifiedVisibleDialog(state: ClaudeScreenState): boolean {
  return resolveClaudeUnifiedVisibleDialog(state) !== null;
}
