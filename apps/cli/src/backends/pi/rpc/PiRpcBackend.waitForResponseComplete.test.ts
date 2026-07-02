import { afterEach, describe, expect, it } from 'vitest';

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';

import { PiRpcBackend } from './PiRpcBackend';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeFakePiRpcExitMidTurnScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-exit-mid-turn.js');
  const script = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');

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
      out({
        id: command.id,
        type: 'response',
        command: 'get_state',
        success: true,
        data: {
          sessionId: 'pi-session-exit-mid-turn',
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
    case 'prompt':
      out({ id: command.id, type: 'response', command: 'prompt', success: true });
      setTimeout(() => {
        process.exit(1);
      }, 25);
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

function makeFakePiRpcPreStartStaleFailureScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-pre-start-stale-failure.js');
  const script = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');

rl.on('line', (line) => {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }

  switch (command.type) {
    case 'new_session':
      out({ id: command.id, type: 'response', command: 'new_session', success: true, data: { sessionId: 'pi-session-stale-failure', cancelled: false } });
      break;
    case 'get_state':
      out({
        id: command.id,
        type: 'response',
        command: 'get_state',
        success: true,
        data: {
          sessionId: 'pi-session-stale-failure',
          model: { id: 'gpt-5.5', provider: 'openai-codex', name: 'GPT-5.5' },
          isStreaming: false,
          isCompacting: false
        }
      });
      break;
    case 'get_available_models':
      out({
        id: command.id,
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: { models: [{ id: 'gpt-5.5', provider: 'openai-codex', name: 'GPT-5.5' }] }
      });
      break;
    case 'get_commands':
      out({ id: command.id, type: 'response', command: 'get_commands', success: true, data: { commands: [] } });
      break;
    case 'prompt':
      out({ id: command.id, type: 'response', command: 'prompt', success: true });
      setTimeout(() => {
        out({
          type: 'message_end',
          provider: 'openai-codex',
          message: {
            role: 'assistant',
            provider: 'openai-codex',
            stopReason: 'error',
            errorMessage: 'Usage limit reached. Please try again in 2m30s.'
          }
        });
      }, 5);
      setTimeout(() => {
        out({ type: 'agent_start' });
      }, 20);
      setTimeout(() => {
        out({
          type: 'message_end',
          message: {
            role: 'assistant',
            stopReason: 'end_turn',
            content: [{ type: 'text', text: 'done' }]
          }
        });
      }, 30);
      setTimeout(() => {
        out({ type: 'agent_end' });
      }, 40);
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

function makeFakePiRpcPromptAckErrorThenStartScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-prompt-ack-error-then-start.js');
  const script = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');

rl.on('line', (line) => {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }

  switch (command.type) {
    case 'new_session':
      out({ id: command.id, type: 'response', command: 'new_session', success: true, data: { sessionId: 'pi-session-ack-race', cancelled: false } });
      break;
    case 'get_state':
      out({
        id: command.id,
        type: 'response',
        command: 'get_state',
        success: true,
        data: {
          sessionId: 'pi-session-ack-race',
          model: { id: 'gpt-5.5', provider: 'openai-codex', name: 'GPT-5.5' },
          isStreaming: false,
          isCompacting: false
        }
      });
      break;
    case 'get_available_models':
      out({
        id: command.id,
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: { models: [{ id: 'gpt-5.5', provider: 'openai-codex', name: 'GPT-5.5' }] }
      });
      break;
    case 'get_commands':
      out({ id: command.id, type: 'response', command: 'get_commands', success: true, data: { commands: [] } });
      break;
    case 'prompt':
      out({ id: command.id, type: 'response', command: 'prompt', success: false, error: 'Prompt ACK raced with resumed session state' });
      setTimeout(() => {
        out({ type: 'agent_start' });
      }, 50);
      setTimeout(() => {
        out({
          type: 'message_end',
          message: {
            role: 'assistant',
            stopReason: 'end_turn',
            content: [{ type: 'text', text: 'done' }]
          }
        });
      }, 80);
      setTimeout(() => {
        out({ type: 'agent_end' });
      }, 100);
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

describe('PiRpcBackend.waitForResponseComplete', () => {
  let tempDir: string | null = null;
  let backend: PiRpcBackend | null = null;

  afterEach(async () => {
    if (backend) {
      await backend.dispose();
      backend = null;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('rejects sendPrompt when the underlying Pi process exits during a turn', async () => {
    tempDir = makeTempDir('happier-pi-rpc-exit-mid-turn-');
    const scriptPath = makeFakePiRpcExitMidTurnScript(tempDir);

    backend = new PiRpcBackend({
      cwd: tempDir,
      command: process.execPath,
      args: [scriptPath],
    });

    const started = await backend.startSession();
    const promptError = backend.sendPrompt(started.sessionId, 'hello').catch((error) => error as Error);

    await expect(promptError).resolves.toMatchObject({
      message: expect.stringMatching(/Pi process (exited|terminated)/i),
    });
  });

  it('ignores a classified pre-start stale assistant failure when the accepted prompt starts and completes', async () => {
    tempDir = makeTempDir('happier-pi-rpc-pre-start-stale-failure-');
    const scriptPath = makeFakePiRpcPreStartStaleFailureScript(tempDir);

    backend = new PiRpcBackend({
      cwd: tempDir,
      command: process.execPath,
      args: [scriptPath],
      env: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
          {
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'codex-main',
            activeProfileId: 'codex-primary',
            fallbackProfileId: 'codex-backup',
            generation: 9,
          },
        ]),
      },
    });

    const started = await backend.startSession();

    await expect(backend.sendPrompt(started.sessionId, 'hello')).resolves.toBeUndefined();
  });

  it('waits for the accepted turn when a resumed Pi prompt ACK races before agent_start', async () => {
    tempDir = makeTempDir('happier-pi-rpc-prompt-ack-race-');
    const scriptPath = makeFakePiRpcPromptAckErrorThenStartScript(tempDir);

    backend = new PiRpcBackend({
      cwd: tempDir,
      command: process.execPath,
      args: [scriptPath],
    });

    const started = await backend.startSession();

    await expect(backend.sendPrompt(started.sessionId, 'hello')).resolves.toBeUndefined();
  });
});
