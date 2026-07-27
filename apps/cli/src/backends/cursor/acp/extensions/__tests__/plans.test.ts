import { describe, expect, it } from 'vitest';

import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { extractCursorPlanMarkdown, handleCursorCreatePlan } from '../plans';

function permissionHandler(decision: 'approved' | 'denied' | 'abort'): AcpPermissionHandler {
  return { async handleToolCall() { return { decision }; } };
}

const context = {
  method: 'cursor/create_plan',
  sessionId: 'session-1',
  signal: new AbortController().signal,
  agentName: 'cursor',
} as const;

describe('Cursor create-plan extension', () => {
  it('uses a bounded fallback when Cursor omits plan prose', () => {
    expect(extractCursorPlanMarkdown({})).toBe('# Plan\n\n(Cursor did not supply plan text.)');
  });

  it.each([
    ['approved', { outcome: { outcome: 'accepted' } }],
    ['denied', { outcome: { outcome: 'rejected' } }],
    ['abort', { outcome: { outcome: 'cancelled' } }],
  ] as const)('maps %s to the exact Cursor outcome envelope', async (decision, expected) => {
    await expect(handleCursorCreatePlan({
      request: { toolCallId: 'plan-1', plan: '# Plan', todos: [] },
      context,
      permissionHandler: permissionHandler(decision),
    })).resolves.toEqual(expected);
  });

  it('returns a validated optional plan URI on acceptance', async () => {
    await expect(handleCursorCreatePlan({
      request: { toolCallId: 'plan-1', plan: '# Plan', todos: [] },
      context,
      permissionHandler: permissionHandler('approved'),
      planUri: 'file:///tmp/plan.md',
    })).resolves.toEqual({ outcome: { outcome: 'accepted', planUri: 'file:///tmp/plan.md' } });
  });

  it('returns the cancelled envelope when the extension request signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort(Object.assign(new Error('turn ended'), { name: 'AbortError' }));
    let permissionCalls = 0;

    await expect(handleCursorCreatePlan({
      request: { toolCallId: 'plan-aborted', plan: '# Plan', todos: [] },
      context: { ...context, signal: controller.signal },
      permissionHandler: {
        async handleToolCall() {
          permissionCalls += 1;
          return { decision: 'approved' };
        },
      },
    })).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    expect(permissionCalls).toBe(0);
  });
});
