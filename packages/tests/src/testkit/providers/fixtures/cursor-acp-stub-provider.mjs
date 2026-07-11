#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { replayRepresentativeCursorLifecycle } from './cursor-acp-captured-replay-v1.mjs';

const decoder = new TextDecoder();
let buffer = '';
let pendingPromptId = null;
const sessions = new Map();
const extensionState = {
  pending: false,
  todosDone: false,
  planDone: false,
};

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function homeDir() {
  return process.env.HAPPIER_HOME_DIR || process.env.HOME || process.cwd();
}

function callsPath() {
  return join(homeDir(), 'cursor-acp-stub', 'config-calls.json');
}

function appendConfigCall(call) {
  const path = callsPath();
  mkdirSync(dirname(path), { recursive: true });
  let calls = [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    calls = Array.isArray(parsed.calls) ? parsed.calls : [];
  } catch {
    calls = [];
  }
  calls.push(call);
  writeFileSync(path, JSON.stringify({ calls }, null, 2), 'utf8');
}

function initialConfigOptions() {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'default[]',
      options: [
        {
          group: 'cursor',
          name: 'Cursor',
          options: [
            { value: 'default[]', name: 'Default' },
            {
              value: 'gpt-5.1-codex-max[reasoning=medium,fast=false]',
              name: 'GPT-5.1 Codex Max',
            },
          ],
        },
      ],
    },
    {
      id: 'fast',
      name: 'Fast Mode',
      type: 'select',
      currentValue: 'false',
      options: [
        { value: 'false', name: 'False' },
        { value: 'true', name: 'True' },
      ],
    },
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'ask',
      options: [
        { value: 'ask', name: 'Ask' },
        { value: 'plan', name: 'Plan' },
      ],
    },
  ];
}

function ensureSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { configOptions: initialConfigOptions() });
  }
  return sessions.get(sessionId);
}

function readPromptText(prompt) {
  if (!Array.isArray(prompt)) return '';
  const parts = [];
  for (const block of prompt) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

function sendSessionUpdate(sessionId, update) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update },
  });
}

function runCapturedLifecycleReplay(id, sessionId) {
  replayRepresentativeCursorLifecycle((update) => sendSessionUpdate(sessionId, update));
  sendSessionUpdate(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'CURSOR_CAPTURED_REPLAY_DONE' },
  });
  ok(id, { stopReason: 'end_turn' });
}

function updateConfigOption(session, configId, value) {
  session.configOptions = session.configOptions.map((option) => {
    if (!option || typeof option !== 'object' || option.id !== configId) return option;
    return { ...option, currentValue: value };
  });
}

function finishExtensionPromptIfDone() {
  if (!extensionState.pending || !extensionState.todosDone || !extensionState.planDone || pendingPromptId === null) {
    return;
  }
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 'cursor-stub-session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'ACP_STUB_CURSOR_EXTENSION_UX_DONE' },
      },
    },
  });
  ok(pendingPromptId, { stopReason: 'end_turn' });
  pendingPromptId = null;
  extensionState.pending = false;
}

function handleResponse(message) {
  if (message.id === 'cursor-stub-todos') {
    extensionState.todosDone = true;
    finishExtensionPromptIfDone();
    return;
  }
  if (message.id === 'cursor-stub-plan') {
    extensionState.planDone = true;
    finishExtensionPromptIfDone();
  }
}

function startExtensionUxPrompt(id) {
  pendingPromptId = id;
  extensionState.pending = true;
  extensionState.todosDone = false;
  extensionState.planDone = false;

  send({
    jsonrpc: '2.0',
    method: 'cursor/update_todos',
    params: {
      toolCallId: 'cursor-stub-todos-notification',
      todos: [
        {
          id: 'todo-1',
          content: 'Review Cursor ACP config payload',
          status: 'inProgress',
        },
      ],
    },
  });

  send({
    jsonrpc: '2.0',
    id: 'cursor-stub-todos',
    method: 'cursor/update_todos',
    params: {
      toolCallId: 'cursor-stub-todos',
      todos: [
        {
          id: 'todo-1',
          content: 'Review Cursor ACP config payload',
          status: 'completed',
        },
      ],
    },
  });

  send({
    jsonrpc: '2.0',
    id: 'cursor-stub-plan',
    method: 'cursor/create_plan',
    params: {
      toolCallId: 'cursor-stub-plan',
      name: 'Cursor Stub Plan',
      plan: '# Cursor Stub Plan\n\n1. Verify extension UX parity.',
      todos: [],
    },
  });
}

function handleRequest(req) {
  const { id, method, params } = req;
  if (id === undefined || id === null || typeof method !== 'string') return;

  if (method === 'initialize') {
    ok(id, {
      protocolVersion: 1,
      authMethods: [{ id: 'cursor_login', name: 'Cursor Login' }],
      agentCapabilities: { loadSession: true },
    });
    return;
  }

  if (method === 'authenticate') {
    ok(id, {});
    return;
  }

  if (method === 'session/new') {
    const sessionId = 'cursor-stub-session';
    const session = ensureSession(sessionId);
    ok(id, { sessionId, configOptions: session.configOptions });
    return;
  }

  if (method === 'session/load') {
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : 'cursor-stub-session';
    const session = ensureSession(sessionId);
    ok(id, { configOptions: session.configOptions });
    return;
  }

  if (method === 'session/set_config_option') {
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : 'cursor-stub-session';
    const configId = typeof params?.configId === 'string' ? params.configId : '';
    const value = params && typeof params === 'object' && 'value' in params ? params.value : '';
    const session = ensureSession(sessionId);
    appendConfigCall({ configId, value });
    updateConfigOption(session, configId, value);
    ok(id, { configOptions: session.configOptions });
    return;
  }

  if (method === 'session/prompt') {
    const text = readPromptText(params?.prompt);
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : 'cursor-stub-session';
    if (text.includes('CURSOR_STUB_CAPTURED_REPLAY=1')) {
      runCapturedLifecycleReplay(id, sessionId);
      return;
    }
    if (text.includes('CURSOR_STUB_EXTENSION_UX=1')) {
      startExtensionUxPrompt(id);
      return;
    }

    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'ACP_STUB_CURSOR_READY_DONE' },
        },
      },
    });
    ok(id, { stopReason: 'end_turn', ext: randomUUID() });
    return;
  }

  if (method === 'session/cancel') {
    ok(id, {});
    return;
  }

  ok(id, {});
}

process.stdin.on('data', (chunk) => {
  buffer += decoder.decode(chunk, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!message || typeof message !== 'object') continue;
    if (!('method' in message) && 'id' in message) {
      handleResponse(message);
      continue;
    }

    handleRequest(message);
  }
});
