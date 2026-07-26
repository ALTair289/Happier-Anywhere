import { describe, expect, it } from 'vitest';

import { normalizeAcpPlan } from '../normalizeAcpPlan';

describe('normalizeAcpPlan', () => {
  it('normalizes standard entries without guessing away ids, order, text, or status', () => {
    expect(normalizeAcpPlan({
      providerId: 'test-acp',
      turnId: 'turn-1',
      source: 'standard',
      merge: false,
      items: [
        { id: 'keep-id', content: 'First', priority: 'high', status: 'pending' },
        { title: 'Second', status: 'in_progress' },
        { text: 'Third', status: 'done' },
        { content: 'Cancelled', status: 'canceled' },
        { content: '   ', status: 'pending' },
      ],
    })).toEqual({
      providerId: 'test-acp',
      turnId: 'turn-1',
      source: 'standard',
      merge: false,
      items: [
        { vendorRef: 'keep-id', title: 'First', priority: 'high', status: 'pending', order: 0 },
        { title: 'Second', status: 'active', order: 1 },
        { title: 'Third', status: 'complete', order: 2 },
        { title: 'Cancelled', status: 'cancelled', order: 3 },
      ],
    });
  });

  it('preserves markdown and phase identity while bounding correlation to explicit facts', () => {
    expect(normalizeAcpPlan({
      providerId: 'cursor',
      turnId: 'turn-2',
      correlationId: 'call-2',
      source: 'proprietary',
      merge: true,
      markdown: '# Plan\n\nKeep exact text.',
      items: [{ id: 'todo-1', content: 'Do it', status: 'completed', phaseId: 'phase-a', phaseName: 'Build' }],
    })).toEqual({
      providerId: 'cursor',
      turnId: 'turn-2',
      correlationId: 'call-2',
      source: 'proprietary',
      merge: true,
      markdown: '# Plan\n\nKeep exact text.',
      items: [{
        vendorRef: 'todo-1',
        title: 'Do it',
        status: 'complete',
        order: 0,
        phaseId: 'phase-a',
        phaseName: 'Build',
      }],
    });
  });

  it('keeps an explicit empty replacement as a valid clearing snapshot', () => {
    expect(normalizeAcpPlan({
      providerId: 'cursor',
      turnId: 'turn-clear',
      source: 'proprietary',
      merge: false,
      items: [],
    })?.items).toEqual([]);
  });

  it('preserves exact opaque correlation and vendor ids while rejecting blank ids', () => {
    const normalized = normalizeAcpPlan({
      providerId: 'cursor',
      turnId: 'turn-opaque',
      correlationId: ' plan\n correlation ',
      source: 'proprietary',
      merge: false,
      items: [{ id: ' todo\n id ', content: 'Do it', status: 'pending' }],
    });

    expect(normalized?.correlationId).toBe(' plan\n correlation ');
    expect(normalized?.items[0]?.vendorRef).toBe(' todo\n id ');
    const blankIds = normalizeAcpPlan({
      providerId: 'cursor',
      turnId: 'turn-blank',
      correlationId: '   ',
      source: 'proprietary',
      merge: false,
      items: [{ id: '   ', content: 'Do it', status: 'pending' }],
    });
    expect(blankIds).not.toHaveProperty('correlationId');
    expect(blankIds?.items[0]).not.toHaveProperty('vendorRef');
  });
});
