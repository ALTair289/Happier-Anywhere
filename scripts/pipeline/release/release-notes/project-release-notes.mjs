#!/usr/bin/env node
// @ts-check

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const DEFAULT_CHANGELOG_PATH = resolve(REPO_ROOT, 'apps/ui/CHANGELOG.md');

export const RELEASE_NOTES_BUNDLE_KIND = 'happier.release-notes.projection.v1';

/**
 * Public text limits for channels that do not accept the complete Markdown
 * section. GitHub and the rolling release retain the source Markdown verbatim.
 */
export const PLAIN_TEXT_MAX_LENGTHS = Object.freeze({
  expo: 1_024,
  appStore: 4_000,
  playStore: 500,
  storyDeck: 280,
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeVersion(version) {
  const normalized = String(version ?? '').trim();
  if (!normalized) {
    throw new Error('--version is required');
  }
  return normalized;
}

function trimSectionMarkdown(markdown) {
  return markdown.replace(/^\n+|\n+$/g, '');
}

/**
 * Find exactly one public changelog section. A release section ends only at
 * the next version heading, so level-two headings within the release remain
 * part of the approved Markdown source.
 */
export function parseReleaseNoteSection(changelog, version) {
  const normalizedVersion = normalizeVersion(version);
  const lines = String(changelog ?? '').replace(/\r\n?/g, '\n').split('\n');
  const headerPattern = new RegExp(`^## Version ${escapeRegExp(normalizedVersion)} - (\\d{4}-\\d{2}-\\d{2})$`);
  const matches = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(headerPattern);
    if (match) {
      matches.push({ index, date: match[1] });
    }
  }

  if (matches.length === 0) {
    throw new Error(`No exact changelog section found for version ${normalizedVersion}`);
  }
  if (matches.length > 1) {
    throw new Error(`Changelog version ${normalizedVersion} must appear exactly once; found ${matches.length}`);
  }

  const [{ index: startIndex, date }] = matches;
  const endIndex = lines.findIndex(
    (line, index) => index > startIndex && /^## Version .+ - \d{4}-\d{2}-\d{2}$/.test(line),
  );
  const markdown = trimSectionMarkdown(lines.slice(startIndex + 1, endIndex === -1 ? undefined : endIndex).join('\n'));

  return { version: normalizedVersion, date, markdown };
}

function stripMarkdownLine(line) {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s{0,3}(?:[-+*]|\d+[.)])\s+/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/(^|[^\w])([*_])([^*_]+)\2(?=$|[^\w])/g, '$1$3')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract readable public text without trying to become a second Markdown
 * renderer. Preserve source Markdown separately for destinations that support it.
 */
export function extractPlainText(markdown) {
  return String(markdown ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(stripMarkdownLine)
    .filter(Boolean)
    .join('\n');
}

function truncatePlainText(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

export function buildReleaseNotesBundle(changelog, version) {
  const section = parseReleaseNoteSection(changelog, version);
  const plainText = extractPlainText(section.markdown);

  return {
    schemaVersion: 1,
    kind: RELEASE_NOTES_BUNDLE_KIND,
    version: section.version,
    date: section.date,
    projections: {
      github: { markdown: section.markdown },
      rollingRelease: { markdown: section.markdown },
      expo: { message: truncatePlainText(plainText, PLAIN_TEXT_MAX_LENGTHS.expo) },
      appStore: { whatsNew: truncatePlainText(plainText, PLAIN_TEXT_MAX_LENGTHS.appStore) },
      playStore: { whatsNew: truncatePlainText(plainText, PLAIN_TEXT_MAX_LENGTHS.playStore) },
      storyDeck: { authoringHints: truncatePlainText(plainText, PLAIN_TEXT_MAX_LENGTHS.storyDeck) },
    },
  };
}

export function renderReleaseNotesBundle(bundle) {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

function readFlagValue(argv, index, flag) {
  const next = argv[index + 1];
  if (!next || next.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return next;
}

export function parseProjectionArgs(argv) {
  const values = new Map();
  const supportedFlags = new Set(['version', 'changelog', 'out']);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const equalsIndex = arg.indexOf('=');
    const flagName = arg.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
    if (!supportedFlags.has(flagName)) {
      throw new Error(`Unsupported flag: --${flagName}`);
    }
    if (values.has(flagName)) {
      throw new Error(`Duplicate flag: --${flagName}`);
    }

    const value = equalsIndex === -1
      ? readFlagValue(argv, index, `--${flagName}`)
      : arg.slice(equalsIndex + 1);
    if (!value) {
      throw new Error(`--${flagName} requires a value`);
    }
    values.set(flagName, value);
    if (equalsIndex === -1) {
      index += 1;
    }
  }

  return {
    version: normalizeVersion(values.get('version')),
    changelogPath: values.get('changelog') ? resolve(values.get('changelog')) : DEFAULT_CHANGELOG_PATH,
    outPath: values.get('out') ? resolve(values.get('out')) : null,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const { version, changelogPath, outPath } = parseProjectionArgs(argv);
  const changelog = await readFile(changelogPath, 'utf8');
  const rendered = renderReleaseNotesBundle(buildReleaseNotesBundle(changelog, version));

  if (outPath) {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, rendered, 'utf8');
    return;
  }

  process.stdout.write(rendered);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
