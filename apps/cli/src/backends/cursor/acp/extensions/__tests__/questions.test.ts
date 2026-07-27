import { describe, expect, it } from 'vitest';

import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import {
  buildCursorAskQuestionInput,
  handleCursorAskQuestion,
} from '../questions';

function permissionHandler(result: Readonly<{
  decision: 'approved' | 'denied' | 'abort';
  answers?: Readonly<Record<string, readonly string[]>>;
}>): AcpPermissionHandler {
  return {
    async handleToolCall() {
      return result;
    },
  };
}

const context = {
  method: 'cursor/ask_question',
  sessionId: 'session-1',
  signal: new AbortController().signal,
  agentName: 'cursor',
} as const;

describe('Cursor ask-question extension', () => {
  it('exposes canonical structured answers on the shared ACP permission result', async () => {
    const result = await permissionHandler({
      decision: 'approved',
      answers: { q1: ['answer-1'] },
    }).handleToolCall('ask-contract', 'AskUserQuestion', {});

    expect(result.answers).toEqual({ q1: ['answer-1'] });
  });

  it('preserves option ids as canonical choices so duplicate labels remain distinguishable', () => {
    expect(buildCursorAskQuestionInput({
      title: 'Choose',
      questions: [{
        id: 'q1',
        prompt: 'Which target?',
        allowMultiple: true,
        options: [
          { id: 'first', label: 'Same label' },
          { id: 'second', label: 'Same label' },
        ],
      }],
    })).toEqual({
      questions: [{
        id: 'q1',
        header: 'Choose',
        question: 'Which target?',
        multiSelect: true,
        options: [
          { choice: 'first', label: 'Same label', description: 'Same label' },
          { choice: 'second', label: 'Same label', description: 'Same label' },
        ],
      }],
    });
  });

  it('uses the canonical freeform question affordance when Cursor supplies no options', () => {
    expect(buildCursorAskQuestionInput({
      questions: [{ id: 'q-free', prompt: 'Describe the target', options: [] }],
    })).toEqual({
      questions: [{
        id: 'q-free',
        header: 'Question',
        question: 'Describe the target',
        multiSelect: false,
        options: [],
        freeform: {},
      }],
    });
  });

  it('returns the exact answered envelope with selected ids and preserves freeform text', async () => {
    const result = await handleCursorAskQuestion({
      request: {
        toolCallId: 'ask-1',
        questions: [
          {
            id: 'multi',
            prompt: 'Pick targets',
            allowMultiple: true,
            options: [
              { id: 'a', label: 'Alpha' },
              { id: 'b', label: 'Beta' },
            ],
          },
          { id: 'free', prompt: 'Explain', options: [] },
        ],
      },
      context,
      permissionHandler: permissionHandler({
        decision: 'approved',
        answers: { multi: ['a', 'b'], free: ['custom answer'] },
      }),
    });

    expect(result).toEqual({
      outcome: {
        outcome: 'answered',
        answers: [
          { questionId: 'multi', selectedOptionIds: ['a', 'b'] },
          { questionId: 'free', selectedOptionIds: ['custom answer'] },
        ],
      },
    });
  });

  it('maps a unique returned label to its id but never guesses between duplicate labels', async () => {
    const base = {
      toolCallId: 'ask-1',
      questions: [{
        id: 'q1',
        prompt: 'Pick',
        options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }],
      }],
    };
    await expect(handleCursorAskQuestion({
      request: base,
      context,
      permissionHandler: permissionHandler({ decision: 'approved', answers: { q1: ['Beta'] } }),
    })).resolves.toEqual({
      outcome: { outcome: 'answered', answers: [{ questionId: 'q1', selectedOptionIds: ['b'] }] },
    });

    await expect(handleCursorAskQuestion({
      request: {
        ...base,
        questions: [{
          ...base.questions[0],
          options: [{ id: 'a', label: 'Same' }, { id: 'b', label: 'Same' }],
        }],
      },
      context,
      permissionHandler: permissionHandler({ decision: 'approved', answers: { q1: ['Same'] } }),
    })).resolves.toEqual({ outcome: { outcome: 'skipped' } });
  });

  it('round-trips exact opaque option and question ids without trimming them', async () => {
    await expect(handleCursorAskQuestion({
      request: {
        toolCallId: 'ask-exact',
        questions: [
          {
            id: ' single-question ',
            prompt: 'Pick one',
            options: [{ id: ' single-option ', label: 'Single' }],
          },
          {
            id: ' multi-question ',
            prompt: 'Pick many',
            allowMultiple: true,
            options: [
              { id: ' first-option ', label: 'First' },
              { id: ' second-option ', label: 'Second' },
            ],
          },
        ],
      },
      context,
      permissionHandler: permissionHandler({
        decision: 'approved',
        answers: {
          ' single-question ': [' single-option '],
          ' multi-question ': [' first-option ', ' second-option '],
        },
      }),
    })).resolves.toEqual({
      outcome: {
        outcome: 'answered',
        answers: [
          { questionId: ' single-question ', selectedOptionIds: [' single-option '] },
          { questionId: ' multi-question ', selectedOptionIds: [' first-option ', ' second-option '] },
        ],
      },
    });
  });

  it('maps denial to skipped and host abort to cancelled', async () => {
    const request = {
      toolCallId: 'ask-1',
      questions: [{ id: 'q1', prompt: 'Continue?', options: [{ id: 'yes', label: 'Yes' }] }],
    };

    await expect(handleCursorAskQuestion({
      request,
      context,
      permissionHandler: permissionHandler({ decision: 'denied' }),
    })).resolves.toEqual({ outcome: { outcome: 'skipped' } });

    await expect(handleCursorAskQuestion({
      request,
      context,
      permissionHandler: permissionHandler({ decision: 'abort' }),
    })).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('returns the cancelled envelope when the extension request signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort(Object.assign(new Error('turn ended'), { name: 'AbortError' }));
    let permissionCalls = 0;

    await expect(handleCursorAskQuestion({
      request: {
        toolCallId: 'ask-aborted',
        questions: [{ id: 'q1', prompt: 'Continue?', options: [{ id: 'yes', label: 'Yes' }] }],
      },
      context: { ...context, signal: controller.signal },
      permissionHandler: {
        async handleToolCall() {
          permissionCalls += 1;
          return { decision: 'approved', answers: { q1: ['yes'] } };
        },
      },
    })).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    expect(permissionCalls).toBe(0);
  });
});
