import { describe, expect, it } from 'vitest';

import {
  buildCursorPlanTodos,
  normalizeCursorTodos,
} from '../todos';

describe('Cursor todo projection', () => {
  it('preserves exact opaque todo ids through the Cursor adapter', () => {
    expect(normalizeCursorTodos({
      todos: [{ id: ' opaque\n todo ', content: 'Do it', status: 'pending' }],
    })[0]?.id).toBe(' opaque\n todo ');
  });
  it('normalizes source-real statuses and drops empty todo content', () => {
    expect(normalizeCursorTodos({
      todos: [
        { id: '1', content: 'Inspect state', status: 'completed' },
        { id: '2', title: 'Apply fix', status: 'inProgress' },
        { id: '3', content: 'Stop obsolete work', status: 'canceled' },
        { id: '4', content: 'Unknown status', status: 'weird' },
        { id: '5', content: '   ' },
      ],
    })).toEqual([
      { id: '1', content: 'Inspect state', status: 'completed' },
      { id: '2', content: 'Apply fix', status: 'in_progress' },
      { id: '3', content: 'Stop obsolete work', status: 'cancelled' },
      { id: '4', content: 'Unknown status', status: 'pending' },
    ]);
  });

  it('uses one flat checklist while preserving source-real structured phase names', () => {
    expect(buildCursorPlanTodos({
      plan: '# Plan',
      todos: [{ id: 'flat', content: 'Use the flat checklist', status: 'pending' }],
      phases: [{ name: ' Review ', todos: [{ id: 'flat', content: 'Use the flat checklist', status: 'pending' }] }],
    })).toEqual([{
      id: 'flat', content: 'Use the flat checklist', status: 'pending', phaseName: 'Review',
    }]);

    expect(buildCursorPlanTodos({
      plan: '# Plan',
      phases: [
        { name: ' Setup ', todos: [{ id: 'a', content: 'Init repo', status: 'pending' }] },
        { name: 'Build', todos: [{ id: 'b', content: 'Compile', status: 'in_progress' }] },
        { todos: [{ id: 'c', content: 'Ship', status: 'completed' }] },
      ],
    })).toEqual([
      { id: 'a', content: 'Init repo', status: 'pending', phaseName: 'Setup' },
      { id: 'b', content: 'Compile', status: 'in_progress', phaseName: 'Build' },
      { id: 'c', content: 'Ship', status: 'completed' },
    ]);
  });
});
