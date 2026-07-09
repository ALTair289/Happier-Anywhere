import { describe, expect, it, vi } from 'vitest';

import type { TerminalHostAdapter, TerminalHostHandle } from '@/integrations/terminalHost/_types';
import type { TerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import type { ClaudeEndpointState, DaemonSessionMarker } from '../sessionRegistry';
import { HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY } from '../sessionRegistry';
import {
  mergeClaudeEndpointStateIntoSpawnOptions,
  resolveClaudeEndpointRecoveryRespawnOptions,
} from './claudeEndpointStateEnv';

const endpointState: ClaudeEndpointState = {
  v: 1,
  hookServerPort: 43123,
  hookPluginDir: '/tmp/happier/hooks/session-sess-claude',
  hookSettingsPath: '/tmp/happier/hooks/session-hook.json',
  hookSettingsOverlayPath: '/tmp/happier/hooks/session-hook.overlay.json',
  statuslineSecretFilePath: '/tmp/happier/hooks/session-hook.statusline-secret',
  mcpUrl: 'http://127.0.0.1:43124',
  mcpPort: 43124,
};

const marker: DaemonSessionMarker = {
  pid: 111,
  happySessionId: 'sess-claude',
  happyHomeDir: '/tmp/happy',
  createdAt: 1,
  updatedAt: 1,
  startedBy: 'daemon',
  claudeEndpointState: endpointState,
};

const handle: TerminalHostHandle = {
  kind: 'tmux',
  sessionName: 'happier-sess-claude',
  paneId: 'claude.1',
  attachMetadata: {
    attachStrategy: 'terminal_host',
    topology: 'shared',
    locality: 'same_machine',
    liveProbe: 'required',
  },
};

const attachment: TerminalAttachmentInfo = {
  version: 1,
  sessionId: 'sess-claude',
  terminal: {
    mode: 'tmux',
    tmux: {
      target: 'happier-sess-claude:claude.1',
    },
  },
  updatedAt: 1,
};

describe('claude endpoint recovery respawn options', () => {
  it('uses one shared env derivation for Claude endpoint state', () => {
    const spawnOptions: SpawnSessionOptions = {
      directory: '/workspace/project',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      environmentVariables: { EXISTING: '1' },
    };

    expect(mergeClaudeEndpointStateIntoSpawnOptions(spawnOptions, endpointState)).toEqual({
      ...spawnOptions,
      environmentVariables: {
        EXISTING: '1',
        [HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY]: JSON.stringify(endpointState),
      },
    });
  });

  it('injects adopt endpoint env during mid-life respawn when the marker endpoint and terminal host are alive', async () => {
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      dispose: vi.fn(),
    };
    const defaultOptions: SpawnSessionOptions = {
      directory: '/workspace/project',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      existingSessionId: 'sess-claude',
      resume: 'claude-thread',
    };

    await expect(resolveClaudeEndpointRecoveryRespawnOptions({
      previousPid: 111,
      sessionId: 'sess-claude',
      defaultOptions,
      readSessionMarkerForPid: async () => marker,
      readTerminalAttachmentInfo: async () => attachment,
      removeTerminalAttachmentInfo: vi.fn(),
      terminalHostAdapters: { tmux: adapter },
    })).resolves.toEqual({
      ...defaultOptions,
      environmentVariables: {
        [HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY]: JSON.stringify(endpointState),
      },
    });

    expect(adapter.evaluateLiveness).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'tmux',
      sessionName: 'happier-sess-claude',
      paneId: 'claude.1',
    }));
  });

  it('does not inject adopt endpoint env when the retained terminal host is not alive', async () => {
    const removeTerminalAttachmentInfo = vi.fn(async () => true);
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: false, paneDead: true, observedAt: 1 })),
      dispose: vi.fn(),
    };
    const defaultOptions: SpawnSessionOptions = {
      directory: '/workspace/project',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      existingSessionId: 'sess-claude',
    };

    await expect(resolveClaudeEndpointRecoveryRespawnOptions({
      previousPid: 111,
      sessionId: 'sess-claude',
      defaultOptions,
      readSessionMarkerForPid: async () => marker,
      readTerminalAttachmentInfo: async () => attachment,
      removeTerminalAttachmentInfo,
      terminalHostAdapters: { tmux: adapter },
    })).resolves.toBe(defaultOptions);

    expect(removeTerminalAttachmentInfo).toHaveBeenCalledWith({
      happyHomeDir: '/tmp/happy',
      sessionId: 'sess-claude',
      expectedTerminal: attachment.terminal,
    });
  });
});
