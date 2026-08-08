import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function loadReleaseWorkflow() {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
  return parse(raw);
}

function checkoutSteps(job) {
  return job.steps.filter((step) => step?.uses === 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262');
}

function assertTrustedControlCheckout(step) {
  assert.equal(step?.with?.repository, '${{ job.workflow_repository }}');
  assert.equal(step?.with?.ref, '${{ job.workflow_sha }}');
  assert.equal(step?.with?.['persist-credentials'], false);
  assert.equal(step?.with?.path, undefined, 'trusted control must remain the workspace root');
}

function assertNoExpressionInterpolationInShell(job, jobName) {
  for (const step of job.steps) {
    if (typeof step?.run !== 'string') continue;
    assert.doesNotMatch(
      step.run,
      /\$\{\{/,
      `${jobName} must pass workflow metadata through env instead of interpolating it into shell`,
    );
  }
}

test('release actor guard loads its local action from trusted workflow control', async () => {
  const workflow = await loadReleaseWorkflow();
  const job = workflow.jobs.release_actor_guard;
  const checkouts = checkoutSteps(job);
  const guardIndex = job.steps.findIndex((step) => step?.uses === './.github/actions/release-actor-guard');

  assert.equal(checkouts.length, 1);
  assertTrustedControlCheckout(checkouts[0]);
  assert.ok(job.steps.indexOf(checkouts[0]) < guardIndex, 'trusted checkout must precede the App-credential guard');
});

test('deploy planning keeps release source inert and executes trusted workflow control', async () => {
  const workflow = await loadReleaseWorkflow();
  const job = workflow.jobs.deploy_plan;

  assert.equal(job.environment, undefined, 'deploy planning must not request release-shared secrets');
  assert.equal(job.permissions?.contents, 'read');
  assert.equal(
    job.steps.some((step) => step?.uses === 'actions/create-github-app-token@d72941d797fd3113feb6b93fd0dec494b13a2547'),
    false,
    'deploy planning does not need an App token',
  );

  const checkouts = checkoutSteps(job);
  assert.equal(checkouts.length, 2);
  assertTrustedControlCheckout(checkouts[0]);
  assert.equal(checkouts[1]?.with?.repository, '${{ github.repository }}');
  assert.equal(checkouts[1]?.with?.path, 'release-source');
  assert.equal(checkouts[1]?.with?.['persist-credentials'], false);

  const compute = job.steps.find((step) => step?.id === 'plan');
  assert.equal(compute?.['working-directory'], 'release-source');
  assert.match(compute?.run ?? '', /node \.\.\/scripts\/pipeline\/release\/compute-deploy-plan\.mjs/);
  assert.doesNotMatch(compute?.run ?? '', /node scripts\//, 'candidate source must not supply executable planning code');
  assertNoExpressionInterpolationInShell(job, 'deploy_plan');
});

test('version bumping runs trusted control against nested dev data with ephemeral credentials', async () => {
  const workflow = await loadReleaseWorkflow();
  const job = workflow.jobs.bump_versions_dev;
  const appTokenIndex = job.steps.findIndex((step) => step?.uses === 'actions/create-github-app-token@d72941d797fd3113feb6b93fd0dec494b13a2547');
  const checkouts = checkoutSteps(job);

  assert.equal(job.permissions?.contents, 'read');
  assert.equal(checkouts.length, 2);
  assertTrustedControlCheckout(checkouts[0]);
  assert.ok(job.steps.indexOf(checkouts[0]) < appTokenIndex, 'trusted control checkout must precede App-token creation');
  assert.ok(appTokenIndex < job.steps.indexOf(checkouts[1]), 'candidate checkout must follow App-token creation');
  assert.equal(checkouts[1]?.with?.repository, '${{ github.repository }}');
  assert.equal(checkouts[1]?.with?.ref, 'dev');
  assert.equal(checkouts[1]?.with?.path, 'release-source');
  assert.equal(checkouts[1]?.with?.['persist-credentials'], false);

  const install = job.steps.find((step) => step?.uses === './.github/actions/install-yarn-dependencies');
  assert.ok(install, 'dependency installation must use the trusted root action');
  assert.equal(install?.['working-directory'], undefined);

  const bump = job.steps.find((step) => step?.id === 'bumps');
  assert.equal(bump?.['working-directory'], 'release-source');
  assert.match(bump?.run ?? '', /node \.\.\/scripts\/pipeline\/release\/bump-versions-dev\.mjs/);
  assert.doesNotMatch(bump?.run ?? '', /node scripts\//, 'candidate source must not supply executable bump code');
  for (const key of ['BUMP_APP', 'BUMP_SERVER', 'BUMP_WEBSITE', 'BUMP_CLI', 'BUMP_STACK']) {
    assert.match(String(bump?.env?.[key] ?? ''), /^\$\{\{ needs\.plan\.outputs\./);
  }
  assertNoExpressionInterpolationInShell(job, 'bump_versions_dev');
});

test('trusted bump orchestrator never executes a candidate-local bump script', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'happier-release-bump-trust-'));
  const candidateRoot = join(tempRoot, 'candidate');
  const remoteRoot = join(tempRoot, 'remote.git');
  const marker = join(tempRoot, 'candidate-script-executed');
  const trustedScript = join(repoRoot, 'scripts', 'pipeline', 'release', 'bump-versions-dev.mjs');

  try {
    await mkdir(candidateRoot, { recursive: true });
    execFileSync('git', ['init', '--bare', remoteRoot]);
    execFileSync('git', ['init'], { cwd: candidateRoot });
    execFileSync('git', ['config', 'user.name', 'Release Trust Test'], { cwd: candidateRoot });
    execFileSync('git', ['config', 'user.email', 'release-trust@example.invalid'], { cwd: candidateRoot });
    execFileSync('git', ['remote', 'add', 'origin', remoteRoot], { cwd: candidateRoot });

    for (const rel of [
      'apps/ui/package.json',
      'apps/server/package.json',
      'apps/website/package.json',
      'apps/cli/package.json',
      'apps/stack/package.json',
      'packages/relay-server/package.json',
    ]) {
      await mkdir(dirname(join(candidateRoot, rel)), { recursive: true });
      await writeFile(join(candidateRoot, rel), '{"version":"1.0.0"}\n');
    }
    await writeFile(join(candidateRoot, 'apps/ui/app.config.js'), 'export default { version: "1.0.0" };\n');
    execFileSync('git', ['add', '.'], { cwd: candidateRoot });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: candidateRoot });

    const candidateScript = join(candidateRoot, 'scripts', 'pipeline', 'release', 'bump-version.mjs');
    await mkdir(dirname(candidateScript), { recursive: true });
    await writeFile(candidateScript, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');\n`);

    execFileSync(process.execPath, [trustedScript, '--bump-cli', 'patch'], {
      cwd: candidateRoot,
      stdio: 'pipe',
    });

    const cliPackage = JSON.parse(await readFile(join(candidateRoot, 'apps/cli/package.json'), 'utf8'));
    assert.equal(cliPackage.version, '1.0.1');
    await assert.rejects(access(marker), 'candidate-local executable must remain inert');
    assert.equal(execFileSync('git', ['rev-parse', 'refs/remotes/origin/dev'], { cwd: candidateRoot, encoding: 'utf8' }).trim().length, 40);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
