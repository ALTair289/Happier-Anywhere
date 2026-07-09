import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('startDaemon connected-services cleanup ordering', () => {
  it('starts destructive connected-service cleanup only after passive session reattach', async () => {
    const source = await readFile(new URL('./startDaemon.ts', import.meta.url), 'utf8');

    const reattachIndex = source.indexOf('await reattachTrackedSessionsFromMarkers');
    const groupReconcileIndex = source.indexOf('connectedServiceGroupHomeCleanupScheduler.reconcileDeletedGroupHomes');
    const materializedTriggerIndex = source.indexOf('connectedServiceMaterializedHomeCleanupLoopHandle?.trigger()');

    expect(reattachIndex).toBeGreaterThanOrEqual(0);
    expect(groupReconcileIndex).toBeGreaterThan(reattachIndex);
    expect(materializedTriggerIndex).toBeGreaterThan(reattachIndex);
  });
});
