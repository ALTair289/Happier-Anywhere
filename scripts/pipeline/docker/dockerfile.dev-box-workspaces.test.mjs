import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('dev-box Dockerfile consumes the CLI release artifact without stack/source workspaces', () => {
  const repoRoot = process.cwd();
  const dockerfilePath = path.join(repoRoot, 'docker', 'dev-box', 'Dockerfile');
  const raw = fs.readFileSync(dockerfilePath, 'utf8');

  assert.match(raw, /FROM debian:12-slim AS devbox-artifacts/);
  assert.match(raw, /fetch-verified-release-artifact/);
  assert.match(raw, /HAPPIER_DEVBOX_CLI_RELEASE_TAG/);
  assert.match(raw, /HAPPIER_DEVBOX_CLI_VERSION/);
  assert.match(raw, /--product\s+happier/);
  assert.match(raw, /COPY --from=devbox-artifacts --chown=happier:happier \/opt\/happier\/cli \/opt\/happier\/cli/);
  assert.match(raw, /ln -sf \/opt\/happier\/cli\/happier \/usr\/local\/bin\/happier/);
  assert.doesNotMatch(raw, /\bAS cli-builder\b/);
  assert.doesNotMatch(raw, /COPY apps\/stack\b/);
  assert.doesNotMatch(raw, /ln -sf .*hstack/);
  assert.doesNotMatch(raw, /COPY --from=.*node_modules/);
});

test('dev-box keeps a non-root runtime user and writable Happier home', () => {
  const repoRoot = process.cwd();
  const dockerfilePath = path.join(repoRoot, 'docker', 'dev-box', 'Dockerfile');
  const raw = fs.readFileSync(dockerfilePath, 'utf8');

  assert.match(raw, /\bRUN useradd -m -s \/bin\/bash happier\b/);
  assert.match(raw, /\bENV PATH=\/opt\/happier\/cli:\/home\/happier\/\.local\/bin:\/home\/happier\/\.npm-global\/bin:\$PATH\b/);
  assert.match(raw, /\bchown -R happier:happier \/home\/happier \/opt\/happier\b/);
  assert.match(raw, /\bUSER happier\b/);
  assert.match(raw, /\bWORKDIR \/workspace\b/);
});
