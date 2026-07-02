import type { ClaudeScreenState } from './tuiControls/screenState';
import { isClaudeComposerCaptureStyleUnavailablePlaceholderCandidate } from './tuiControls/composerCaptureClassification';
import { isControllerTypedSlashCommandResidue } from './tuiControls/slashControls';

export type ClaudeOwnComposerDraftClassification =
  | 'empty'
  | 'own'
  | 'foreign'
  | 'capture_style_unavailable'
  | 'generating';

export function classifyClaudeOwnComposerDraft(params: Readonly<{
  screen: ClaudeScreenState;
  rawText: string;
  ownComposerTexts: Readonly<{ matches: (draft: string) => boolean }>;
  /** Clear-key guards must short-circuit on generation; read-only evaluators may still classify. */
  stopOnGenerating?: boolean | undefined;
}>): ClaudeOwnComposerDraftClassification {
  const content = params.screen.composerContent ?? '';
  if (content.length === 0) return 'empty';
  if (params.stopOnGenerating !== false && params.screen.generating) return 'generating';
  if (params.ownComposerTexts.matches(content)) return 'own';
  // Controller-typed slash commands are echo-suppressed out of the persisted transcript, so a
  // respawned registry can never exact-match their residue. The finite controller vocabulary
  // (/model, /effort) is still our own text and stays clearable; everything else stays foreign.
  if (isControllerTypedSlashCommandResidue(content)) return 'own';
  if (isClaudeComposerCaptureStyleUnavailablePlaceholderCandidate(params.rawText, params.screen)) {
    return 'capture_style_unavailable';
  }
  return 'foreign';
}
