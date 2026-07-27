import type {
  AcpExtensionHandlerContext,
  AcpPermissionHandler,
} from '@/agent/acp/AcpBackend';

import type {
  CursorAskQuestionRequest,
  CursorAskQuestionResponse,
} from './schemas';
import {
  awaitCursorPermissionDecision,
  isApprovedCursorPermission,
  isCursorExtensionCancellation,
  type CursorPermissionDecision,
} from './permission';

export function buildCursorAskQuestionInput(
  request: CursorAskQuestionRequest,
): Record<string, unknown> {
  const title = request.title?.trim() || 'Question';
  return {
    questions: request.questions.map((question) => {
      const options = question.options ?? [];
      return {
        id: question.id,
        header: title,
        question: question.prompt.trim(),
        multiSelect: question.allowMultiple === true,
        options: options.map((option) => ({
          choice: option.id,
          label: option.label,
          description: option.label,
        })),
        ...(options.length === 0 ? { freeform: {} } : {}),
      };
    }),
  };
}

function buildAnsweredOutcome(
  request: CursorAskQuestionRequest,
  decision: CursorPermissionDecision,
): CursorAskQuestionResponse {
  const answers = decision.answers ?? {};
  const mapped = request.questions.flatMap((question) => {
    const answer = answers[question.id] ?? answers[question.prompt];
    if (!Array.isArray(answer) || answer.length === 0) return [];

    const options = question.options ?? [];
    const optionIds = new Set(options.map((option) => option.id));
    const selectedValues = question.allowMultiple === true ? answer : answer.slice(0, 1);
    const selectedOptionIds = optionIds.size === 0
      ? selectedValues
      : selectedValues.flatMap((value) => {
          if (optionIds.has(value)) return [value];
          const labelMatches = options.filter((option) => option.label === value);
          return labelMatches.length === 1 ? [labelMatches[0]!.id] : [];
        });
    if (selectedOptionIds.length === 0) return [];
    return [{ questionId: question.id, selectedOptionIds }];
  });

  return mapped.length > 0
    ? { outcome: { outcome: 'answered', answers: mapped } }
    : { outcome: { outcome: 'skipped' } };
}

export async function handleCursorAskQuestion(params: Readonly<{
  request: CursorAskQuestionRequest;
  context: AcpExtensionHandlerContext;
  permissionHandler: AcpPermissionHandler;
}>): Promise<CursorAskQuestionResponse> {
  const toolCallId = params.request.toolCallId ?? `cursor-ask-${crypto.randomUUID()}`;
  let decision: CursorPermissionDecision;
  try {
    decision = await awaitCursorPermissionDecision(
      () => params.permissionHandler.handleToolCall(
        toolCallId,
        'AskUserQuestion',
        buildCursorAskQuestionInput(params.request),
      ),
      params.context,
    );
  } catch (error) {
    if (isCursorExtensionCancellation(error, params.context)) {
      return { outcome: { outcome: 'cancelled' } };
    }
    throw error;
  }

  if (decision.decision === 'abort') {
    return { outcome: { outcome: 'cancelled' } };
  }
  if (!isApprovedCursorPermission(decision)) {
    return { outcome: { outcome: 'skipped' } };
  }
  return buildAnsweredOutcome(params.request, decision);
}
