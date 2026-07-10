#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { homedir } from 'os';

import { importPreparedRuntimeEntrypoint } from './_importRuntimeEntrypoint.mjs';

// Check if we're already running with the flags
const hasNoWarnings = process.execArgv.includes('--no-warnings');
const hasNoDeprecation = process.execArgv.includes('--no-deprecation');

// Set development environment variables
process.env.HAPPIER_HOME_DIR = join(homedir(), '.happier-dev');
process.env.HAPPIER_VARIANT = 'dev';

if (!hasNoWarnings || !hasNoDeprecation) {
  // Re-execute with the flags
  const __filename = fileURLToPath(import.meta.url);

  try {
    execFileSync(
      process.execPath,
      ['--no-warnings', '--no-deprecation', __filename, ...process.argv.slice(2)],
      {
        stdio: 'inherit',
        env: process.env
      }
    );
  } catch (error) {
    // Exit with the same code as the subprocess
    process.exit(error.status || 1);
  }
} else {
  // Already have the flags, import normally
  const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  await importPreparedRuntimeEntrypoint(projectRoot, 'index.mjs');
}
