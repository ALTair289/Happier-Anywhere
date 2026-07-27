import type {
  AcpExtensionHandlerContext,
  AcpPermissionHandler,
} from '@/agent/acp/AcpBackend';

import {
  cursorCreatePlanResponseSchema,
  type CursorCreatePlanRequest,
  type CursorCreatePlanResponse,
} from './schemas';
import {
  awaitCursorPermissionDecision,
  isApprovedCursorPermission,
  isCursorExtensionCancellation,
  type CursorPermissionDecision,
} from './permission';

export function extractCursorPlanMarkdown(request: CursorCreatePlanRequest): string {
  return request.plan?.trim() || '# Plan\n\n(Cursor did not supply plan text.)';
}

export function buildCursorExitPlanModeInput(
  request: CursorCreatePlanRequest,
): Record<string, unknown> {
  return {
    plan: extractCursorPlanMarkdown(request),
    name: request.name?.trim() ?? '',
    overview: request.overview?.trim() ?? '',
    isProject: request.isProject === true,
  };
}

export async function handleCursorCreatePlan(params: Readonly<{
  request: CursorCreatePlanRequest;
  context: AcpExtensionHandlerContext;
  permissionHandler: AcpPermissionHandler;
  planUri?: string;
}>): Promise<CursorCreatePlanResponse> {
  const toolCallId = params.request.toolCallId ?? `cursor-plan-${crypto.randomUUID()}`;
  let decision: CursorPermissionDecision;
  try {
    decision = await awaitCursorPermissionDecision(
      () => params.permissionHandler.handleToolCall(
        toolCallId,
        'ExitPlanMode',
        buildCursorExitPlanModeInput(params.request),
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
    return { outcome: { outcome: 'rejected' } };
  }
  return cursorCreatePlanResponseSchema.parse({
    outcome: {
      outcome: 'accepted',
      ...(params.planUri ? { planUri: params.planUri } : {}),
    },
  });
}
