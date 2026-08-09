import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { summarizeReleaseStatus } from './summarize-release-status.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('./summarize-release-status.mjs', import.meta.url));

const SOURCE_SHA = 'a'.repeat(40);

function input(overrides = {}) {
  return {
    run: 42,
    channel: 'stable',
    sourceSha: SOURCE_SHA,
    requestedSurfaces: [
      { id: 'npm', required: true },
      { id: 'deploy', required: true },
    ],
    surfaces: [
      {
        id: 'npm',
        result: 'success',
        identity: { verified: true, version: '1.2.3', digest: 'sha512:npm' },
      },
      {
        id: 'deploy',
        result: 'success',
        identity: { verified: true, revision: SOURCE_SHA },
      },
    ],
    ...overrides,
  };
}

test('all requested required surfaces with exact owner verification are complete', () => {
  assert.deepEqual(summarizeReleaseStatus(input()), {
    schemaVersion: 1,
    kind: 'happier.release-status.v1',
    run: 42,
    channel: 'stable',
    sourceSha: SOURCE_SHA,
    surfaces: [
      {
        id: 'npm',
        requested: true,
        required: true,
        state: 'complete',
        result: 'success',
        identity: { digest: 'sha512:npm', verified: true, version: '1.2.3' },
      },
      {
        id: 'deploy',
        requested: true,
        required: true,
        state: 'complete',
        result: 'success',
        identity: { revision: SOURCE_SHA, verified: true },
      },
    ],
    terminal: 'complete',
  });
});

test('surface output follows requested catalog order, not observation order', () => {
  const result = summarizeReleaseStatus(input({
    surfaces: [
      { id: 'deploy', result: 'success', identity: { verified: true } },
      { id: 'npm', result: 'success', identity: { verified: true } },
    ],
  }));
  assert.deepEqual(result.surfaces.map((surface) => surface.id), ['npm', 'deploy']);
});

test('summary JSON is deterministic for equivalent observation order and metadata key order', () => {
  const first = summarizeReleaseStatus(input({
    surfaces: [
      { id: 'deploy', result: 'success', identity: { verified: true, revision: SOURCE_SHA } },
      { id: 'npm', result: 'success', identity: { version: '1.2.3', verified: true } },
    ],
  }));
  const second = summarizeReleaseStatus(input({
    surfaces: [
      { id: 'npm', result: 'success', identity: { verified: true, version: '1.2.3' } },
      { id: 'deploy', result: 'success', identity: { revision: SOURCE_SHA, verified: true } },
    ],
  }));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('accepted or unverified outcomes are partial even when a recovery hint is present', () => {
  const result = summarizeReleaseStatus(input({
    requestedSurfaces: [{ id: 'mobile', required: true }],
    surfaces: [{
      id: 'mobile',
      result: 'accepted',
      identity: { verified: true, buildId: 'eas-123' },
      recoveryHint: { workflow: 'publish-mobile', inputs: { retry: 'eas-123' } },
    }],
  }));
  assert.equal(result.surfaces[0].state, 'partial');
  assert.equal(result.terminal, 'partial');
  assert.deepEqual(result.surfaces[0].recoveryHint, {
    inputs: { retry: 'eas-123' },
    workflow: 'publish-mobile',
  });
});

test('failed required surface is terminally failed', () => {
  const result = summarizeReleaseStatus(input({
    requestedSurfaces: [{ id: 'docker', required: true }],
    surfaces: [{
      id: 'docker',
      result: 'failed',
      recoveryHint: { workflow: 'publish-docker', inputs: { sha: SOURCE_SHA } },
    }],
  }));
  assert.deepEqual(result.surfaces[0], {
    id: 'docker',
    requested: true,
    required: true,
    state: 'failed',
    result: 'failed',
    recoveryHint: { inputs: { sha: SOURCE_SHA }, workflow: 'publish-docker' },
  });
  assert.equal(result.terminal, 'failed');
});

test('missing or skipped optional surfaces are partial, while an explicitly unrequested surface is not_requested', () => {
  const result = summarizeReleaseStatus({
    run: 'nightly-7',
    channel: 'dev',
    sourceSha: SOURCE_SHA,
    requestedSurfaces: [
      { id: 'npm', required: true },
      { id: 'mobile', required: false },
      { id: 'desktop', requested: false, required: true },
    ],
    surfaces: [
      { id: 'npm', result: 'success', identity: { verified: true } },
      { id: 'mobile', result: 'skipped' },
      { id: 'desktop', result: 'failed', identity: { verified: false } },
    ],
  });
  assert.deepEqual(result.surfaces.map((surface) => ({ id: surface.id, state: surface.state })), [
    { id: 'npm', state: 'complete' },
    { id: 'mobile', state: 'partial' },
    { id: 'desktop', state: 'not_requested' },
  ]);
  assert.equal(result.terminal, 'partial');
});

test('intentionally unrequested skipped and failed observations do not make an otherwise complete release terminally fail', () => {
  const result = summarizeReleaseStatus(input({
    requestedSurfaces: [
      { id: 'candidate-verification', required: true },
      { id: 'npm', requested: false, required: true },
      { id: 'release-verification', requested: false, required: true },
    ],
    surfaces: [
      { id: 'candidate-verification', result: 'success', identity: { verified: true } },
      { id: 'npm', result: 'skipped' },
      { id: 'release-verification', result: 'failed' },
    ],
  }));

  assert.deepEqual(result.surfaces.map((surface) => ({ id: surface.id, state: surface.state })), [
    { id: 'candidate-verification', state: 'complete' },
    { id: 'npm', state: 'not_requested' },
    { id: 'release-verification', state: 'not_requested' },
  ]);
  assert.equal(result.terminal, 'complete');
});

test('unknown or duplicate observed surfaces fail closed', () => {
  assert.throws(() => summarizeReleaseStatus(input({
    surfaces: [{ id: 'unknown', result: 'success', identity: { verified: true } }],
  })), /observed surface.*not declared/);
  assert.throws(() => summarizeReleaseStatus(input({
    surfaces: [
      { id: 'npm', result: 'success', identity: { verified: true } },
      { id: 'npm', result: 'success', identity: { verified: true } },
    ],
  })), /duplicate observed surface/);
});

test('input and observations use the explicit result enum', () => {
  assert.throws(() => summarizeReleaseStatus(input({
    surfaces: [{ id: 'npm', result: 'green', identity: { verified: true } }],
  })), /result/);
});

test('CLI reads stdin and writes JSON-only stdout', () => {
  const child = spawnSync(process.execPath, [SCRIPT_PATH], {
    input: JSON.stringify(input()),
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  assert.deepEqual(JSON.parse(child.stdout), summarizeReleaseStatus(input()));
});
