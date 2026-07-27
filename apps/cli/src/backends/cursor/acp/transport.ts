import { DefaultTransport } from '@/agent/transport';

import { sanitizeCursorDiffContent } from '../utils/sanitizeCursorDiffContent';

export class CursorTransport extends DefaultTransport {
  constructor() {
    super('cursor');
  }

  override getToolCallTimeout(_toolCallId?: string, _toolKind?: string): number | null {
    return null;
  }

  override sanitizeToolUpdateContent<T extends { content?: unknown }>(update: T): T {
    return sanitizeCursorDiffContent(update);
  }

  override determineToolName(
    toolName: string,
    _toolCallId: string,
    input: Record<string, unknown>,
  ): string {
    const cursorToolName = typeof input._toolName === 'string' ? input._toolName : '';
    if (cursorToolName === 'task') return 'Task';
    if (cursorToolName === 'createPlan') return 'ExitPlanMode';
    const acp = input._acp && typeof input._acp === 'object' && !Array.isArray(input._acp)
      ? input._acp as Record<string, unknown>
      : null;
    const title = typeof acp?.title === 'string' ? acp.title.trim().toLowerCase() : '';
    if (title === 'task' || title.startsWith('task ')) return 'Task';
    if (title === 'create plan') return 'ExitPlanMode';
    return toolName;
  }
}

export const cursorTransport = new CursorTransport();
