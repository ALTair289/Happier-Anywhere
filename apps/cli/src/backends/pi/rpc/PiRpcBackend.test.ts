import { afterEach, describe, expect, it } from 'vitest';

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PiRpcBackend } from './PiRpcBackend';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeFakePiRpcAgentEndUnknownStateScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-agent-end-unknown-state.js');
  const script = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');

let agentEnded = false;

rl.on('line', (line) => {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }

  switch (command.type) {
    case 'new_session':
      out({ id: command.id, type: 'response', command: 'new_session', success: true, data: { cancelled: false } });
      break;
    case 'get_state':
      if (agentEnded) {
        return;
      }
      out({
        id: command.id,
        type: 'response',
        command: 'get_state',
        success: true,
        data: {
          sessionId: 'pi-session-agent-end-unknown',
          isStreaming: false,
          isCompacting: false,
          model: { id: 'gpt-4o-mini', provider: 'openai', name: 'GPT-4o mini' }
        }
      });
      break;
    case 'get_available_models':
      out({
        id: command.id,
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: { models: [{ id: 'gpt-4o-mini', provider: 'openai', name: 'GPT-4o mini' }] }
      });
      break;
    case 'get_commands':
      out({ id: command.id, type: 'response', command: 'get_commands', success: true, data: { commands: [] } });
      break;
    case 'get_session_stats':
      out({ id: command.id, type: 'response', command: 'get_session_stats', success: true, data: { sessionId: 'pi-session-agent-end-unknown' } });
      break;
    case 'prompt':
      out({ id: command.id, type: 'response', command: 'prompt', success: true });
      out({ type: 'agent_start' });
      setTimeout(() => {
        agentEnded = true;
        out({ type: 'agent_end' });
      }, 5);
      break;
    default:
      out({ id: command.id, type: 'response', command: command.type, success: true });
      break;
  }
});
`;
  writeFileSync(scriptPath, script, 'utf8');
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

describe('PiRpcBackend', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not resolve agent_end as successful completion when the settlement get_state probe times out', async () => {
    const workDir = makeTempDir('happier-pi-rpc-agent-end-unknown-');
    tempDirs.push(workDir);
    const fakeScript = writeFakePiRpcAgentEndUnknownStateScript(workDir);
    const messages: unknown[] = [];

    const backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fakeScript],
      env: {
        HAPPIER_PI_RPC_AGENT_END_SETTLE_MS: '1',
        HAPPIER_PI_RPC_LIVENESS_PROBE_TIMEOUT_MS: '5',
        HAPPIER_PI_RPC_MAX_SILENT_PROBES: '1',
      },
    });
    backend.onMessage((message) => {
      messages.push(message);
    });

    try {
      const session = await backend.startSession();

      await expect(backend.sendPrompt(session.sessionId, 'hello')).rejects.toThrow(
        'Timed out waiting for Pi turn completion',
      );
      const runningIndex = messages.findIndex((message) => (
        Boolean(message && typeof message === 'object')
        && (message as { type?: unknown; status?: unknown }).type === 'status'
        && (message as { type?: unknown; status?: unknown }).status === 'running'
      ));
      expect(runningIndex).toBeGreaterThan(-1);
      expect(messages.slice(runningIndex + 1)).not.toContainEqual(expect.objectContaining({
        type: 'status',
        status: 'idle',
      }));
      expect(messages).toContainEqual(expect.objectContaining({
        type: 'status',
        status: 'error',
      }));
    } finally {
      await backend.dispose();
    }
  });
});
