import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { streamToStdin } from './utils';

async function* exactPrompt(): AsyncIterable<unknown> {
  yield {
    type: 'user',
    message: { role: 'user', content: 'exact queued prompt' },
  };
}

describe('Claude legacy stream-json provider transport boundary', () => {
  it('does not complete handoff until the exact stdin write callback confirms the record', async () => {
    class DeferredWrite extends EventEmitter {
      destroyed = false;
      writableEnded = false;
      written = '';
      private confirmWrite: (() => void) | null = null;

      write(chunk: string, callback?: (error?: Error | null) => void): boolean {
        this.written += chunk;
        this.confirmWrite = () => callback?.(null);
        return true;
      }

      confirm(): void {
        this.confirmWrite?.();
      }

      end(): void {
        this.writableEnded = true;
      }
    }

    const stdin = new DeferredWrite();
    let completed = false;
    const outcomes: string[] = [];
    const handoff = streamToStdin(
      exactPrompt(),
      stdin as unknown as NodeJS.WritableStream,
      undefined,
      (_record, outcome) => outcomes.push(outcome),
    )
      .then(() => { completed = true; });

    await vi.waitFor(() => {
      expect(stdin.written).toContain('exact queued prompt');
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(outcomes).toEqual([]);

    stdin.confirm();
    await handoff;
    expect(completed).toBe(true);
    expect(outcomes).toEqual(['accepted']);
  });

  it('rejects a proven pre-write failure without reporting a successful handoff', async () => {
    class PreWriteFailure extends EventEmitter {
      destroyed = false;
      writableEnded = false;

      write(): boolean {
        throw Object.assign(new Error('stdin unavailable before write'), { code: 'EBADF' });
      }

      end(): void {
        this.writableEnded = true;
      }
    }

    const outcomes: string[] = [];
    await expect(streamToStdin(
      exactPrompt(),
      new PreWriteFailure() as unknown as NodeJS.WritableStream,
      undefined,
      (_record, outcome) => outcomes.push(outcome),
    )).rejects.toMatchObject({ code: 'EBADF' });
    expect(outcomes).toEqual(['rejected_before_effect']);
  });

  it('does not report success when stdin fails after the write attempt becomes ambiguous', async () => {
    class AmbiguousWrite extends EventEmitter {
      destroyed = false;
      writableEnded = false;

      write(): boolean {
        this.emit('error', Object.assign(new Error('write EPIPE after attempt'), { code: 'EPIPE' }));
        return true;
      }

      end(): void {
        this.writableEnded = true;
      }
    }

    const outcomes: string[] = [];
    await expect(streamToStdin(
      exactPrompt(),
      new AmbiguousWrite() as unknown as NodeJS.WritableStream,
      undefined,
      (_record, outcome) => outcomes.push(outcome),
    )).rejects.toMatchObject({ code: 'EPIPE' });
    expect(outcomes).toEqual(['effect_may_have_occurred']);
  });
});
