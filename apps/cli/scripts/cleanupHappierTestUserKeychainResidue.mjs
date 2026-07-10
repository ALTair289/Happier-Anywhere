#!/usr/bin/env node
// One-time, guarded cleanup of macOS login-keychain residue left by a historical test-harness escape
// (an un-mocked `security` `spawnSync` writer wrote derived Claude Code credential items under the
// synthetic `happier-test-user` account). The harness escape itself is now closed structurally
// (`claudeCodeMacOsKeychain.ts#assertSecuritySpawnAllowed` blocks any real `security` spawn under
// VITEST), so no new residue can appear; this script removes the existing items.
//
// SAFETY (pattern-exact — NEVER touches anything else):
//   - account MUST equal exactly `happier-test-user` (the synthetic test account; never the real user).
//   - service MUST match a derived Happier-managed Claude item: `Claude Code-credentials-<8 hex>` or the
//     `Claude Code-credentials-test-stdin` / `-test-stdin2` fixtures.
//   - The user's GLOBAL `Claude Code-credentials` login and every other account/service are left intact.
//
// Usage:
//   node scripts/cleanupHappierTestUserKeychainResidue.mjs           # dry-run (prints what it would delete)
//   node scripts/cleanupHappierTestUserKeychainResidue.mjs --apply   # actually delete
import { spawnSync } from 'node:child_process';

const TEST_ACCOUNT = 'happier-test-user';
const SERVICE_PATTERN = /^Claude Code-credentials-(?:[0-9a-f]{8}|test-stdin2?)$/;
const GLOBAL_SERVICE = 'Claude Code-credentials';

if (process.platform !== 'darwin') {
  console.log('Not macOS; nothing to clean.');
  process.exit(0);
}

const apply = process.argv.includes('--apply');

const dump = spawnSync('security', ['dump-keychain'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (dump.status !== 0) {
  console.error('security dump-keychain failed:', dump.stderr?.trim() || dump.status);
  process.exit(1);
}

// One item per `keychain: ` block; read the account and service (either the named `"svce"` form or the
// raw `0x00000007` attribute tag, which are the same service attribute).
const targets = new Set();
for (const block of dump.stdout.split(/\n(?=keychain: )/)) {
  const account = /"acct"<blob>="([^"]+)"/.exec(block)?.[1]?.trim();
  const service = (/"svce"<blob>="([^"]+)"/.exec(block)
    ?? /0x00000007 <blob>="([^"]+)"/.exec(block))?.[1]?.trim();
  if (!account || !service) continue;
  if (account !== TEST_ACCOUNT) continue;       // exact test account only
  if (service === GLOBAL_SERVICE) continue;      // never the global login
  if (!SERVICE_PATTERN.test(service)) continue;  // derived Happier-managed items only
  targets.add(service);
}

console.log(`${apply ? 'Deleting' : '[dry-run] Would delete'} ${targets.size} \`${TEST_ACCOUNT}\` derived keychain item(s).`);
if (!apply) {
  for (const service of targets) console.log(`  ${service}`);
  console.log('\nRe-run with --apply to delete.');
  process.exit(0);
}

let deleted = 0;
let failed = 0;
for (const service of targets) {
  const res = spawnSync('security', ['delete-generic-password', '-a', TEST_ACCOUNT, '-s', service], { encoding: 'utf8' });
  if (res.status === 0) { deleted += 1; continue; }
  if (String(res.stderr ?? '').includes('could not be found')) continue; // idempotent
  failed += 1;
  console.error(`  FAILED ${service}: ${res.stderr?.trim() || res.status}`);
}
console.log(`Done. Deleted ${deleted}, failed ${failed}.`);
process.exit(failed > 0 ? 1 : 0);
