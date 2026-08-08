import type { TerminalPromptSubmitVerificationPolicy } from '@/integrations/terminalHost/promptSubmitVerification';
import { normalizeCapturedScreen } from '@/integrations/terminalHost/controlCapture';

import {
  parseClaudePastedTextMarkerLineCount,
  pastedTextLineCountMatchesPrompt,
} from './claudePastedTextMarker';
import { parseClaudeScreenState } from './tuiControls/screenState';

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

const COMPOSER_LINE_PROMPT = /(?:^|[│|]\s*)[>›❯](?!\s*(?:\d+\.|[◯◉○●◐◑]))/u;

function readCurrentPastedTextLineCount(screenText: string): number | null {
  const lines = normalizeCapturedScreen(screenText).split('\n');
  let lastContentLineIndex = lines.length - 1;
  while (lastContentLineIndex >= 0 && lines[lastContentLineIndex]?.trim().length === 0) {
    lastContentLineIndex -= 1;
  }

  for (let index = lastContentLineIndex; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    const pastedLineCount = parseClaudePastedTextMarkerLineCount(line);
    if (pastedLineCount === null) continue;

    if (index === lastContentLineIndex || COMPOSER_LINE_PROMPT.test(line)) {
      return pastedLineCount;
    }
    return null;
  }
  return null;
}

function isLikelyTerminalFooterLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^[─━═┄┈\-\s]+$/.test(trimmed)) return true;
  if (/^(?:▶+|▸+|⏵+|>>)\s/.test(trimmed)) return true;
  return false;
}

function readPostSubmitPastedTextLineCount(screenText: string): number | null {
  const lines = normalizeCapturedScreen(screenText).split('\n');
  let lastContentLineIndex = lines.length - 1;
  while (lastContentLineIndex >= 0 && lines[lastContentLineIndex]?.trim().length === 0) {
    lastContentLineIndex -= 1;
  }
  if (lastContentLineIndex < 0) return null;

  const bottomLineCount = parseClaudePastedTextMarkerLineCount(lines[lastContentLineIndex] ?? '');
  if (bottomLineCount !== null) return bottomLineCount;

  for (let index = lastContentLineIndex - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    const pastedLineCount = parseClaudePastedTextMarkerLineCount(line);
    if (pastedLineCount === null) continue;
    if (!COMPOSER_LINE_PROMPT.test(line)) return null;

    for (let after = index + 1; after <= lastContentLineIndex; after += 1) {
      const afterLine = lines[after] ?? '';
      if (COMPOSER_LINE_PROMPT.test(afterLine)) return null;
      if (!isLikelyTerminalFooterLine(afterLine)) return null;
    }
    return pastedLineCount;
  }
  return null;
}

function shouldVerifyBeforeSubmit(promptText: string): boolean {
  return normalizeNewlines(promptText).trim().length > 0;
}

function shouldVerifyAfterSubmit(promptText: string): boolean {
  return normalizeNewlines(promptText).trim().length > 0;
}

function verifyScreenBeforeSubmit(params: Readonly<{
  promptText: string;
  screenText: string;
}>): boolean {
  const promptText = normalizeNewlines(params.promptText).trim();
  const screenText = normalizeNewlines(params.screenText);
  const composerContent = parseClaudeScreenState(screenText).composerContent;
  if (
    promptText.length > 0
    && composerContent !== null
    && normalizeNewlines(composerContent).trim() === promptText
  ) {
    return true;
  }

  const pastedLineCount = readCurrentPastedTextLineCount(screenText);
  if (pastedLineCount === null) return false;

  return pastedTextLineCountMatchesPrompt({ promptText, pastedLineCount });
}

function isPromptStillPendingAfterSubmit(params: Readonly<{
  promptText: string;
  screenText: string;
}>): boolean {
  const promptText = normalizeNewlines(params.promptText);
  const screenText = normalizeNewlines(params.screenText);
  const pastedLineCount = readPostSubmitPastedTextLineCount(screenText);
  if (pastedLineCount === null) return false;
  return pastedTextLineCountMatchesPrompt({ promptText, pastedLineCount });
}

function isExactPromptStillInComposerAfterSubmit(params: Readonly<{
  promptText: string;
  screenText: string;
}>): boolean {
  const promptText = normalizeNewlines(params.promptText).trim();
  if (!promptText) return false;
  const state = parseClaudeScreenState(params.screenText);
  const composerContent = state.composerContent === null
    ? null
    : normalizeNewlines(state.composerContent).trim();
  return composerContent === promptText;
}

export function createClaudePromptSubmitVerificationPolicy(): TerminalPromptSubmitVerificationPolicy {
  return {
    shouldVerifyBeforeSubmit,
    shouldVerifyAfterSubmit,
    verifyScreenBeforeSubmit,
    isPromptStillPendingAfterSubmit: (params) => (
      isPromptStillPendingAfterSubmit(params)
      || isExactPromptStillInComposerAfterSubmit(params)
    ),
  };
}
