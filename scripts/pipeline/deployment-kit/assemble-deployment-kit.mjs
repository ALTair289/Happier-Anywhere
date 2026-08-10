#!/usr/bin/env node

// @ts-check

import { lstat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { assembleDeploymentKitFromSpec } from './lib/deployment-kit-assembly.mjs';

const USAGE = 'Usage: node scripts/pipeline/deployment-kit/assemble-deployment-kit.mjs --spec <kit-spec.json> --out <new-directory>';

export function parseAssemblyCliArgs(argv) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    return { help: true, specPath: null, outDir: null };
  }
  let specPath = null;
  let outDir = null;
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
    if (name !== '--spec' && name !== '--out') {
      throw new Error(`[deployment-kit] unknown argument: ${name}`);
    }
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      throw new Error(`[deployment-kit] ${name} requires a value`);
    }
    if (name === '--spec') {
      if (specPath !== null) throw new Error('[deployment-kit] duplicate --spec');
      specPath = value;
    } else {
      if (outDir !== null) throw new Error('[deployment-kit] duplicate --out');
      outDir = value;
    }
  }
  if (specPath === null) throw new Error('[deployment-kit] --spec is required');
  if (outDir === null) throw new Error('[deployment-kit] --out is required');
  return { help: false, specPath, outDir };
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

export async function runAssemblyCli({ argv = process.argv.slice(2), cwd = process.cwd(), stdout = process.stdout } = {}) {
  const parsed = parseAssemblyCliArgs(argv);
  if (parsed.help) {
    stdout.write(`${USAGE}\n`);
    return { help: true };
  }
  const specPath = resolve(cwd, parsed.specPath);
  const outDir = resolve(cwd, parsed.outDir);
  const spec = await readRegularSpec(specPath);
  const result = await assembleDeploymentKitFromSpec({
    spec,
    specRoot: dirname(specPath),
    outDir,
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
  runAssemblyCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
