import { describe, expect, it, vi } from 'vitest';

import type { Session } from '../session';
import { createClaudeWorkflowActivitySourceForSession } from './createClaudeWorkflowActivitySourceForSession';

function createSessionStub(): Session {
  const runtimeActivityPublisher = {
    setSourceActive: vi.fn(async () => {}),
    observeSource: vi.fn(async () => {}),
    clearSource: vi.fn(async () => {}),
  };
  return {
    sessionId: 'happy-session-id',
    runtimeActivityPublisher,
    client: {
      sessionId: 'happy-session-id',
      getMetadataSnapshot: () => ({ claudeSessionId: 'claude-session-id' }),
      updateMetadata: vi.fn(),
      upsertSessionSystemRecord: vi.fn(),
      getStoredContentEncryptionContext: () => ({ mode: 'plain' }),
    },
  } as unknown as Session;
}

describe('createClaudeWorkflowActivitySourceForSession', () => {
  it('returns null when the session client cannot write system records', async () => {
    const session = createSessionStub();
    delete (session.client as unknown as Record<string, unknown>).upsertSessionSystemRecord;

    const source = await createClaudeWorkflowActivitySourceForSession({
      session,
      logPrefix: '[test]',
      getCurrentClaudeSessionId: () => null,
    });

    expect(source).toBeNull();
  });

  it('returns null when the session client cannot expose stored-content encryption context', async () => {
    const session = createSessionStub();
    delete (session.client as unknown as Record<string, unknown>).getStoredContentEncryptionContext;

    const source = await createClaudeWorkflowActivitySourceForSession({
      session,
      logPrefix: '[test]',
      getCurrentClaudeSessionId: () => null,
    });

    expect(source).toBeNull();
  });

  it('wires a live source through the session client transport and encryption context', async () => {
    const source = await createClaudeWorkflowActivitySourceForSession({
      session: createSessionStub(),
      logPrefix: '[test]',
      getCurrentClaudeSessionId: () => 'claude-session-id',
    });

    expect(source).not.toBeNull();
    // The composed source exposes the CWF surface (observe + CWF4 owned-id hook + lifecycle).
    expect(typeof source?.observeTranscriptMessage).toBe('function');
    expect(source?.getWorkflowOwnedAgentToolUseIds()).toBeInstanceOf(Set);

    source?.dispose();
  });

  it('passes the session runtime activity publisher into the workflow source', async () => {
    const session = createSessionStub();
    const source = await createClaudeWorkflowActivitySourceForSession({
      session,
      logPrefix: '[test]',
      getCurrentClaudeSessionId: () => 'claude-session-id',
    });

    source?.observeTranscriptMessage({
      type: 'assistant',
      session_id: 'claude-session-id',
      uuid: 'uuid-toolu-wf',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_wf',
            name: 'Workflow',
            input: { script: "export const meta = { name: 'wf' }" },
          },
        ],
      },
    });

    await vi.waitFor(() => {
      expect(session.runtimeActivityPublisher.setSourceActive).toHaveBeenCalledWith({
        id: 'claude:provider-task:toolu_wf',
        sourceClass: 'provider_detached_task',
        providerId: 'claude',
      });
    });

    source?.dispose();
  });
});
