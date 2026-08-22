import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..');

function extractJobBlock(raw, jobName) {
  const normalized = raw.replace(/\r\n/g, '\n');
  const match = normalized.match(new RegExp(`(?:^|\\n)  ${jobName}:\\n([\\s\\S]*?)(?=\\n  [A-Za-z0-9-]+:|\\n$)`));
  assert.ok(match, `expected to find job block for ${jobName}`);
  return match[1];
}

test('tests workflow keeps slow CI jobs above the observed timeout floor', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
  const uiE2eJob = extractJobBlock(raw, 'ui-e2e');
  const uiJob = extractJobBlock(raw, 'ui');
  const cliJob = extractJobBlock(raw, 'cli');
  const stackJob = extractJobBlock(raw, 'stack');
  const installerSmokeWindowsJob = extractJobBlock(raw, 'installers-smoke-windows');

  assert.match(
    uiE2eJob,
    /name:\s*UI E2E \(Playwright\)[\s\S]*?timeout-minutes:\s*45\b/,
    'UI E2E job should reserve enough time to finish the slow multi-session Playwright scenarios on GitHub-hosted runners',
  );

  assert.match(
    uiJob,
    /name:\s*UI Tests \(unit \+ integration\)[\s\S]*?timeout-minutes:\s*75\b/,
    'UI Tests job should reserve enough time to finish on GitHub-hosted runners',
  );

  assert.match(
    cliJob,
    /name:\s*CLI Tests \(unit \+ integration\)[\s\S]*?timeout-minutes:\s*90\b/,
    'CLI Tests job should reserve enough time for bounded unit shards and integration tests',
  );

  assert.match(
    stackJob,
    /name:\s*Stack Tests \(unit \+ integration\)[\s\S]*?timeout-minutes:\s*45\b/,
    'Stack Tests job should reserve enough time to finish on GitHub-hosted runners',
  );

  assert.match(
    installerSmokeWindowsJob,
    /name:\s*Installer Smoke \(Windows\)[\s\S]*?timeout-minutes:\s*45\b/,
    'Windows installer smoke should reserve enough time to finish published-channel validation on GitHub-hosted runners',
  );
});
