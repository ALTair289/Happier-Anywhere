import './utils/env/env.mjs';

import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import {
  createSqliteSnapshot,
  restoreSqliteSnapshot,
} from './utils/sqlite/sqlite_snapshot.mjs';

function usage() {
  return [
    '[sqlite-snapshot] usage:',
    '  hstack sqlite-snapshot snapshot --source PATH --output PATH --disposable-root PATH [--json]',
    '  hstack sqlite-snapshot restore --snapshot PATH --output PATH --disposable-root PATH [--json]',
    '',
    'Safety:',
    '- Every path must be absolute; stack paths are never inferred.',
    '- Output must not exist and must be under the explicit disposable root.',
    '- Snapshot publishes a sibling .manifest.json with content, structure, and Prisma-ledger fingerprints.',
    '- Fingerprints detect mismatches; they do not authenticate files or replace controlled root access.',
    '- Restore accepts only a snapshot and matching manifest under that same disposable root.',
    '- Direct symlink inputs, roots, and output parents are rejected; resolved paths cannot escape the root.',
    '- Snapshot uses SQLite online backup, so committed WAL state is included.',
    '- Private mode enforcement must be rehearsed on the target OS and filesystem before use.',
    '- Publication is atomic and no-overwrite, but is not a system-crash durability guarantee.',
    '- Keep the disposable root quiescent for the full operation.',
    '- Namespace replacement fails closed but can leave a private partial or unmanifested database for operator removal.',
  ].join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const operation = argv.find((value) => !value.startsWith('-'));
  if (!operation || wantsHelp(argv, { flags }) || operation === 'help') {
    printResult({
      json,
      data: {
        commands: ['snapshot', 'restore'],
        requiredFlags: ['--output', '--disposable-root'],
      },
      text: usage(),
    });
    return;
  }

  const outputPath = kv.get('--output');
  const disposableRoot = kv.get('--disposable-root');
  let result;
  if (operation === 'snapshot') {
    result = await createSqliteSnapshot({
      sourcePath: kv.get('--source'),
      outputPath,
      disposableRoot,
    });
  } else if (operation === 'restore') {
    result = await restoreSqliteSnapshot({
      snapshotPath: kv.get('--snapshot'),
      outputPath,
      disposableRoot,
    });
  } else {
    throw new Error(`unknown sqlite-snapshot operation: ${operation}`);
  }

  printResult({
    json,
    data: { ok: true, ...result },
    text: [
      `[sqlite-snapshot] ${result.operation} complete`,
      `output: ${result.outputPath}`,
      `manifest: ${result.manifestPath}`,
      `integrity_check: ${result.integrityCheck}`,
      `content_sha256: ${result.fingerprints.contentSha256}`,
      `structure_sha256: ${result.fingerprints.structureSha256}`,
      `prisma_migrations: ${result.fingerprints.prismaMigrations.state}`,
    ].join('\n'),
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[sqlite-snapshot] failed: ${message}`);
  process.exit(1);
});
