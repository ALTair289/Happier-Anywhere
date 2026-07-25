// @ts-check

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { parseArgs } from 'node:util';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readCommitSha(raw, name) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(value)) fail(`${name} must be a full 40-character Git commit SHA.`);
  return value;
}

function readCurrentSha(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'missing') return null;
  return readCommitSha(value, '--expected-current-sha');
}

function appendLine(filePath, line) {
  if (!filePath) return;
  fs.appendFileSync(filePath, `${line}\n`, 'utf8');
}

function readRemoteRef(remote, refName) {
  const authHeader = String(process.env.HAPPIER_GIT_AUTHORIZATION_HEADER ?? '');
  const authArgs = authHeader ? ['-c', `http.extraHeader=${authHeader}`] : [];
  const result = spawnSync('git', [...authArgs, 'ls-remote', '--refs', remote, refName], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) fail(result.stderr.trim() || `Unable to read ${refName} from ${remote}.`);
  const output = result.stdout.trim();
  if (!output) return null;
  const rows = output.split(/\r?\n/).filter(Boolean);
  if (rows.length !== 1) fail(`Remote returned multiple rows for exact ref ${refName}.`);
  const [sha, resolvedRef] = rows[0].split(/\s+/, 2);
  if (resolvedRef !== refName) fail(`Remote returned unexpected ref ${resolvedRef || '<missing>'}.`);
  return readCommitSha(sha, 'remote ref SHA');
}

const { values } = parseArgs({
  options: {
    'deploy-environment': { type: 'string' },
    'candidate-sha': { type: 'string' },
    'expected-current-sha': { type: 'string' },
    remote: { type: 'string', default: 'origin' },
    'summary-file': { type: 'string', default: '' },
    'github-output': { type: 'string', default: '' },
  },
  allowPositionals: false,
});

const deployEnvironment = String(values['deploy-environment'] ?? '').trim();
if (deployEnvironment !== 'preview' && deployEnvironment !== 'production') {
  fail('--deploy-environment must be preview or production.');
}
const candidateSha = readCommitSha(values['candidate-sha'], '--candidate-sha');
const expectedCurrentSha = readCurrentSha(values['expected-current-sha']);
const remote = String(values.remote ?? '').trim();
if (!/^[A-Za-z0-9._-]+$/.test(remote)) fail('--remote must be a simple configured Git remote name.');

try {
  execFileSync('git', ['cat-file', '-e', `${candidateSha}^{commit}`], { stdio: 'ignore' });
} catch {
  fail(`Candidate ${candidateSha} is not available as a commit in the trusted promotion checkout.`);
}

const targetRef = `refs/heads/deploy/${deployEnvironment}/server`;
const observedCurrentSha = readRemoteRef(remote, targetRef);
if (observedCurrentSha !== expectedCurrentSha) {
  fail(
    `Deploy ref changed concurrently or did not match expected current SHA: expected ${expectedCurrentSha ?? 'missing'}, observed ${observedCurrentSha ?? 'missing'}.`,
  );
}

const lease = `${targetRef}:${expectedCurrentSha ?? ''}`;
const push = spawnSync(
  'git',
  [...(String(process.env.HAPPIER_GIT_AUTHORIZATION_HEADER ?? '') ? ['-c', `http.extraHeader=${process.env.HAPPIER_GIT_AUTHORIZATION_HEADER}`] : []), 'push', `--force-with-lease=${lease}`, remote, `${candidateSha}:${targetRef}`],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);
if (push.status !== 0) {
  fail(push.stderr.trim() || `Atomic promotion of ${targetRef} failed.`);
}

const finalSha = readRemoteRef(remote, targetRef);
if (finalSha !== candidateSha) {
  fail(`Deploy ref verification failed: expected ${candidateSha}, observed ${finalSha ?? 'missing'}.`);
}
const changed = observedCurrentSha !== candidateSha;
const summaryFile = String(values['summary-file'] ?? '').trim();
if (summaryFile) {
  fs.appendFileSync(summaryFile, [
    '## Promote server deploy branch',
    '',
    `- target: \`${targetRef.slice('refs/heads/'.length)}\``,
    `- old_sha: \`${observedCurrentSha ?? '(missing)'}\``,
    `- new_sha: \`${candidateSha}\``,
    `- changed: \`${changed}\``,
    '',
  ].join('\n'), 'utf8');
}
const githubOutput = String(values['github-output'] ?? '').trim();
appendLine(githubOutput, `old_sha=${observedCurrentSha ?? ''}`);
appendLine(githubOutput, `new_sha=${candidateSha}`);
appendLine(githubOutput, `changed=${changed}`);
console.log(`Promoted ${targetRef} atomically to ${candidateSha}.`);
