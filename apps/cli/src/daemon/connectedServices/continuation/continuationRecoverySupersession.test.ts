import { describe, expect, it, vi } from 'vitest';

import { createConnectedServiceRecoverySupersessionCleaner } from './continuationRecoverySupersession';

describe('createConnectedServiceRecoverySupersessionCleaner', () => {
  it('clears only the runtime-auth report outbox selected by its canonical supersession owner', async () => {
    const removeReportOutboxItemsForSession = vi.fn(async () => undefined);
    const cleaner = createConnectedServiceRecoverySupersessionCleaner({ removeReportOutboxItemsForSession });

    await cleaner({ sessionId: 'session-1', event: { kind: 'turn_lifecycle', event: 'task_started' } });
    expect(removeReportOutboxItemsForSession).not.toHaveBeenCalled();

    await cleaner({ sessionId: 'session-1', event: { kind: 'turn_lifecycle', event: 'turn_cancelled' } });
    expect(removeReportOutboxItemsForSession).toHaveBeenCalledWith('session-1');
  });
});
