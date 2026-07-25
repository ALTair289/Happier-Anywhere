import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSelfHostCli } from '../scripts/self_host_runtime.mjs';

function parseJsonLinesBestEffort(stdout) {
  const out = String(stdout ?? '');
  try {
    return JSON.parse(out);
  } catch {
    // fall through
  }
  const lines = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {
      continue;
    }
  }
  return null;
}

async function runSelfHost(args, { homeDir }) {
  const originalHome = process.env.HOME;
  const originalForward = process.env.HAPPIER_STACK_SELF_HOST_FORWARD;
  let stdout = '';

  process.env.HOME = homeDir;
  // Exercise this legacy entrypoint directly; forwarding to a separately installed
  // `happier` CLI is an external-system boundary covered by its own CLI tests.
  process.env.HAPPIER_STACK_SELF_HOST_FORWARD = '0';

  try {
    await runSelfHostCli(args, {
      configOutput: {
        write(chunk) {
          stdout += String(chunk);
          return true;
        },
      },
    });
    return stdout;
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalForward === undefined) delete process.env.HAPPIER_STACK_SELF_HOST_FORWARD;
    else process.env.HAPPIER_STACK_SELF_HOST_FORWARD = originalForward;
  }
}

test('self-host config commands share one hermetic runtime fixture', async (t) => {
  const viewHomeDir = mkdtempSync(join(tmpdir(), 'hstack-selfhost-config-view-'));
  const previewHomeDir = mkdtempSync(join(tmpdir(), 'hstack-selfhost-config-preview-view-'));
  const setHomeDir = mkdtempSync(join(tmpdir(), 'hstack-selfhost-config-set-'));
  t.after(() => {
    for (const homeDir of [viewHomeDir, previewHomeDir, setHomeDir]) {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  const viewOutput = await runSelfHost(['config', 'view', '--json'], { homeDir: viewHomeDir });
  const previewOutput = await runSelfHost(['config', 'view', '--channel', 'preview', '--json'], { homeDir: previewHomeDir });
  const setOutput = await runSelfHost(
    ['config', 'set', '--no-apply', '--auto-update', '--auto-update-at', '03:15', '--env', 'PORT=3999', '--json'],
    { homeDir: setHomeDir },
  );
  const persistedOutput = await runSelfHost(['config', 'view', '--json'], { homeDir: setHomeDir });

  await t.test('view prints effective config', () => {
    const parsed = parseJsonLinesBestEffort(viewOutput);
    assert.equal(parsed?.ok, true);
    assert.equal(typeof parsed?.paths?.statePath, 'string');
    assert.equal(typeof parsed?.autoUpdate?.enabled, 'boolean');
  });

  await t.test('view accepts spaced --channel preview arguments', () => {
    const parsed = parseJsonLinesBestEffort(previewOutput);
    assert.equal(parsed?.ok, true);
    assert.equal(parsed?.channel, 'preview');
    assert.match(String(parsed?.paths?.installRoot ?? ''), /self-host-preview$/);
  });

  await t.test('set updates auto-update schedule and env overrides', () => {
    assert.equal(parseJsonLinesBestEffort(setOutput)?.ok, true);
    const parsed = parseJsonLinesBestEffort(persistedOutput);
    assert.equal(parsed?.autoUpdate?.enabled, true);
    assert.equal(parsed?.autoUpdate?.at, '03:15');
    assert.equal(parsed?.env?.PORT, '3999');
  });
});
