import { describe, expect, it } from 'vitest';

import { AcpPlanProjection } from '../AcpPlanProjection';
import { normalizeAcpPlan } from '../normalizeAcpPlan';
import type { NormalizedAcpPlanSnapshot } from '../types';

function plan(overrides: Partial<NormalizedAcpPlanSnapshot> = {}): NormalizedAcpPlanSnapshot {
  return normalizeAcpPlan({
    providerId: 'cursor',
    turnId: 'turn-1',
    correlationId: 'plan-call-1',
    source: 'proprietary',
    merge: false,
    items: [{ id: 'a', content: 'Analyze', status: 'pending' }],
    ...overrides,
  })!;
}

describe('AcpPlanProjection', () => {
  it('publishes once for an identical snapshot and preserves a byte-identical plan in a new turn', async () => {
    const published: NormalizedAcpPlanSnapshot[] = [];
    const projection = new AcpPlanProjection({ publish: (snapshot) => { published.push(snapshot); } });
    const first = plan();

    expect((await projection.project(first)).kind).toBe('published');
    expect((await projection.project(first)).kind).toBe('duplicate');
    projection.finalizeTurn('turn-1');
    expect((await projection.project(first)).kind).toBe('late');

    expect((await projection.project(plan({ turnId: 'turn-2', correlationId: 'plan-call-2' }))).kind).toBe('published');
    expect(published).toHaveLength(2);
  });

  it('uses richer proprietary state regardless of standard/proprietary arrival order', async () => {
    const standard = plan({
      source: 'standard',
      correlationId: undefined,
      items: [{ title: 'Analyze', status: 'pending', order: 0 }],
    });
    const proprietary = plan({
      source: 'proprietary',
      items: [{ vendorRef: 'a', title: 'Analyze', status: 'active', order: 0 }],
      markdown: '# Plan',
    });

    const standardFirst: NormalizedAcpPlanSnapshot[] = [];
    const projectionA = new AcpPlanProjection({ publish: (snapshot) => { standardFirst.push(snapshot); } });
    await projectionA.project(standard);
    await projectionA.project(proprietary);
    expect(standardFirst.at(-1)).toEqual(proprietary);

    const proprietaryFirst: NormalizedAcpPlanSnapshot[] = [];
    const projectionB = new AcpPlanProjection({ publish: (snapshot) => { proprietaryFirst.push(snapshot); } });
    await projectionB.project(proprietary);
    expect((await projectionB.project(standard)).kind).toBe('shadowed');
    expect(proprietaryFirst).toEqual([proprietary]);
  });

  it('implements explicit replace, id-aware merge, removal, reordering, and empty clearing', async () => {
    const published: NormalizedAcpPlanSnapshot[] = [];
    const projection = new AcpPlanProjection({ publish: (snapshot) => { published.push(snapshot); } });
    await projection.project(plan({
      items: [
        { vendorRef: 'a', title: 'A', status: 'pending', order: 0 },
        { vendorRef: 'b', title: 'B', status: 'pending', order: 1 },
      ],
    }));

    await projection.project(plan({
      merge: true,
      items: [
        { vendorRef: 'b', title: 'B', status: 'complete', order: 0 },
        { vendorRef: 'c', title: 'C', status: 'active', order: 1 },
      ],
    }));
    expect(published.at(-1)?.items).toEqual([
      { vendorRef: 'a', title: 'A', status: 'pending', order: 0 },
      { vendorRef: 'b', title: 'B', status: 'complete', order: 1 },
      { vendorRef: 'c', title: 'C', status: 'active', order: 2 },
    ]);

    await projection.project(plan({
      merge: false,
      items: [{ vendorRef: 'c', title: 'C', status: 'complete', order: 0 }],
    }));
    expect(published.at(-1)?.items.map((item) => item.vendorRef)).toEqual(['c']);

    await projection.project(plan({ merge: false, items: [] }));
    expect(published.at(-1)?.items).toEqual([]);
  });

  it('treats an exactly repeated id-less merge delivery as idempotent without weakening append semantics', async () => {
    const published: NormalizedAcpPlanSnapshot[] = [];
    const projection = new AcpPlanProjection({ publish: (snapshot) => { published.push(snapshot); } });
    const seed = plan({
      items: [{ title: 'Existing', status: 'pending', order: 0 }],
    });
    const append = plan({
      correlationId: 'todo-update-1',
      merge: true,
      items: [{ title: 'New id-less item', status: 'active', order: 0 }],
    });

    expect((await projection.project(seed)).kind).toBe('published');
    expect((await projection.project(append)).kind).toBe('published');
    expect((await projection.project(append)).kind).toBe('duplicate');
    expect(published).toHaveLength(2);
    expect(published.at(-1)?.items.map((item) => item.title)).toEqual([
      'Existing',
      'New id-less item',
    ]);

    expect((await projection.project({
      ...append,
      correlationId: 'todo-update-2',
    })).kind).toBe('published');
    expect(published.at(-1)?.items.map((item) => item.title)).toEqual([
      'Existing',
      'New id-less item',
      'New id-less item',
    ]);
  });

  it('retries an identical merge after publication failure instead of acknowledging its fingerprint', async () => {
    let attempts = 0;
    const projection = new AcpPlanProjection({
      publish: () => {
        attempts += 1;
        if (attempts === 2) throw new Error('merge publication failed');
      },
    });
    await projection.project(plan());
    const merge = plan({
      correlationId: 'todo-update-retry',
      merge: true,
      items: [{ title: 'Retry me', status: 'active', order: 0 }],
    });

    await expect(projection.project(merge)).rejects.toThrow('merge publication failed');
    await expect(projection.project(merge)).resolves.toMatchObject({ kind: 'published' });
    expect(attempts).toBe(3);
  });

  it('deduplicates canonical-equivalent objects but republishes changed text, status, and order', async () => {
    const published: NormalizedAcpPlanSnapshot[] = [];
    const projection = new AcpPlanProjection({ publish: (snapshot) => { published.push(snapshot); } });
    const first = plan({
      items: [
        { vendorRef: 'a', title: 'Analyze', status: 'pending', order: 0 },
        { vendorRef: 'b', title: 'Implement', status: 'pending', order: 1 },
      ],
    });

    expect((await projection.project(first)).kind).toBe('published');
    expect((await projection.project({
      ...first,
      items: first.items.map((item) => ({
        order: item.order,
        status: item.status,
        title: item.title,
        vendorRef: item.vendorRef,
      })),
    })).kind).toBe('duplicate');

    expect((await projection.project(plan({
      items: [
        { vendorRef: 'a', title: 'Analyze deeply', status: 'pending', order: 0 },
        { vendorRef: 'b', title: 'Implement', status: 'pending', order: 1 },
      ],
    }))).kind).toBe('published');
    expect((await projection.project(plan({
      items: [
        { vendorRef: 'a', title: 'Analyze deeply', status: 'active', order: 0 },
        { vendorRef: 'b', title: 'Implement', status: 'pending', order: 1 },
      ],
    }))).kind).toBe('published');
    expect((await projection.project(plan({
      items: [
        { vendorRef: 'b', title: 'Implement', status: 'pending', order: 0 },
        { vendorRef: 'a', title: 'Analyze deeply', status: 'active', order: 1 },
      ],
    }))).kind).toBe('published');
    expect(published).toHaveLength(4);
  });

  it('publishes an explicit return to a previously seen state while deduplicating the current state', async () => {
    const published: NormalizedAcpPlanSnapshot[] = [];
    const projection = new AcpPlanProjection({ publish: (snapshot) => { published.push(snapshot); } });
    const pending = plan({
      merge: true,
      items: [{ vendorRef: 'a', title: 'Analyze', status: 'pending', order: 0 }],
    });
    const active = plan({
      merge: true,
      items: [{ vendorRef: 'a', title: 'Analyze', status: 'active', order: 0 }],
    });

    expect((await projection.project(pending)).kind).toBe('published');
    expect((await projection.project(active)).kind).toBe('published');
    expect((await projection.project(active)).kind).toBe('duplicate');
    expect((await projection.project(pending)).kind).toBe('published');
    expect(published.at(-1)?.items[0]?.status).toBe('pending');
    expect(published).toHaveLength(3);
  });

  it('does not acknowledge a snapshot until publication succeeds', async () => {
    let attempts = 0;
    const projection = new AcpPlanProjection({
      publish: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient publish failure');
      },
    });
    const snapshot = plan();

    await expect(projection.project(snapshot)).rejects.toThrow('transient publish failure');
    expect((await projection.project(snapshot)).kind).toBe('published');
    expect(attempts).toBe(2);
  });

  it('does not acknowledge a snapshot until asynchronous publication succeeds', async () => {
    let attempts = 0;
    const projection = new AcpPlanProjection({
      publish: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('async publish failure');
      },
    });
    const snapshot = plan();

    await expect(projection.project(snapshot)).rejects.toThrow('async publish failure');
    await expect(projection.project(snapshot)).resolves.toMatchObject({ kind: 'published' });
    expect(attempts).toBe(2);
  });

  it('bounds finalized turn tombstones without retaining active state', async () => {
    const projection = new AcpPlanProjection({ publish: () => {}, finalizedTurnLimit: 2 });
    for (const turnId of ['one', 'two', 'three']) {
      await projection.project(plan({ turnId, correlationId: `${turnId}-call` }));
      projection.finalizeTurn(turnId);
    }
    expect(projection.activeTurnCount).toBe(0);
    expect(projection.finalizedTurnCount).toBe(2);
    expect((await projection.project(plan({ turnId: 'one', correlationId: 'one-new-call' }))).kind).toBe('published');
  });

  it('invalidates queued pre-reset projections instead of publishing them into the next session lifecycle', async () => {
    let releaseFirst!: () => void;
    const firstPublication = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const published: string[] = [];
    const projection = new AcpPlanProjection({
      publish: async (snapshot) => {
        published.push(snapshot.turnId);
        if (snapshot.turnId === 'turn-before-reset') await firstPublication;
      },
    });

    const first = projection.project(plan({ turnId: 'turn-before-reset' }));
    const queued = projection.project(plan({ turnId: 'turn-queued-before-reset' }));
    await Promise.resolve();
    const reset = projection.reset();
    releaseFirst();

    await reset;
    await expect(first).resolves.toMatchObject({ kind: 'late' });
    await expect(queued).resolves.toMatchObject({ kind: 'late' });
    expect(published).toEqual(['turn-before-reset']);
    expect(projection.activeTurnCount).toBe(0);
  });

  it('does not complete reset while an already-started publisher can still mutate external state', async () => {
    let releasePublication!: () => void;
    const publicationGate = new Promise<void>((resolve) => { releasePublication = resolve; });
    const applied: string[] = [];
    const projection = new AcpPlanProjection({
      publish: async (snapshot) => {
        await publicationGate;
        applied.push(snapshot.turnId);
      },
    });

    const publication = projection.project(plan({ turnId: 'turn-before-reset' }));
    await Promise.resolve();
    let resetCompleted = false;
    const reset = Promise.resolve(projection.reset()).then(() => { resetCompleted = true; });
    await Promise.resolve();

    expect(resetCompleted).toBe(false);
    expect(applied).toEqual([]);

    releasePublication();
    await reset;
    await expect(publication).resolves.toMatchObject({ kind: 'late' });
    expect(applied).toEqual(['turn-before-reset']);
    expect(projection.activeTurnCount).toBe(0);
  });

  it('rejects projections that arrive while reset is waiting for an in-flight publisher', async () => {
    let releasePublication!: () => void;
    const publicationGate = new Promise<void>((resolve) => { releasePublication = resolve; });
    const published: string[] = [];
    const projection = new AcpPlanProjection({
      publish: async (snapshot) => {
        published.push(snapshot.turnId);
        if (snapshot.turnId === 'turn-before-reset') await publicationGate;
      },
    });

    const publication = projection.project(plan({ turnId: 'turn-before-reset' }));
    await Promise.resolve();
    const reset = projection.reset();
    const concurrentReset = projection.reset();
    const duringReset = projection.project(plan({ turnId: 'turn-during-reset' }));
    const removalDuringReset = projection.remove({
      providerId: 'cursor',
      turnId: 'turn-before-reset',
      source: 'proprietary',
      correlationId: 'plan-call-1',
    });

    releasePublication();
    await Promise.all([reset, concurrentReset]);
    await expect(publication).resolves.toMatchObject({ kind: 'late' });
    await expect(duringReset).resolves.toMatchObject({ kind: 'late' });
    await expect(removalDuringReset).resolves.toMatchObject({ kind: 'late' });
    expect(published).toEqual(['turn-before-reset']);
    expect(projection.activeTurnCount).toBe(0);

    await expect(projection.project(plan({ turnId: 'turn-after-reset' }))).resolves.toMatchObject({
      kind: 'published',
    });
    expect(published).toEqual(['turn-before-reset', 'turn-after-reset']);
  });

  it('reopens after reset even when the in-flight publisher failed', async () => {
    let releasePublication!: () => void;
    const publicationGate = new Promise<void>((resolve) => { releasePublication = resolve; });
    const published: string[] = [];
    const projection = new AcpPlanProjection({
      publish: async (snapshot) => {
        published.push(snapshot.turnId);
        if (snapshot.turnId === 'turn-before-reset') {
          await publicationGate;
          throw new Error('publication failed during reset');
        }
      },
    });

    const publication = projection.project(plan({ turnId: 'turn-before-reset' }));
    await Promise.resolve();
    const reset = projection.reset();
    const duringReset = projection.project(plan({ turnId: 'turn-during-reset' }));
    releasePublication();

    await expect(publication).rejects.toThrow('publication failed during reset');
    await expect(reset).resolves.toBeUndefined();
    await expect(duringReset).resolves.toMatchObject({ kind: 'late' });
    await expect(projection.project(plan({ turnId: 'turn-after-reset' }))).resolves.toMatchObject({
      kind: 'published',
    });
    expect(published).toEqual(['turn-before-reset', 'turn-after-reset']);
  });

  it('removes only the currently visible exact-id plan and publishes an explicit clear snapshot', async () => {
    const published: NormalizedAcpPlanSnapshot[] = [];
    const projection = new AcpPlanProjection({ publish: (snapshot) => { published.push(snapshot); } });
    await projection.project(plan({
      source: 'standard',
      correlationId: 'plan-old',
      items: [{ vendorRef: 'old', title: 'Old', status: 'pending', order: 0 }],
    }));
    await projection.project(plan({
      source: 'standard',
      correlationId: ' plan-current ',
      items: [{ vendorRef: 'current', title: 'Current', status: 'active', order: 0 }],
    }));

    await expect(projection.remove({
      providerId: 'cursor',
      turnId: 'turn-1',
      source: 'standard',
      correlationId: 'plan-old',
    })).resolves.toMatchObject({ kind: 'duplicate' });
    expect(published).toHaveLength(2);

    await expect(projection.remove({
      providerId: 'cursor',
      turnId: 'turn-1',
      source: 'standard',
      correlationId: ' plan-current ',
    })).resolves.toMatchObject({ kind: 'published' });
    expect(published.at(-1)).toEqual({
      providerId: 'cursor',
      turnId: 'turn-1',
      correlationId: ' plan-current ',
      source: 'standard',
      merge: false,
      items: [],
    });
  });

  it('reveals the standard plan when the matching proprietary plan is removed', async () => {
    const published: NormalizedAcpPlanSnapshot[] = [];
    const projection = new AcpPlanProjection({ publish: (snapshot) => { published.push(snapshot); } });
    const standard = plan({
      source: 'standard',
      correlationId: 'standard-plan',
      items: [{ title: 'Standard', status: 'pending', order: 0 }],
    });
    await projection.project(standard);
    await projection.project(plan({ correlationId: 'proprietary-plan' }));

    await expect(projection.remove({
      providerId: 'cursor',
      turnId: 'turn-1',
      source: 'proprietary',
      correlationId: 'proprietary-plan',
    })).resolves.toMatchObject({ kind: 'published' });
    expect(published.at(-1)).toEqual(standard);
  });

  it('retains a standard shadow update that arrives after proprietary state for later fallback', async () => {
    const published: NormalizedAcpPlanSnapshot[] = [];
    const projection = new AcpPlanProjection({ publish: (snapshot) => { published.push(snapshot); } });
    await projection.project(plan({ correlationId: 'proprietary-plan' }));
    const standard = plan({
      source: 'standard',
      correlationId: 'standard-plan',
      items: [{ title: 'Latest standard', status: 'active', order: 0 }],
    });

    await expect(projection.project(standard)).resolves.toMatchObject({ kind: 'shadowed' });
    await expect(projection.remove({
      providerId: 'cursor',
      turnId: 'turn-1',
      source: 'proprietary',
      correlationId: 'proprietary-plan',
    })).resolves.toMatchObject({ kind: 'published' });
    expect(published).toEqual([plan({ correlationId: 'proprietary-plan' }), standard]);
  });
});
