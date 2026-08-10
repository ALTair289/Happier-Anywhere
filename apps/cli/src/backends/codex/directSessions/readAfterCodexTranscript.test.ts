import { access, mkdir, mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createCodexAppServerProcessEnv,
  writeFakeCodexAppServerScript,
  writeFakeCodexAppServerThreadListScript,
} from '@/backends/codex/appServer/testkit/fakeCodexAppServer';
import { decodeCodexDirectForwardCursor } from './codexDirectForwardCursor';
import { readAfterCodexTranscript } from './readAfterCodexTranscript';

function sessionMetaLine(payload: Record<string, unknown>): string {
  return `${JSON.stringify({ type: 'session_meta', payload })}\n`;
}

function responseItemLine(params: { timestamp: string; payload: Record<string, unknown> }): string {
  return `${JSON.stringify({ type: 'response_item', timestamp: params.timestamp, payload: params.payload })}\n`;
}

function eventMsgLine(params: { timestamp: string; payload: Record<string, unknown> }): string {
  return `${JSON.stringify({ type: 'event_msg', timestamp: params.timestamp, payload: params.payload })}\n`;
}

describe('readAfterCodexTranscript', () => {
  it('returns appended messages when following from a tail cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-tail-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = '11111111-1111-1111-1111-111111111111';
    const filePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);

    await writeFile(
      filePath,
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/one' })
        + responseItemLine({
          timestamp: '2026-01-02T00:00:01.000Z',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        }),
      'utf8',
    );

    const init = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: 'tail',
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(init.items).toHaveLength(0);
    expect(init.truncated).toBe(false);
    expect(init.nextCursor).toBeTruthy();
    expect(decodeCodexDirectForwardCursor(init.nextCursor!)?.kind).toBe('codexForwardStreamVector');

    await appendFile(
      filePath,
      responseItemLine({
        timestamp: '2026-01-02T00:00:02.000Z',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'new' }] },
      }),
      'utf8',
    );

    const next = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: init.nextCursor!,
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(next.items.map((item) => (item.raw as any)?.content?.data?.message ?? (item.raw as any)?.content?.text)).toContain(
      'new',
    );
    expect(next.truncated).toBe(false);
    expect(next.nextCursor).toBeTruthy();
  });

  it('deduplicates a user response and its event when they append across read-after calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-tail-user-evidence-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    const sessionId = '14141414-1414-1414-1414-141414141414';
    const filePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);
    await writeFile(filePath, sessionMetaLine({ id: sessionId, cli_version: '99.0.0' }), 'utf8');
    const activeServerDir = join(root, 'servers', 'cloud');

    const init = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir,
      remoteSessionId: sessionId,
      cursor: 'tail',
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });
    await appendFile(filePath, responseItemLine({
      timestamp: '2026-01-02T00:00:01.000Z',
      payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'split append prompt' }] },
    }), 'utf8');

    const deferred = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir,
      remoteSessionId: sessionId,
      cursor: init.nextCursor!,
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });
    expect(deferred.items).toEqual([]);
    const deferredCursor = decodeCodexDirectForwardCursor(deferred.nextCursor!);
    expect(deferredCursor?.kind).toBe('codexForwardStreamVector');
    if (deferredCursor?.kind !== 'codexForwardStreamVector' || deferredCursor.v !== 5) {
      throw new Error('Expected durable stream-vector cursor');
    }
    expect(deferredCursor.streams[0]?.deferredUserResponseOffsetBytes).toBe(
      deferredCursor.streams[0]?.nextOffsetBytes,
    );

    const secondEmptyPoll = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir,
      remoteSessionId: sessionId,
      cursor: deferred.nextCursor!,
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });
    expect(secondEmptyPoll.items).toEqual([]);
    expect(secondEmptyPoll.nextCursor).toBe(deferred.nextCursor);
    const thirdEmptyPoll = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir,
      remoteSessionId: sessionId,
      cursor: secondEmptyPoll.nextCursor!,
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });
    expect(thirdEmptyPoll.items).toEqual([]);
    expect(thirdEmptyPoll.nextCursor).toBe(secondEmptyPoll.nextCursor);

    await appendFile(filePath, eventMsgLine({
      timestamp: '2026-01-02T00:00:01.001Z',
      payload: { type: 'user_message', client_id: 'split-client-id', message: 'split append prompt' },
    }), 'utf8');
    const committed = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir,
      remoteSessionId: sessionId,
      cursor: thirdEmptyPoll.nextCursor!,
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });
    expect(committed.items).toEqual([
      expect.objectContaining({
        localId: 'split-client-id',
        raw: { role: 'user', content: { type: 'text', text: 'split append prompt' } },
      }),
    ]);

    const idle = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir,
      remoteSessionId: sessionId,
      cursor: committed.nextCursor!,
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });
    expect(idle.items).toEqual([]);
  });

  it('commits a truly eventless user response only after an authoritative turn terminal boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-tail-eventless-terminal-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    const sessionId = '17171717-1717-1717-1717-171717171717';
    const filePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);
    await writeFile(filePath, sessionMetaLine({ id: sessionId }), 'utf8');
    const activeServerDir = join(root, 'servers', 'cloud');
    const init = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' }, env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir, remoteSessionId: sessionId, cursor: 'tail', maxBytes: 1024 * 1024, maxItems: 100,
    });
    await appendFile(filePath, responseItemLine({
      timestamp: '2026-01-02T00:00:01.000Z',
      payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'eventless terminal prompt' }] },
    }), 'utf8');

    const held = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' }, env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir, remoteSessionId: sessionId, cursor: init.nextCursor!, maxBytes: 1024 * 1024, maxItems: 100,
    });
    const heldAgain = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' }, env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir, remoteSessionId: sessionId, cursor: held.nextCursor!, maxBytes: 1024 * 1024, maxItems: 100,
    });
    expect(held.items).toEqual([]);
    expect(heldAgain.items).toEqual([]);
    expect(heldAgain.nextCursor).toBe(held.nextCursor);

    await appendFile(filePath, eventMsgLine({
      timestamp: '2026-01-02T00:00:02.000Z',
      payload: { type: 'task_complete', turn_id: 'turn-eventless' },
    }), 'utf8');
    const committed = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' }, env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir, remoteSessionId: sessionId, cursor: heldAgain.nextCursor!, maxBytes: 1024 * 1024, maxItems: 100,
    });
    expect(committed.items).toEqual([
      expect.objectContaining({
        localId: expect.stringMatching(/^codex:/),
        raw: { role: 'user', content: { type: 'text', text: 'eventless terminal prompt' } },
      }),
    ]);
    const committedCursor = decodeCodexDirectForwardCursor(committed.nextCursor!);
    if (committedCursor?.kind !== 'codexForwardStreamVector' || committedCursor.v !== 5) {
      throw new Error('Expected durable stream-vector cursor after terminal fallback delivery');
    }
    expect(committedCursor.streams[0]?.deliveredUserResponseOffsetBytes).toBeTypeOf('number');

    await appendFile(filePath, eventMsgLine({
      timestamp: '2026-01-02T00:00:03.000Z',
      payload: { type: 'user_message', client_id: 'late-terminal-client-id', message: 'eventless terminal prompt' },
    }), 'utf8');
    const reconciled = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' }, env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir, remoteSessionId: sessionId, cursor: committed.nextCursor!, maxBytes: 1024 * 1024, maxItems: 100,
    });
    expect(reconciled.items).toEqual([]);
    const reconciledCursor = decodeCodexDirectForwardCursor(reconciled.nextCursor!);
    if (reconciledCursor?.kind !== 'codexForwardStreamVector' || reconciledCursor.v !== 5) {
      throw new Error('Expected durable stream-vector cursor after late-event reconciliation');
    }
    expect(reconciledCursor.streams[0]?.deliveredUserResponseOffsetBytes).toBeUndefined();
    const repeated = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' }, env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir, remoteSessionId: sessionId, cursor: reconciled.nextCursor!, maxBytes: 1024 * 1024, maxItems: 100,
    });
    expect(repeated.items).toEqual([]);
    expect(repeated.nextCursor).toBe(reconciled.nextCursor);
  });

  it('does not advance an unselected stream past a terminal-backed response at the global maxItems boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-tail-multi-stream-progress-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    const sessionId = '18181818-1818-1818-1818-181818181818';
    const firstFilePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);
    const secondFilePath = join(sessionsDir, `rollout-2026-01-02T00-00-01-${sessionId}.jsonl`);
    await writeFile(firstFilePath, sessionMetaLine({ id: sessionId }), 'utf8');
    await writeFile(secondFilePath, sessionMetaLine({ id: sessionId }), 'utf8');
    const activeServerDir = join(root, 'servers', 'cloud');
    const init = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' }, env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir, remoteSessionId: sessionId, cursor: 'tail', maxBytes: 1024 * 1024, maxItems: 1,
    });
    await appendFile(firstFilePath, responseItemLine({
      timestamp: '2026-01-02T00:00:01.000Z',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'stream A fills page' }] },
    }), 'utf8');
    await appendFile(
      secondFilePath,
      responseItemLine({
        timestamp: '2026-01-02T00:00:02.000Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'stream B fallback response' }] },
      }) + eventMsgLine({
        timestamp: '2026-01-02T00:00:03.000Z',
        payload: { type: 'task_complete', turn_id: 'turn-stream-b' },
      }),
      'utf8',
    );

    const first = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' }, env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir, remoteSessionId: sessionId, cursor: init.nextCursor!, maxBytes: 1024 * 1024, maxItems: 1,
    });
    expect(first.items).toHaveLength(1);
    expect(JSON.stringify(first.items)).toContain('stream A fills page');
    expect(JSON.stringify(first.items)).not.toContain('stream B fallback response');

    const second = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' }, env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir, remoteSessionId: sessionId, cursor: first.nextCursor!, maxBytes: 1024 * 1024, maxItems: 1,
    });
    expect(second.items).toHaveLength(1);
    expect(JSON.stringify(second.items)).toContain('stream B fallback response');
    expect(JSON.stringify(second.items)).not.toContain('stream A fills page');

    const third = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' }, env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir, remoteSessionId: sessionId, cursor: second.nextCursor!, maxBytes: 1024 * 1024, maxItems: 1,
    });
    expect(third.items).toEqual([]);
  });

  it('keeps user event dedupe stable across a maxItems read-after boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-tail-user-page-boundary-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    const sessionId = '16161616-1616-1616-1616-161616161616';
    const filePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);
    await writeFile(filePath, sessionMetaLine({ id: sessionId }), 'utf8');
    const activeServerDir = join(root, 'servers', 'cloud');
    const init = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' }, env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir, remoteSessionId: sessionId, cursor: 'tail', maxBytes: 1024 * 1024, maxItems: 1,
    });
    await appendFile(
      filePath,
      responseItemLine({
        timestamp: '2026-01-02T00:00:01.000Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'boundary prompt' }] },
      })
        + eventMsgLine({
          timestamp: '2026-01-02T00:00:01.001Z',
          payload: { type: 'user_message', client_id: 'boundary-client-id', message: 'boundary prompt' },
        })
        + responseItemLine({
          timestamp: '2026-01-02T00:00:02.000Z',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'boundary answer' }] },
        }),
      'utf8',
    );

    const first = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' }, env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir, remoteSessionId: sessionId, cursor: init.nextCursor!, maxBytes: 1024 * 1024, maxItems: 1,
    });
    expect(first.items).toEqual([expect.objectContaining({ localId: 'boundary-client-id' })]);
    expect(first.truncated).toBe(true);

    const second = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' }, env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir, remoteSessionId: sessionId, cursor: first.nextCursor!, maxBytes: 1024 * 1024, maxItems: 1,
    });
    expect(second.items).toHaveLength(1);
    expect(JSON.stringify(second.items)).toContain('boundary answer');
    expect(JSON.stringify(second.items)).not.toContain('boundary prompt');
  });

  it('keeps the tail cursor at end-of-file when no new lines were appended', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-tail-stable-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = '22222222-2222-2222-2222-222222222222';
    const filePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);

    await writeFile(
      filePath,
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/two' })
        + responseItemLine({
          timestamp: '2026-01-02T00:00:01.000Z',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        }),
      'utf8',
    );

    const init = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: 'tail',
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(init.items).toHaveLength(0);
    expect(init.nextCursor).toBeTruthy();

    const idle = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: init.nextCursor!,
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(idle.items).toHaveLength(0);
    expect(idle.truncated).toBe(false);
    expect(idle.nextCursor).toBe(init.nextCursor);
  });

  it('advances the follow cursor across non-renderable rollout lines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-tail-non-renderable-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = 'non-renderable-progress-session';
    const filePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);

    await writeFile(
      filePath,
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/non-renderable' }),
      'utf8',
    );

    const init = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: 'tail',
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(init.items).toHaveLength(0);
    expect(init.nextCursor).toBeTruthy();

    await appendFile(
      filePath,
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:01.000Z', cwd: '/repo/non-renderable' }),
      'utf8',
    );

    const firstPoll = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: init.nextCursor!,
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(firstPoll.items).toHaveLength(0);
    expect(firstPoll.truncated).toBe(false);
    expect(firstPoll.nextCursor).toBeTruthy();
    expect(firstPoll.nextCursor).not.toBe(init.nextCursor);

    const secondPoll = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: firstPoll.nextCursor!,
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(secondPoll.items).toHaveLength(0);
    expect(secondPoll.truncated).toBe(false);
    expect(secondPoll.nextCursor).toBe(firstPoll.nextCursor);
  });

  it('continues from the last delivered unread line when maxItems truncates a readAfter batch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-tail-batch-progress-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = 'batch-progress-session';
    const filePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);

    await writeFile(
      filePath,
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/batch-progress' }),
      'utf8',
    );

    const init = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: 'tail',
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(init.items).toHaveLength(0);
    expect(init.nextCursor).toBeTruthy();

    await appendFile(
      filePath,
      responseItemLine({
        timestamp: '2026-01-02T00:00:01.000Z',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'first unread item' }] },
      })
      + responseItemLine({
        timestamp: '2026-01-02T00:00:02.000Z',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'second unread item' }] },
      }),
      'utf8',
    );

    const firstBatch = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: init.nextCursor!,
      maxBytes: 1024 * 1024,
      maxItems: 1,
    });

    expect(firstBatch.items).toHaveLength(1);
    expect(JSON.stringify(firstBatch.items[0] ?? null)).toContain('first unread item');
    expect(firstBatch.truncated).toBe(true);
    expect(firstBatch.nextCursor).toBeTruthy();

    const secondBatch = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: firstBatch.nextCursor!,
      maxBytes: 1024 * 1024,
      maxItems: 1,
    });

    expect(secondBatch.truncated).toBe(false);
    expect(secondBatch.items).toHaveLength(1);
    expect(JSON.stringify(secondBatch.items[0] ?? null)).toContain('second unread item');
    expect(secondBatch.nextCursor).toBeTruthy();
  });

  it('continues within a single multi-item rollout line when maxItems truncates a readAfter batch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-tail-subindex-progress-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = 'subindex-progress-session';
    const childThreadId = '56565656-5656-5656-5656-565656565656';
    const filePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);

    await writeFile(
      filePath,
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/subindex-progress' }),
      'utf8',
    );

    const init = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: 'tail',
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(init.items).toHaveLength(0);
    expect(init.nextCursor).toBeTruthy();

    await appendFile(
      filePath,
      `${JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-01-02T00:00:01.000Z',
        payload: {
          type: 'collab_waiting_end',
          sender_thread_id: sessionId,
          agent_statuses: [{
            thread_id: childThreadId,
            agent_nickname: 'Lovelace',
            agent_role: 'explorer',
            status: { completed: 'done' },
          }],
        },
      })}\n`,
      'utf8',
    );

    const firstBatch = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: init.nextCursor!,
      maxBytes: 1024 * 1024,
      maxItems: 1,
    });

    expect(firstBatch.items).toHaveLength(1);
    expect(firstBatch.items[0]?.raw).toEqual(
      expect.objectContaining({
        role: 'agent',
        content: expect.objectContaining({
          data: expect.objectContaining({
            type: 'tool-call',
            callId: childThreadId,
            name: 'SubAgent',
          }),
        }),
      }),
    );
    expect(firstBatch.truncated).toBe(true);
    expect(firstBatch.nextCursor).toBeTruthy();

    const secondBatch = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: firstBatch.nextCursor!,
      maxBytes: 1024 * 1024,
      maxItems: 1,
    });

    expect(secondBatch.truncated).toBe(false);
    expect(secondBatch.items).toHaveLength(1);
    expect(secondBatch.items[0]?.raw).toEqual(
      expect.objectContaining({
        role: 'agent',
        content: expect.objectContaining({
          data: expect.objectContaining({
            type: 'tool-call-result',
            callId: childThreadId,
          }),
        }),
      }),
    );
    expect(secondBatch.nextCursor).toBeTruthy();
  });

  it('keeps polling app-server-linked sessions when rollout files are missing, then forces a refresh when one appears', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-tail-app-server-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(codexHome, { recursive: true });

    const sessionId = 'remote_app_server';
    const fakeAppServer = await writeFakeCodexAppServerThreadListScript({
      dir: root,
      initializeName: 'fake',
      nonArchivedThreads: [{
        id: sessionId,
        name: 'App server tail preview',
        updatedAt: 1736000200,
        cwd: '/repo/from-app-server',
      }],
    });

    const env = createCodexAppServerProcessEnv(fakeAppServer, { CODEX_HOME: codexHome });

    const init = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: 'tail',
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(init.items).toHaveLength(0);
    expect(init.truncated).toBe(false);
    expect(init.nextCursor).toBeTruthy();

    const idle = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: init.nextCursor!,
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(idle.items).toHaveLength(0);
    expect(idle.truncated).toBe(false);
    expect(idle.nextCursor).toBe(init.nextCursor);

    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`),
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/from-rollout' })
        + responseItemLine({
          timestamp: '2026-01-02T00:00:01.000Z',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hello from rollout' }] },
        }),
      'utf8',
    );

    const afterRolloutAppears = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: init.nextCursor!,
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(afterRolloutAppears.items).toHaveLength(0);
    expect(afterRolloutAppears.truncated).toBe(true);
    expect(afterRolloutAppears.nextCursor).toBeTruthy();
  });

  it('does not start the Codex app-server metadata fallback when tailing an existing rollout file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-tail-no-app-server-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = 'tail-existing-rollout-session';
    const markerPath = join(root, 'app-server-started');
    const fakeAppServer = await writeFakeCodexAppServerScript({
      dir: root,
      setupLines: [
        'import("node:fs/promises").then(({ writeFile }) => writeFile(process.env.APP_SERVER_MARKER, "started"));',
      ],
      bodyLines: ['for await (const _line of rl) {}'],
    });

    const filePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);
    await writeFile(
      filePath,
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/no-app-server' }),
      'utf8',
    );

    const init = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: createCodexAppServerProcessEnv(fakeAppServer, {
        CODEX_HOME: codexHome,
        APP_SERVER_MARKER: markerPath,
      }),
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: 'tail',
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(init.items).toHaveLength(0);
    expect(init.nextCursor).toBeTruthy();
    await expect(access(markerPath)).rejects.toThrow();
  });

  it('returns appended synthetic SubAgent root rows when collaboration events are written after tail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-tail-subagent-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = '55555555-5555-5555-5555-555555555555';
    const childThreadId = '66666666-6666-6666-6666-666666666666';
    const filePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);

    await writeFile(
      filePath,
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/subagent-tail' }),
      'utf8',
    );

    const init = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: 'tail',
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(init.items).toHaveLength(0);
    expect(init.nextCursor).toBeTruthy();

    await appendFile(
      filePath,
      responseItemLine({
        timestamp: '2026-01-02T00:00:00.250Z',
        payload: {
          type: 'function_call',
          name: 'spawn_agent',
          arguments: JSON.stringify({ role: 'explorer', prompt: 'inspect the repo' }),
          call_id: 'call_spawn_1',
        },
      })
      + responseItemLine({
        timestamp: '2026-01-02T00:00:00.500Z',
        payload: {
          type: 'function_call_output',
          call_id: 'call_spawn_1',
          output: JSON.stringify({ agent_id: childThreadId, nickname: 'Lovelace' }),
        },
      })
      + `${JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-01-02T00:00:01.000Z',
        payload: {
          type: 'collab_agent_spawn_end',
          sender_thread_id: sessionId,
          new_thread_id: childThreadId,
          new_agent_nickname: 'Lovelace',
          new_agent_role: 'explorer',
          prompt: 'inspect the repo',
        },
      })}\n`
      + `${JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-01-02T00:00:02.000Z',
        payload: {
          type: 'collab_waiting_end',
          sender_thread_id: sessionId,
          agent_statuses: [{
            thread_id: childThreadId,
            agent_nickname: 'Lovelace',
            agent_role: 'explorer',
            status: { completed: 'done' },
          }],
        },
      })}\n`
      + responseItemLine({
        timestamp: '2026-01-02T00:00:02.500Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: `<subagent_notification>\n{"agent_id":"${childThreadId}","status":{"completed":"done"}}\n</subagent_notification>`,
          }],
        },
      }),
      'utf8',
    );

    const next = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: init.nextCursor!,
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(next.items).toHaveLength(2);
    expect(next.items[0]?.raw).toEqual(
      expect.objectContaining({
        role: 'agent',
        content: expect.objectContaining({
          data: expect.objectContaining({
            type: 'tool-call',
            callId: childThreadId,
            name: 'SubAgent',
          }),
        }),
      }),
    );
    expect(next.items[1]?.raw).toEqual(
      expect.objectContaining({
        role: 'agent',
        content: expect.objectContaining({
          data: expect.objectContaining({
            type: 'tool-call-result',
            callId: childThreadId,
          }),
        }),
      }),
    );
  });

  it('returns appended child rollout sidechain messages when a spawned subagent writes to its rollout file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-tail-child-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = '99999999-9999-9999-9999-999999999999';
    const childThreadId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const parentFilePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);
    const childFilePath = join(sessionsDir, `rollout-2026-01-02T00-00-01-${childThreadId}.jsonl`);

    await writeFile(
      parentFilePath,
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/subagent-tail' }),
      'utf8',
    );

    const init = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: 'tail',
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(init.items).toHaveLength(0);
    expect(init.nextCursor).toBeTruthy();

    await appendFile(
      parentFilePath,
      `${JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-01-02T00:00:01.000Z',
        payload: {
          type: 'collab_agent_spawn_end',
          sender_thread_id: sessionId,
          new_thread_id: childThreadId,
          new_agent_nickname: 'Lovelace',
          new_agent_role: 'explorer',
          prompt: 'inspect the repo',
        },
      })}\n`,
      'utf8',
    );
    await writeFile(
      childFilePath,
      responseItemLine({
        timestamp: '2026-01-02T00:00:02.000Z',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'child summary' }] },
      }),
      'utf8',
    );

    const next = await readAfterCodexTranscript({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      cursor: init.nextCursor!,
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(next.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          raw: expect.objectContaining({
            role: 'agent',
            content: expect.objectContaining({
              data: expect.objectContaining({
                type: 'message',
                message: 'child summary',
                sidechainId: childThreadId,
              }),
            }),
          }),
        }),
      ]),
    );
  });
});
