import type { HandlerContext, HandlerResult, SessionUpdate } from '../types';
import { projectToolCallUpdate } from './projectToolCallUpdate';

export function handleToolCallUpdate(update: SessionUpdate, ctx: HandlerContext): HandlerResult {
  return projectToolCallUpdate(update, ctx, 'tool_call_update');
}
