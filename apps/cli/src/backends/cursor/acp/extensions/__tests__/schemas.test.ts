import { describe, expect, it } from 'vitest';

import {
  cursorAskQuestionRequestSchema,
  cursorAskQuestionResponseSchema,
  cursorCreatePlanResponseSchema,
  cursorGenerateImageNotificationSchema,
  cursorTaskNotificationSchema,
  cursorUpdateTodosRequestSchema,
} from '../schemas';

describe('Cursor extension schemas', () => {
  it('rejects missing question ids and oversized todo arrays', () => {
    expect(cursorAskQuestionRequestSchema.safeParse({
      questions: [{ prompt: 'Missing id', options: [] }],
    }).success).toBe(false);
    expect(cursorAskQuestionRequestSchema.safeParse({
      questions: [{ id: 'q', prompt: 'Missing option id', options: [{ label: 'x' }] }],
    }).success).toBe(false);
    expect(cursorUpdateTodosRequestSchema.safeParse({
      todos: Array.from({ length: 2_001 }, (_, index) => ({ id: String(index), content: 'x' })),
    }).success).toBe(false);
  });

  it('accepts only the nested documented response unions', () => {
    expect(cursorAskQuestionResponseSchema.safeParse({
      outcome: { outcome: 'answered', answers: [{ questionId: 'q', selectedOptionIds: ['a'] }] },
    }).success).toBe(true);
    expect(cursorAskQuestionResponseSchema.safeParse({ answers: { q: 'a' } }).success).toBe(false);
    expect(cursorCreatePlanResponseSchema.safeParse({ outcome: { outcome: 'accepted' } }).success).toBe(true);
    expect(cursorCreatePlanResponseSchema.safeParse({
      outcome: { outcome: 'accepted', planUri: 'file:///tmp/plan.md' },
    }).success).toBe(true);
    expect(cursorCreatePlanResponseSchema.safeParse({
      outcome: { outcome: 'accepted', planUri: 'not a uri' },
    }).success).toBe(false);
    expect(cursorCreatePlanResponseSchema.safeParse({ accepted: true }).success).toBe(false);
  });

  it('preserves the source-real task custom subtype and generated-image field names', () => {
    expect(cursorTaskNotificationSchema.parse({
      toolCallId: 'task-1',
      description: 'Inspect the integration',
      prompt: 'Sanitized prompt',
      subagentType: { custom: 'specialist' },
      model: 'model-a',
      agentId: 'agent-1',
      durationMs: 42,
    })).toEqual({
      toolCallId: 'task-1',
      description: 'Inspect the integration',
      prompt: 'Sanitized prompt',
      subagentType: { custom: 'specialist' },
      model: 'model-a',
      agentId: 'agent-1',
      durationMs: 42,
    });

    expect(cursorTaskNotificationSchema.parse({
      toolCallId: 'opaque\n task ID ',
      description: 'Exact correlation id',
    }).toolCallId).toBe('opaque\n task ID ');
    expect(cursorTaskNotificationSchema.safeParse({
      toolCallId: 'task-legacy-alias',
      customSubagentType: 'unsupported-alias',
    }).success).toBe(true);
    expect(cursorTaskNotificationSchema.parse({
      toolCallId: 'task-legacy-alias',
      customSubagentType: 'unsupported-alias',
    })).toEqual({ toolCallId: 'task-legacy-alias' });
    expect(cursorTaskNotificationSchema.safeParse({
      toolCallId: 'task-oversized-prompt',
      prompt: 'x'.repeat(65_537),
    }).success).toBe(false);
    expect(cursorTaskNotificationSchema.safeParse({
      toolCallId: 'task-oversized-duration',
      durationMs: 2_592_000_001,
    }).success).toBe(false);

    expect(cursorGenerateImageNotificationSchema.parse({
      toolCallId: 'image-1',
      description: 'Generated diagram',
      filePath: '/workspace/generated.png',
      referenceImagePaths: ['/workspace/reference.png'],
    })).toEqual({
      toolCallId: 'image-1',
      description: 'Generated diagram',
      filePath: '/workspace/generated.png',
      referenceImagePaths: ['/workspace/reference.png'],
    });
  });

  it('preserves exact opaque ids across questions, options, todos, plans, and generated media', () => {
    const exactToolCallId = 'opaque\n tool ID ';
    const exactQuestionId = ' question-id ';
    const exactOptionId = ' option-id ';
    expect(cursorAskQuestionRequestSchema.parse({
      toolCallId: exactToolCallId,
      questions: [{
        id: exactQuestionId,
        prompt: 'Choose',
        options: [{ id: exactOptionId, label: 'Option' }],
      }],
    })).toEqual({
      toolCallId: exactToolCallId,
      questions: [{
        id: exactQuestionId,
        prompt: 'Choose',
        options: [{ id: exactOptionId, label: 'Option' }],
      }],
    });
    expect(cursorUpdateTodosRequestSchema.parse({
      toolCallId: exactToolCallId,
      todos: [{ id: ' todo-id ', content: 'Do it' }],
    })).toEqual({
      toolCallId: exactToolCallId,
      todos: [{ id: ' todo-id ', content: 'Do it' }],
    });
    expect(cursorGenerateImageNotificationSchema.parse({
      toolCallId: exactToolCallId,
      filePath: '/workspace/generated.png',
    }).toolCallId).toBe(exactToolCallId);

    expect(cursorAskQuestionRequestSchema.safeParse({
      questions: [{ id: '   ', prompt: 'Blank id' }],
    }).success).toBe(false);
  });
});
