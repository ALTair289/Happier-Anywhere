import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('tests workflow runs for pushes to the integration branch', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
  const pushTrigger = raw.slice(0, raw.indexOf('  workflow_call:'));

  assert.match(
    pushTrigger,
    /^\s*-\s+integration\s*$/m,
    'tests.yml should validate each integration push instead of waiting for a scheduled or manual run',
  );
});

test('tests workflow bounds CLI unit test memory with eight isolated shards', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');

  for (let shard = 1; shard <= 8; shard += 1) {
    assert.match(
      raw,
      new RegExp(
        `yarn workspace @happier-dev/cli vitest run --config vitest\\.config\\.ts --no-file-parallelism --shard=${shard}/8`,
      ),
      `tests.yml should run CLI unit shard ${shard}/8 in its own bounded process`,
    );
  }

  assert.doesNotMatch(
    raw,
    /--shard=[123]\/3/,
    'tests.yml should not retain the three oversized CLI unit shards',
  );
});

test('tests workflow gives large server, CLI, and stack suites enough time to finish', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
  const lanes = [
    { name: 'server', next: 'server-db-contract' },
    { name: 'cli', next: 'stack' },
    { name: 'stack', next: 'release-contracts' },
  ];

  for (const lane of lanes) {
    const start = raw.indexOf(`\n  ${lane.name}:`);
    const end = raw.indexOf(`\n  ${lane.next}:`, start + 1);

    assert.notEqual(start, -1, `tests.yml should define the ${lane.name} job`);
    assert.notEqual(end, -1, `tests.yml should define the ${lane.next} job after ${lane.name}`);
    assert.match(
      raw.slice(start, end),
      /timeout-minutes:\s*45/,
      `tests.yml ${lane.name} job should allow dependency installation and its full test suite to finish`,
    );
  }
});

test('tests workflow runs daemon integration suite on the integration lane', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');

  assert.match(
    raw,
    /yarn\s+--cwd\s+apps\/cli\s+-s\s+vitest\s+run\s+--config\s+vitest\.integration\.config\.ts\s+src\/daemon\/daemon\.integration\.test\.ts/,
    'tests.yml daemon e2e step should execute daemon.integration.test.ts with vitest.integration.config.ts',
  );
});

test('tests workflow creates daemon e2e credentials via pipeline script (no inline heredoc)', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');

  assert.match(
    raw,
    /node scripts\/pipeline\/run\.mjs testing-create-auth-credentials/,
    'tests.yml should delegate /v1/auth credentials bootstrap to the pipeline command (no direct leaf script call)',
  );

  assert.doesNotMatch(
    raw,
    /node --input-type=module - <<'NODE'[\s\S]*tweetnacl[\s\S]*\/v1\/auth/,
    'tests.yml should not embed the auth bootstrap as an inline heredoc',
  );
});
