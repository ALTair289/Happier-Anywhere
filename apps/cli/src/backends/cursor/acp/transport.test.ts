import { describe, expect, it } from 'vitest';

import { CursorTransport } from './transport';

describe('CursorTransport', () => {
  const transport = new CursorTransport();

  it('disables the synthetic tool-call timeout (Cursor turns are not force-timed-out)', () => {
    expect(transport.getToolCallTimeout('id', 'execute')).toBeNull();
  });

  it('repairs Cursor diff header noise via sanitizeToolUpdateContent', () => {
    const update = {
      content: [{ type: 'diff', path: '/x.py', oldText: '-- /dev/null\n', newText: '++ b/x.py\nprint(1)' }],
    };
    const out = transport.sanitizeToolUpdateContent(update);
    expect((out.content as any[])[0]).toMatchObject({ oldText: '', newText: 'print(1)' });
  });

  it('enriches Cursor task and create-plan identities without leaking provider logic into core', () => {
    expect(transport.determineToolName('other', 'task-1', { _toolName: 'task' })).toBe('Task');
    expect(transport.determineToolName('other', 'plan-1', { _toolName: 'createPlan' })).toBe('ExitPlanMode');
    expect(transport.determineToolName('Read', 'read-1', { _toolName: 'read' })).toBe('Read');
  });

  it('uses source-real Cursor titles when proprietary name metadata is absent', () => {
    expect(transport.determineToolName('other', 'task-1', { _acp: { title: 'Task 1' } })).toBe('Task');
    expect(transport.determineToolName('other', 'plan-1', { _acp: { title: 'Create Plan' } })).toBe('ExitPlanMode');
  });
});
