import type { HandlerContext } from '../types';

export function markToolCallWaitingForPermission(toolCallId: string, ctx: HandlerContext): void {
  ctx.toolCalls.markWaitingForPermission(toolCallId);
}

export function markToolCallRunningAfterPermission(toolCallId: string, ctx: HandlerContext): void {
  ctx.toolCalls.markRunning(toolCallId);
}
