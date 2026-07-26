import { describe, expect, it } from 'vitest';

import { DefaultTransport } from '@/agent/transport';
import { handlePlanUpdate } from '../events';
import type { HandlerContext, SessionUpdate } from '../types';
import type { NormalizedAcpPlanSnapshot } from '@/agent/acp/plans';

function makeCtx() {
  const emitted: any[] = [];
  const projected: NormalizedAcpPlanSnapshot[] = [];
  const removed: Array<{
    providerId: string;
    turnId: string;
    source: 'standard';
    correlationId: string;
  }> = [];
  const ctx = {
    transport: new DefaultTransport('test-acp'),
    turnId: 'turn-1',
    plans: {
      project: async (snapshot: NormalizedAcpPlanSnapshot) => {
        projected.push(snapshot);
        return { kind: 'published' as const };
      },
      remove: async (input: (typeof removed)[number]) => {
        removed.push(input);
        return { kind: 'published' as const };
      },
    },
    emit: (m: any) => emitted.push(m),
  } as unknown as HandlerContext;
  return { ctx, emitted, projected, removed };
}

describe('handlePlanUpdate (generic ACP plan -> canonical plan owner)', () => {
  it('routes a standard full snapshot without emitting synthetic TodoWrite transcript rows', async () => {
    const { ctx, emitted, projected } = makeCtx();
    const update: SessionUpdate = {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Analyze the codebase', priority: 'high', status: 'pending' },
        { content: 'Write tests', priority: 'medium', status: 'in_progress' },
        { content: 'Ship it', priority: 'low', status: 'completed' },
      ],
    };

    const result = await handlePlanUpdate(update, ctx);

    expect(result).toEqual({ handled: true });
    expect(emitted).toHaveLength(0);
    expect(projected).toEqual([{
      providerId: 'test-acp',
      turnId: 'turn-1',
      source: 'standard',
      merge: false,
      items: [
        { title: 'Analyze the codebase', status: 'pending', priority: 'high', order: 0 },
        { title: 'Write tests', status: 'active', priority: 'medium', order: 1 },
        { title: 'Ship it', status: 'complete', priority: 'low', order: 2 },
      ],
    }]);
  });

  it('routes every standard update as full replacement through one owner', async () => {
    const { ctx, projected } = makeCtx();
    await handlePlanUpdate({ sessionUpdate: 'plan', entries: [{ content: 'a', status: 'pending' }] }, ctx);
    await handlePlanUpdate({ sessionUpdate: 'plan', entries: [{ content: 'a', status: 'completed' }] }, ctx);
    expect(projected.map((snapshot) => snapshot.items[0]?.status)).toEqual(['pending', 'complete']);
  });

  it('routes stable item, markdown, and file plan updates as exact-id full replacements', async () => {
    const { ctx, projected } = makeCtx();

    await handlePlanUpdate({
      sessionUpdate: 'plan_update',
      plan: {
        type: 'items',
        planId: ' plan-id ',
        entries: [{ content: 'Implement', status: 'in_progress' }],
      },
    }, ctx);
    await handlePlanUpdate({
      sessionUpdate: 'plan_update',
      plan: { type: 'markdown', planId: ' plan-id ', content: '# Revised plan' },
    }, ctx);
    await handlePlanUpdate({
      sessionUpdate: 'plan_update',
      plan: { type: 'file', planId: ' plan-id ', uri: 'file:///workspace/PLAN.md' },
    }, ctx);

    expect(projected).toEqual([
      {
        providerId: 'test-acp',
        turnId: 'turn-1',
        correlationId: ' plan-id ',
        source: 'standard',
        merge: false,
        items: [{ title: 'Implement', status: 'active', order: 0 }],
      },
      {
        providerId: 'test-acp',
        turnId: 'turn-1',
        correlationId: ' plan-id ',
        source: 'standard',
        merge: false,
        markdown: '# Revised plan',
        items: [],
      },
      {
        providerId: 'test-acp',
        turnId: 'turn-1',
        correlationId: ' plan-id ',
        source: 'standard',
        merge: false,
        fileUri: 'file:///workspace/PLAN.md',
        items: [],
      },
    ]);
  });

  it('routes stable plan removal to the canonical owner using the exact plan id', async () => {
    const { ctx, projected, removed } = makeCtx();

    await expect(handlePlanUpdate({
      sessionUpdate: 'plan_removed',
      planId: ' plan-id ',
    }, ctx)).resolves.toEqual({ handled: true });

    expect(projected).toHaveLength(0);
    expect(removed).toEqual([{
      providerId: 'test-acp',
      turnId: 'turn-1',
      source: 'standard',
      correlationId: ' plan-id ',
    }]);
  });

  it('returns not-handled when there is no plan payload', async () => {
    const { ctx, emitted } = makeCtx();
    await expect(handlePlanUpdate({ sessionUpdate: 'tool_call' }, ctx)).resolves.toEqual({ handled: false });
    expect(emitted).toHaveLength(0);
  });
});
