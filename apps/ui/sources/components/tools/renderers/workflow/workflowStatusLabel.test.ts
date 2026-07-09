import { describe, expect, it } from 'vitest';

import { installWorkflowRendererCommonModuleMocks } from './workflowRendererTestHelpers';

installWorkflowRendererCommonModuleMocks();

const { formatWorkflowRunStatusLabel } = await import('./workflowStatusLabel');

describe('formatWorkflowRunStatusLabel', () => {
    it('maps plain run statuses to their own labels', () => {
        expect(formatWorkflowRunStatusLabel('active')).toBe('tools.workflowActivityView.statusActive');
        expect(formatWorkflowRunStatusLabel('stopped')).toBe('tools.workflowActivityView.statusStopped');
        expect(formatWorkflowRunStatusLabel('complete')).toBe('tools.workflowActivityView.statusComplete');
    });

    it('surfaces a distinct "Interrupted" label when a stopped run was reconciled after a crash (plan #4)', () => {
        expect(formatWorkflowRunStatusLabel('stopped', 'interrupted')).toBe('tools.workflowActivityView.statusInterrupted');
    });

    it('surfaces "Interrupted" for an active run carrying the interrupted reason', () => {
        expect(formatWorkflowRunStatusLabel('active', 'interrupted')).toBe('tools.workflowActivityView.statusInterrupted');
    });

    it('ignores the interrupted reason for a genuinely complete run', () => {
        expect(formatWorkflowRunStatusLabel('complete', 'interrupted')).toBe('tools.workflowActivityView.statusComplete');
    });
});
