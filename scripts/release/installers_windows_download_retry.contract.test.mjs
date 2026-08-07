import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('install.ps1 retries transient GitHub installer downloads and release metadata fetches', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');
  const trimmed = raw.replace(/^\uFEFF?/, '').trimStart();

  assert.match(trimmed, /function Invoke-InstallerWebRequestWithRetry\b/i);
  assert.match(trimmed, /\$retryableStatusCodes\s*=\s*@\(404,\s*502,\s*503,\s*504\)/i);
  assert.match(trimmed, /\$params\s*=\s*@\{\s*Uri\s*=\s*\$Uri;\s*UseBasicParsing\s*=\s*\$true\s*\}/i);
  assert.match(trimmed, /Copy-OrDownloadInstallerAsset[\s\S]*Invoke-InstallerWebRequestWithRetry -Uri \$Source -Headers \$GitHubHeaders -OutFile \$DestinationPath/i);
  assert.match(trimmed, /Invoke-InstallerWebRequestWithRetry -Uri \$MinisignPubKeyUrl -OutFile \$TargetPath/i);
  assert.match(trimmed, /\$release\s*=\s*Invoke-InstallerRestMethodWithRetry -Uri "https:\/\/api\.github\.com\/repos\/\$Repo\/releases\/tags\/\$tag" -Headers \$GitHubHeaders/i);
});
