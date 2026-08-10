#!/usr/bin/env node

// @ts-check

import { lstat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assembleDeploymentGitHubProjectFromSpec,
  assembleDeploymentGitHubProjectFromVerifiedKit,
} from './lib/deployment-kit-github-project-assembly.mjs';
import { normalizeMinisignPublicKey } from './lib/deployment-kit-github-project.mjs';

const USAGE = 'Usage: node scripts/pipeline/deployment-kit/assemble-github-project.mjs (--spec <kit-spec.json> | --kit <verified-kit-directory>) --out <new-directory> --repository <owner/repo> --release-public-key <minisign-public-key> [--repository-availability <not-verified|verified>]';
const REPOSITORY_AVAILABILITIES = new Set(['not-verified', 'verified']);

export function parseGitHubProjectCliArgs(argv) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    return {
      help: true,
      specPath: null,
      kitRoot: null,
      outDir: null,
      repository: null,
      repositoryAvailability: null,
      releasePublicKeyPath: null,
    };
  }
  const values = new Map([
    ['--spec', null],
    ['--kit', null],
    ['--out', null],
    ['--repository', null],
    ['--repository-availability', null],
    ['--release-public-key', null],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    let name;
    let value;
    if (argument.includes('=')) {
      [name, value] = argument.split(/=(.*)/s, 2);
    } else {
      name = argument;
      value = argv[index + 1];
      index += 1;
    }
    if (!values.has(name)) {
      throw new Error(`[deployment-kit] unknown argument: ${name}`);
    }
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      throw new Error(`[deployment-kit] ${name} requires a value`);
    }
    if (values.get(name) !== null) {
      throw new Error(`[deployment-kit] duplicate ${name}`);
    }
    values.set(name, value);
  }
  if (values.get('--out') === null) throw new Error('[deployment-kit] --out is required');
  if (values.get('--repository') === null) throw new Error('[deployment-kit] --repository is required');
  if (values.get('--release-public-key') === null) {
    throw new Error('[deployment-kit] --release-public-key is required');
  }
  const hasSpec = values.get('--spec') !== null;
  const hasKit = values.get('--kit') !== null;
  if (hasSpec === hasKit) {
    throw new Error('[deployment-kit] exactly one of --spec or --kit is required');
  }
  const repositoryAvailability = values.get('--repository-availability');
  if (repositoryAvailability !== null && !REPOSITORY_AVAILABILITIES.has(repositoryAvailability)) {
    throw new Error('[deployment-kit] --repository-availability must be not-verified or verified');
  }
  return {
    help: false,
    specPath: values.get('--spec'),
    kitRoot: values.get('--kit'),
    outDir: values.get('--out'),
    repository: values.get('--repository'),
    repositoryAvailability,
    releasePublicKeyPath: values.get('--release-public-key'),
  };
}

async function readRegularReleasePublicKey(path) {
  const info = await lstat(path).catch((error) => {
    throw new Error('[deployment-kit] release public key file is not readable', { cause: error });
  });
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error('[deployment-kit] release public key must be a regular file');
  }
  const contents = await readFile(path, 'utf8').catch((error) => {
    throw new Error('[deployment-kit] release public key file is not readable', { cause: error });
  });
  return normalizeMinisignPublicKey(contents);
}

async function readRegularSpec(path) {
  const info = await lstat(path).catch((error) => {
    throw new Error('[deployment-kit] spec file is not readable', { cause: error });
  });
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error('[deployment-kit] spec must be a regular file');
  }
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error('[deployment-kit] spec is not valid JSON', { cause: error });
  }
}

export async function runGitHubProjectCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  stdout = process.stdout,
} = {}) {
  const parsed = parseGitHubProjectCliArgs(argv);
  if (parsed.help) {
    stdout.write(`${USAGE}\n`);
    return { help: true };
  }
  const outDir = resolve(cwd, parsed.outDir);
  const releasePublicKey = await readRegularReleasePublicKey(resolve(cwd, parsed.releasePublicKeyPath));
  const result = parsed.specPath !== null
    ? await (async () => {
        const specPath = resolve(cwd, parsed.specPath);
        const spec = await readRegularSpec(specPath);
        return await assembleDeploymentGitHubProjectFromSpec({
          spec,
          specRoot: dirname(specPath),
          outDir,
          repository: parsed.repository,
          repositoryAvailability: parsed.repositoryAvailability ?? undefined,
          releasePublicKey,
        });
      })()
    : await assembleDeploymentGitHubProjectFromVerifiedKit({
        kitRoot: resolve(cwd, parsed.kitRoot),
        outDir,
        repository: parsed.repository,
        repositoryAvailability: parsed.repositoryAvailability ?? undefined,
        releasePublicKey,
      });
  stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

const isEntrypoint = (() => {
  const entrypoint = process.argv[1];
  return typeof entrypoint === 'string' && entrypoint.length > 0
    && import.meta.url === pathToFileURL(resolve(entrypoint)).href;
})();

if (isEntrypoint) {
  runGitHubProjectCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
