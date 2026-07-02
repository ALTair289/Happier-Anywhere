import { appendFile, mkdir, mkdtemp, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RawJSONLines } from '../types';
import { getProjectPath } from '../utils/path';
import type { SessionHookData } from '../utils/startHookServer';
import { createClaudeUnifiedTranscriptBridge } from './createClaudeUnifiedTranscriptBridge';

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function appendJsonl(path: string, message: RawJSONLines): Promise<void> {
  await appendFile(path, `${JSON.stringify(message)}\n`);
}

async function appendRawJsonl(path: string, message: unknown): Promise<void> {
  await appendFile(path, `${JSON.stringify(message)}\n`);
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('createClaudeUnifiedTranscriptBridge', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('forwards new Claude transcript rows through the remote message callback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, 'sess_1.jsonl');
    await writeFile(transcriptPath, '');

    const onMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: 'sess_1',
      transcriptPath,
      workingDirectory: dir,
      onMessage,
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      await appendJsonl(transcriptPath, {
        type: 'assistant',
        uuid: 'assistant_1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello from transcript' }],
        },
      } as RawJSONLines);

      await waitUntil(() => onMessage.mock.calls.length === 1);
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'assistant',
        uuid: 'assistant_1',
      }));
    } finally {
      await bridge.dispose();
    }
  });

  it('observes internal queued-command transcript rows without emitting them as visible messages', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-raw-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, 'sess_raw.jsonl');
    await writeFile(transcriptPath, '');

    const onRawTranscriptValue = vi.fn();
    const onMessage = vi.fn();
    const onTranscriptMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: 'sess_raw',
      transcriptPath,
      workingDirectory: dir,
      onRawTranscriptValue,
      onMessage,
      onTranscriptMessage,
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      await appendRawJsonl(transcriptPath, {
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: new Date().toISOString(),
        sessionId: 'sess_raw',
        content: 'Please continue from the current point.',
      });

      await waitUntil(() => onRawTranscriptValue.mock.calls.length === 1);
      expect(onRawTranscriptValue).toHaveBeenCalledWith(expect.objectContaining({
        type: 'queue-operation',
        operation: 'enqueue',
        content: 'Please continue from the current point.',
      }));
      expect(onMessage).not.toHaveBeenCalled();
      expect(onTranscriptMessage).not.toHaveBeenCalled();
    } finally {
      await bridge.dispose();
    }
  });

  it('does not forward historical raw rows after the known-resume raw follower resets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-raw-reset-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, 'sess_raw_reset.jsonl');
    await writeFile(transcriptPath, '');

    const onRawTranscriptValue = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: 'sess_raw_reset',
      transcriptPath,
      workingDirectory: dir,
      onRawTranscriptValue,
      subscribeClaudeSessionHooks: () => () => {},
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      await appendRawJsonl(transcriptPath, {
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: new Date().toISOString(),
        sessionId: 'sess_raw_reset',
        content: 'initial live raw row',
      });
      await waitUntil(() => onRawTranscriptValue.mock.calls.length >= 1);

      const replacementPath = `${transcriptPath}.replacement`;
      await writeFile(
        replacementPath,
        [
          JSON.stringify({
            type: 'queue-operation',
            operation: 'enqueue',
            timestamp: new Date(Date.now() - 60_000).toISOString(),
            sessionId: 'sess_raw_reset',
            content: 'old raw row after replacement',
          }),
          JSON.stringify({
            type: 'queue-operation',
            operation: 'enqueue',
            timestamp: new Date(Date.now() + 1000).toISOString(),
            sessionId: 'sess_raw_reset',
            content: 'fresh raw row after replacement',
          }),
        ].join('\n') + '\n',
      );
      await rename(replacementPath, transcriptPath);

      await waitUntil(() => onRawTranscriptValue.mock.calls.some(([value]) => (
        (value as { content?: unknown } | null)?.content === 'fresh raw row after replacement'
      )));
      const contents = onRawTranscriptValue.mock.calls.map(([value]) => (
        (value as { content?: unknown } | null)?.content
      ));
      expect(contents).toContain('initial live raw row');
      expect(contents).toContain('fresh raw row after replacement');
      expect(contents).not.toContain('old raw row after replacement');
    } finally {
      await bridge.dispose();
    }
  });

  it('binds a known resumed session to the canonical transcript path when no transcriptPath or SessionStart is available', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-known-canonical-'));
    tempDirs.push(dir);
    const workspaceDir = join(dir, 'workspace');
    const claudeConfigDir = join(dir, 'claude-config');
    const sessionId = 'sess_known_canonical';
    const projectDir = getProjectPath(workspaceDir, claudeConfigDir);
    await mkdir(projectDir, { recursive: true });
    const transcriptPath = join(projectDir, `${sessionId}.jsonl`);
    await writeFile(transcriptPath, '');

    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onTranscriptMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId,
      transcriptPath: null,
      workingDirectory: workspaceDir,
      claudeConfigDir,
      onTranscriptMessage,
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      expect(subscribedHook).toBeTypeOf('function');
      await appendJsonl(transcriptPath, {
        type: 'assistant',
        uuid: 'known_canonical_assistant_row',
        timestamp: new Date().toISOString(),
        sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello from known canonical transcript' }],
        },
      } as RawJSONLines);

      await waitUntil(() => onTranscriptMessage.mock.calls.length === 1);
      expect(onTranscriptMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'assistant',
        uuid: 'known_canonical_assistant_row',
      }));
    } finally {
      await bridge.dispose();
    }
  });



  it('suppresses historical resume rows in a fresh Happier session while emitting the newly accepted prompt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-resume-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, 'sess_resume.jsonl');
    await mkdir(dir, { recursive: true });
    await writeFile(transcriptPath, '');

    const historicalMessage = {
      type: 'user',
      uuid: 'historical_user_prompt',
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      sessionId: 'sess_resume',
      message: {
        role: 'user',
        content: 'old prompt from the resumed Claude transcript',
      },
    } as RawJSONLines;
    await appendJsonl(transcriptPath, historicalMessage);

    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onMessage = vi.fn();
    const onTranscriptMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: null,
      transcriptPath: null,
      workingDirectory: dir,
      onMessage,
      onTranscriptMessage,
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({
        hook_event_name: 'SessionStart',
        source: 'resume',
        session_id: 'sess_resume',
        transcript_path: transcriptPath,
      });

      await appendJsonl(transcriptPath, {
        type: 'user',
        uuid: 'live_user_prompt_after_resume',
        timestamp: new Date(Date.now() + 10_000).toISOString(),
        sessionId: 'sess_resume',
        message: {
          role: 'user',
          content: 'new prompt accepted after Happier resumed Claude',
        },
      } as RawJSONLines);

      await waitUntil(() => onMessage.mock.calls.some(([message]) => message?.uuid === 'live_user_prompt_after_resume'));
      expect(onMessage.mock.calls.map(([message]) => message?.uuid)).toEqual(['live_user_prompt_after_resume']);
      await waitUntil(() => onTranscriptMessage.mock.calls.length === 1);
      expect(onTranscriptMessage).toHaveBeenCalledWith(expect.objectContaining({
        uuid: 'live_user_prompt_after_resume',
      }));

      await appendJsonl(transcriptPath, {
        type: 'assistant',
        uuid: 'live_assistant_end_turn',
        timestamp: new Date(Date.now() + 10_000).toISOString(),
        sessionId: 'sess_resume',
        message: {
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'live response' }],
        },
      } as RawJSONLines);

      await waitUntil(() => onTranscriptMessage.mock.calls.length === 2);
      expect(onTranscriptMessage).toHaveBeenCalledWith(expect.objectContaining({
        uuid: 'live_assistant_end_turn',
      }));
    } finally {
      await bridge.dispose();
    }
  });

  it('ignores sidechain SessionStart hooks: a subagent must never re-key the session/resume identity (A4-MED-2)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, 'sess_main.jsonl');
    await writeFile(transcriptPath, '');

    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onSessionFound = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: null,
      transcriptPath: null,
      workingDirectory: dir,
      onSessionFound,
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('hook subscription missing');

      hook({
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_id: 'sess_sidechain',
        transcript_path: join(dir, 'sess_sidechain.jsonl'),
        agent_id: 'subagent-1',
      });
      expect(onSessionFound).not.toHaveBeenCalled();

      hook({
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_id: 'sess_main',
        transcript_path: transcriptPath,
      });
      expect(onSessionFound).toHaveBeenCalledTimes(1);
      expect(onSessionFound).toHaveBeenCalledWith('sess_main', expect.objectContaining({ session_id: 'sess_main' }));
    } finally {
      await bridge.dispose();
    }
  });

  it('does not pre-mark a known hook-driven resume transcript before Claude announces SessionStart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-known-resume-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, 'sess_known_resume.jsonl');
    await mkdir(dir, { recursive: true });
    await writeFile(transcriptPath, '');

    await appendJsonl(transcriptPath, {
      type: 'assistant',
      uuid: 'missed_during_runner_restart',
      timestamp: new Date(Date.now() - 30_000).toISOString(),
      sessionId: 'sess_known_resume',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'completed while the Happier runner was down' }],
      },
    } as RawJSONLines);

    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onMessage = vi.fn();
    const onTranscriptMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: 'sess_known_resume',
      transcriptPath,
      workingDirectory: dir,
      onMessage,
      onTranscriptMessage,
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      expect(onMessage).not.toHaveBeenCalled();

      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({
        hook_event_name: 'SessionStart',
        source: 'resume',
        session_id: 'sess_known_resume',
        transcript_path: transcriptPath,
      });

      await waitUntil(() => onMessage.mock.calls.length === 1);
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
        uuid: 'missed_during_runner_restart',
      }));
      expect(onTranscriptMessage).not.toHaveBeenCalled();
    } finally {
      await bridge.dispose();
    }
  });

  it('discovers a fresh transcript when Claude writes before emitting SessionStart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-no-hook-'));
    tempDirs.push(dir);
    const workspaceDir = join(dir, 'workspace');
    const claudeConfigDir = join(dir, 'claude-config');
    await mkdir(workspaceDir, { recursive: true });
    const projectDir = getProjectPath(workspaceDir, claudeConfigDir);
    await mkdir(projectDir, { recursive: true });

    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: null,
      transcriptPath: null,
      workingDirectory: workspaceDir,
      claudeConfigDir,
      onMessage,
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      expect(subscribedHook).toBeTypeOf('function');

      const transcriptPath = join(projectDir, '11111111-1111-4111-8111-111111111111.jsonl');
      await appendJsonl(transcriptPath, {
        type: 'assistant',
        uuid: 'assistant_auth_failure_before_session_start',
        timestamp: new Date().toISOString(),
        sessionId: '11111111-1111-4111-8111-111111111111',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Not logged in · Please run /login' }],
        },
        error: 'authentication_failed',
        isApiErrorMessage: true,
      } as RawJSONLines);

      await waitUntil(() => onMessage.mock.calls.length === 1);
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
        uuid: 'assistant_auth_failure_before_session_start',
        error: 'authentication_failed',
      }));
    } finally {
      await bridge.dispose();
    }
  });

  it('does not let unhooked API-error discovery block trusted SessionStart binding', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-error-before-hook-'));
    tempDirs.push(dir);
    const workspaceDir = join(dir, 'workspace');
    const claudeConfigDir = join(dir, 'claude-config');
    await mkdir(workspaceDir, { recursive: true });
    const projectDir = getProjectPath(workspaceDir, claudeConfigDir);
    await mkdir(projectDir, { recursive: true });

    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: null,
      transcriptPath: null,
      workingDirectory: workspaceDir,
      claudeConfigDir,
      onMessage,
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      const unhookedSessionId = '66666666-6666-4666-8666-666666666666';
      const unhookedTranscriptPath = join(projectDir, `${unhookedSessionId}.jsonl`);
      await appendJsonl(unhookedTranscriptPath, {
        type: 'assistant',
        uuid: 'assistant_auth_failure_before_session_start',
        timestamp: new Date().toISOString(),
        sessionId: unhookedSessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Not logged in · Please run /login' }],
        },
        error: 'authentication_failed',
        isApiErrorMessage: true,
      } as RawJSONLines);

      await waitUntil(() => onMessage.mock.calls.length === 1);
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: unhookedSessionId,
        uuid: 'assistant_auth_failure_before_session_start',
      }));

      const liveSessionId = '77777777-7777-4777-8777-777777777777';
      const liveTranscriptPath = join(projectDir, `${liveSessionId}.jsonl`);
      hook({
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_id: liveSessionId,
        transcript_path: liveTranscriptPath,
      });
      await appendJsonl(liveTranscriptPath, {
        type: 'assistant',
        uuid: 'assistant_from_trusted_session_start',
        timestamp: new Date().toISOString(),
        sessionId: liveSessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'trusted live session message' }],
        },
      } as RawJSONLines);

      await waitUntil(() => onMessage.mock.calls.length === 2);
      expect(onMessage).toHaveBeenLastCalledWith(expect.objectContaining({
        sessionId: liveSessionId,
        uuid: 'assistant_from_trusted_session_start',
      }));
    } finally {
      await bridge.dispose();
    }
  });

  it('ignores metadata probe transcripts before binding to the trusted SessionStart transcript', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-probe-'));
    tempDirs.push(dir);
    const workspaceDir = join(dir, 'workspace');
    const claudeConfigDir = join(dir, 'claude-config');
    await mkdir(workspaceDir, { recursive: true });
    const projectDir = getProjectPath(workspaceDir, claudeConfigDir);
    await mkdir(projectDir, { recursive: true });

    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: null,
      transcriptPath: null,
      workingDirectory: workspaceDir,
      claudeConfigDir,
      onMessage,
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      const probeSessionId = '44444444-4444-4444-8444-444444444444';
      await appendJsonl(join(projectDir, `${probeSessionId}.jsonl`), {
        type: 'user',
        uuid: 'metadata_probe_user',
        timestamp: new Date().toISOString(),
        sessionId: probeSessionId,
        message: {
          role: 'user',
          content: 'hello',
        },
      } as RawJSONLines);

      await waitMs(1_250);
      expect(onMessage).not.toHaveBeenCalled();

      const liveSessionId = '55555555-5555-4555-8555-555555555555';
      const liveTranscriptPath = join(projectDir, `${liveSessionId}.jsonl`);
      hook({
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_id: liveSessionId,
        transcript_path: liveTranscriptPath,
      });
      await appendJsonl(liveTranscriptPath, {
        type: 'assistant',
        uuid: 'assistant_from_live_tui',
        timestamp: new Date().toISOString(),
        sessionId: liveSessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'LANE_T_LINUX_CONNECTED_SERVICE_OK' }],
        },
      } as RawJSONLines);

      await waitUntil(() => onMessage.mock.calls.length === 1);
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: liveSessionId,
        uuid: 'assistant_from_live_tui',
      }));
    } finally {
      await bridge.dispose();
    }
  });

  it('does not import later unrelated Claude sessions after binding a fresh unified transcript', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-binding-'));
    tempDirs.push(dir);
    const workspaceDir = join(dir, 'workspace');
    const claudeConfigDir = join(dir, 'claude-config');
    await mkdir(workspaceDir, { recursive: true });
    const projectDir = getProjectPath(workspaceDir, claudeConfigDir);
    await mkdir(projectDir, { recursive: true });

    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: null,
      transcriptPath: null,
      workingDirectory: workspaceDir,
      claudeConfigDir,
      onMessage,
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      const firstSessionId = '22222222-2222-4222-8222-222222222222';
      const firstTranscriptPath = join(projectDir, `${firstSessionId}.jsonl`);
      hook({
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_id: firstSessionId,
        transcript_path: firstTranscriptPath,
      });
      await appendJsonl(firstTranscriptPath, {
        type: 'assistant',
        uuid: 'assistant_from_bound_session',
        timestamp: new Date().toISOString(),
        sessionId: firstSessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'belongs to this Happier session' }],
        },
      } as RawJSONLines);

      await waitUntil(() => onMessage.mock.calls.length === 1);
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: firstSessionId,
        uuid: 'assistant_from_bound_session',
      }));

      const secondSessionId = '33333333-3333-4333-8333-333333333333';
      const secondTranscriptPath = join(projectDir, `${secondSessionId}.jsonl`);
      await appendJsonl(secondTranscriptPath, {
        type: 'assistant',
        uuid: 'assistant_from_other_session',
        timestamp: new Date().toISOString(),
        sessionId: secondSessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'belongs to a different Happier session' }],
        },
      } as RawJSONLines);

      await waitMs(1_250);
      expect(onMessage).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.dispose();
    }
  });

  it('seeds hook-driven resume backfill from committed Claude JSONL keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-committed-keys-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, 'sess_committed_keys.jsonl');
    await mkdir(dir, { recursive: true });
    await writeFile(transcriptPath, '');

    await appendJsonl(transcriptPath, {
      type: 'assistant',
      uuid: 'already_committed',
      timestamp: new Date(Date.now() - 30_000).toISOString(),
      sessionId: 'sess_committed_keys',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'already in Happier' }],
      },
    } as RawJSONLines);
    await appendJsonl(transcriptPath, {
      type: 'assistant',
      uuid: 'missing_while_runner_was_down',
      timestamp: new Date(Date.now() - 20_000).toISOString(),
      sessionId: 'sess_committed_keys',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'missing from Happier' }],
      },
    } as RawJSONLines);

    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: 'sess_committed_keys',
      transcriptPath,
      workingDirectory: dir,
      onMessage,
      loadCommittedClaudeJsonlMessageBaseline: async () => ({
        keys: new Set(['main:assistant:already_committed']),
        complete: true,
        oldestCoveredAtMs: null,
      }),
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });

      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({
        hook_event_name: 'SessionStart',
        source: 'resume',
        session_id: 'sess_committed_keys',
        transcript_path: transcriptPath,
      });

      await waitUntil(() => onMessage.mock.calls.length === 1);
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
        uuid: 'missing_while_runner_was_down',
      }));
    } finally {
      await bridge.dispose();
    }
  });

  // Lane N4 (incident pid-44935): a same-session resume re-sent 104 historical rows because the
  // committed-keys baseline only covers the most recent transcript window. Rows OLDER than the
  // baseline coverage cannot be proven uncommitted, so they must never replay-as-new; rows newer
  // than the coverage (written while the runner was down) still backfill.
  it('does not replay snapshot rows older than the committed baseline coverage window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-coverage-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, 'sess_coverage.jsonl');
    await mkdir(dir, { recursive: true });
    await writeFile(transcriptPath, '');

    const nowMs = Date.now();
    await appendJsonl(transcriptPath, {
      type: 'assistant',
      uuid: 'older_than_coverage',
      timestamp: new Date(nowMs - 2 * 60 * 60 * 1000).toISOString(),
      sessionId: 'sess_coverage',
      message: { role: 'assistant', content: [{ type: 'text', text: 'old committed history' }] },
    } as RawJSONLines);
    await appendJsonl(transcriptPath, {
      type: 'assistant',
      uuid: 'missed_during_downtime',
      timestamp: new Date(nowMs - 20_000).toISOString(),
      sessionId: 'sess_coverage',
      message: { role: 'assistant', content: [{ type: 'text', text: 'missing from Happier' }] },
    } as RawJSONLines);

    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: 'sess_coverage',
      transcriptPath,
      workingDirectory: dir,
      onMessage,
      loadCommittedClaudeJsonlMessageBaseline: async () => ({
        keys: new Set<string>(),
        complete: false,
        oldestCoveredAtMs: nowMs - 60_000,
      }),
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');
      hook({
        hook_event_name: 'SessionStart',
        source: 'resume',
        session_id: 'sess_coverage',
        transcript_path: transcriptPath,
      });

      await waitUntil(() => onMessage.mock.calls.length >= 1);
      await waitMs(150);
      expect(onMessage.mock.calls.map(([message]) => (message as { uuid?: string }).uuid)).toEqual([
        'missed_during_downtime',
      ]);
    } finally {
      await bridge.dispose();
    }
  });

  it('fails closed when the committed baseline cannot be loaded: no replay-as-new, live rows still flow', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-baseline-failure-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, 'sess_baseline_failure.jsonl');
    await mkdir(dir, { recursive: true });
    await writeFile(transcriptPath, '');

    await appendJsonl(transcriptPath, {
      type: 'assistant',
      uuid: 'historical_row',
      timestamp: new Date(Date.now() - 30_000).toISOString(),
      sessionId: 'sess_baseline_failure',
      message: { role: 'assistant', content: [{ type: 'text', text: 'history' }] },
    } as RawJSONLines);

    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: 'sess_baseline_failure',
      transcriptPath,
      workingDirectory: dir,
      onMessage,
      loadCommittedClaudeJsonlMessageBaseline: async () => {
        throw new Error('baseline channel not connected');
      },
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');
      hook({
        hook_event_name: 'SessionStart',
        source: 'resume',
        session_id: 'sess_baseline_failure',
        transcript_path: transcriptPath,
      });

      await waitMs(250);
      expect(onMessage).not.toHaveBeenCalled();

      await appendJsonl(transcriptPath, {
        type: 'assistant',
        uuid: 'live_row_after_resume',
        timestamp: new Date().toISOString(),
        sessionId: 'sess_baseline_failure',
        message: { role: 'assistant', content: [{ type: 'text', text: 'live' }] },
      } as RawJSONLines);

      await waitUntil(() => onMessage.mock.calls.length === 1);
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'live_row_after_resume' }));
    } finally {
      await bridge.dispose();
    }
  });

  it('tracks SessionStart transcript path updates from Claude hooks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-hook-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, 'sess_2.jsonl');
    await mkdir(dir, { recursive: true });
    await writeFile(transcriptPath, '');

    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onSessionFound = vi.fn();
    const onMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: null,
      transcriptPath: null,
      workingDirectory: dir,
      onMessage,
      onSessionFound,
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({
        hook_event_name: 'SessionStart',
        session_id: 'sess_2',
        transcript_path: transcriptPath,
      });
      await appendJsonl(transcriptPath, {
        type: 'assistant',
        uuid: 'assistant_2',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello from hook transcript' }],
        },
      } as RawJSONLines);

      await waitUntil(() => onMessage.mock.calls.length === 1);
      expect(onSessionFound).toHaveBeenCalledWith('sess_2', expect.objectContaining({
        transcript_path: transcriptPath,
      }));
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'assistant',
        uuid: 'assistant_2',
      }));
    } finally {
      await bridge.dispose();
    }
  });

  it('replays live startup transcript rows already written before SessionStart binding', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-startup-backfill-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, 'sess_startup_backfill.jsonl');
    await mkdir(dir, { recursive: true });
    await writeFile(transcriptPath, '');
    await appendJsonl(transcriptPath, {
      type: 'user',
      uuid: 'startup_user_prompt',
      timestamp: new Date().toISOString(),
      sessionId: 'sess_startup_backfill',
      message: {
        role: 'user',
        content: 'Please reply exactly LANE_MAIN_MAC_TRANSCRIPT_OK and then stop.',
      },
    } as RawJSONLines);
    await appendJsonl(transcriptPath, {
      type: 'assistant',
      uuid: 'startup_assistant_reply',
      timestamp: new Date().toISOString(),
      sessionId: 'sess_startup_backfill',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'LANE_MAIN_MAC_TRANSCRIPT_OK' }],
        stop_reason: 'end_turn',
      },
    } as RawJSONLines);

    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: null,
      transcriptPath: null,
      workingDirectory: dir,
      onMessage,
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_id: 'sess_startup_backfill',
        transcript_path: transcriptPath,
      });

      await waitUntil(() => onMessage.mock.calls.length === 2);
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
        uuid: 'startup_user_prompt',
      }));
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
        uuid: 'startup_assistant_reply',
      }));
    } finally {
      await bridge.dispose();
    }
  });

  it('subscribes to SessionStart hooks before committed-key loading and scanner startup complete', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-early-hook-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, 'sess_early_hook.jsonl');
    await mkdir(dir, { recursive: true });
    await writeFile(transcriptPath, '');
    await appendJsonl(transcriptPath, {
      type: 'assistant',
      uuid: 'assistant_after_early_hook',
      timestamp: new Date().toISOString(),
      sessionId: 'sess_early_hook',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'LANE_MAIN_MAC_TRANSCRIPT_OK' }],
      },
    } as RawJSONLines);

    const committedKeys = createDeferred<ReadonlySet<string>>();
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: null,
      transcriptPath: null,
      workingDirectory: dir,
      onMessage,
      loadCommittedClaudeJsonlMessageBaseline: async () => ({ keys: await committedKeys.promise, complete: true, oldestCoveredAtMs: null }),
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      const startPromise = bridge.start({ abortSignal: new AbortController().signal });
      await Promise.resolve();
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_id: 'sess_early_hook',
        transcript_path: transcriptPath,
      });
      committedKeys.resolve(new Set());

      await startPromise;
      await waitUntil(() => onMessage.mock.calls.length === 1);
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
        uuid: 'assistant_after_early_hook',
      }));
    } finally {
      committedKeys.resolve(new Set());
      await bridge.dispose();
    }
  });

  it('drops buffered SessionStart hooks when disposed before scanner startup completes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-disposed-early-hook-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, 'sess_disposed_early_hook.jsonl');
    await mkdir(dir, { recursive: true });
    await writeFile(transcriptPath, '');
    await appendJsonl(transcriptPath, {
      type: 'assistant',
      uuid: 'assistant_after_disposed_early_hook',
      timestamp: new Date().toISOString(),
      sessionId: 'sess_disposed_early_hook',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'should not be emitted after dispose' }],
      },
    } as RawJSONLines);

    const committedKeys = createDeferred<ReadonlySet<string>>();
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: null,
      transcriptPath: null,
      workingDirectory: dir,
      onMessage,
      loadCommittedClaudeJsonlMessageBaseline: async () => ({ keys: await committedKeys.promise, complete: true, oldestCoveredAtMs: null }),
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    const startPromise = bridge.start({ abortSignal: new AbortController().signal });
    await Promise.resolve();
    const hook = subscribedHook;
    expect(hook).toBeTypeOf('function');
    if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

    hook({
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: 'sess_disposed_early_hook',
      transcript_path: transcriptPath,
    });

    await bridge.dispose();
    expect(subscribedHook).toBeUndefined();

    committedKeys.resolve(new Set());
    await startPromise;
    await waitMs(50);
    expect(onMessage).not.toHaveBeenCalled();
  });
});
