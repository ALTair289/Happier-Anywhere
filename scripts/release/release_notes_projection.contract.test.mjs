import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PLAIN_TEXT_MAX_LENGTHS,
  buildReleaseNotesBundle,
  parseReleaseNoteSection,
  renderReleaseNotesBundle,
} from '../pipeline/release/release-notes/project-release-notes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const projectionScript = resolve(repoRoot, 'scripts/pipeline/release/release-notes/project-release-notes.mjs');

function writeChangelog(contents) {
  const root = mkdtempSync(join(tmpdir(), 'happier-release-notes-projection-'));
  const changelogPath = join(root, 'CHANGELOG.md');
  writeFileSync(changelogPath, contents, 'utf8');
  return { root, changelogPath };
}

function changelogWithSection(sectionMarkdown) {
  return [
    '# Changelog',
    '',
    '## Version 1.2.30 - 2026-09-30',
    '',
    'This similarly named version must not match 1.2.3.',
    '',
    '## Version 1.2.3 - 2026-09-03',
    '',
    sectionMarkdown,
    '',
    '## Version 1.2.4 - 2026-09-04',
    '',
    'This next-version prose must not leak into 1.2.3.',
    '',
  ].join('\n');
}

test('release-note projection selects only the exact version section and preserves its full Markdown', () => {
  const changelog = changelogWithSection([
    '### New capability',
    '',
    '**Happier now ships this.** Read the [guide](https://example.test/guide).',
    '',
    '- First public outcome',
    '- `Code` details stay in the Markdown projection',
  ].join('\n'));

  const section = parseReleaseNoteSection(changelog, '1.2.3');
  assert.equal(section.date, '2026-09-03');
  assert.equal(section.markdown, [
    '### New capability',
    '',
    '**Happier now ships this.** Read the [guide](https://example.test/guide).',
    '',
    '- First public outcome',
    '- `Code` details stay in the Markdown projection',
  ].join('\n'));
  assert.doesNotMatch(section.markdown, /next-version prose/i);

  const bundle = buildReleaseNotesBundle(changelog, '1.2.3');
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.kind, 'happier.release-notes.projection.v1');
  assert.equal(bundle.version, '1.2.3');
  assert.equal(bundle.date, '2026-09-03');
  assert.equal(bundle.projections.github.markdown, section.markdown);
  assert.equal(bundle.projections.rollingRelease.markdown, section.markdown);
});

test('release-note projection fails on missing or duplicate exact version sections', () => {
  assert.throws(
    () => parseReleaseNoteSection('# Changelog\n', '1.2.3'),
    /No exact changelog section found for version 1\.2\.3/,
  );

  assert.throws(
    () => parseReleaseNoteSection([
      '## Version 1.2.3 - 2026-09-03',
      '',
      'First approved prose.',
      '',
      '## Version 1.2.3 - 2026-09-04',
      '',
      'Duplicate approved prose.',
    ].join('\n'), '1.2.3'),
    /must appear exactly once/,
  );
});

test('release-note projection is byte deterministic and emits no approval or timestamp metadata', () => {
  const changelog = changelogWithSection('A deterministic public release note.');
  const first = renderReleaseNotesBundle(buildReleaseNotesBundle(changelog, '1.2.3'));
  const second = renderReleaseNotesBundle(buildReleaseNotesBundle(changelog, '1.2.3'));

  assert.equal(first, second);
  const bundle = JSON.parse(first);
  assert.deepEqual(Object.keys(bundle), ['schemaVersion', 'kind', 'version', 'date', 'projections']);
  assert.doesNotMatch(first, /approval|approvedBy|generatedAt|timestamp|private/i);
});

test('release-note projection keeps plain-text projections within their documented bounds', () => {
  const changelog = changelogWithSection([
    '### A very long public release narrative',
    '',
    ...Array.from({ length: 800 }, () => '- **A visible user outcome** with [details](https://example.test/details) and `code`.'),
  ].join('\n'));
  const bundle = buildReleaseNotesBundle(changelog, '1.2.3');

  assert.ok(bundle.projections.github.markdown.length > PLAIN_TEXT_MAX_LENGTHS.appStore);
  assert.match(bundle.projections.expo.message, /A visible user outcome/);
  assert.doesNotMatch(bundle.projections.expo.message, /\*\*|\[details\]\(|`code`/);
  assert.ok(bundle.projections.expo.message.length <= PLAIN_TEXT_MAX_LENGTHS.expo);
  assert.ok(bundle.projections.appStore.whatsNew.length <= PLAIN_TEXT_MAX_LENGTHS.appStore);
  assert.ok(bundle.projections.playStore.whatsNew.length <= PLAIN_TEXT_MAX_LENGTHS.playStore);
  assert.ok(bundle.projections.storyDeck.authoringHints.length <= PLAIN_TEXT_MAX_LENGTHS.storyDeck);
});

test('release-note projection keeps the stable GitHub and preview rolling narratives identical', () => {
  const bundle = buildReleaseNotesBundle(changelogWithSection('One approved public narrative.'), '1.2.3');

  assert.equal(bundle.projections.github.markdown, bundle.projections.rollingRelease.markdown);
});

test('release-note projection command emits JSON only to stdout or writes the same JSON to --out', () => {
  const fixture = writeChangelog(changelogWithSection('A concise public release note.'));
  const stdoutResult = spawnSync(
    process.execPath,
    [projectionScript, '--version', '1.2.3', '--changelog', fixture.changelogPath],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );

  assert.equal(stdoutResult.status, 0, stdoutResult.stderr);
  assert.equal(stdoutResult.stderr, '');
  assert.equal(JSON.parse(stdoutResult.stdout).version, '1.2.3');

  const outPath = join(fixture.root, 'release-notes.json');
  const outResult = spawnSync(
    process.execPath,
    [projectionScript, '--version=1.2.3', '--changelog', fixture.changelogPath, '--out', outPath],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );

  assert.equal(outResult.status, 0, outResult.stderr);
  assert.equal(outResult.stdout, '');
  assert.equal(readFileSync(outPath, 'utf8'), stdoutResult.stdout);
});
