import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import {
  createFirstPartyPayloadContentManifest,
  FIRST_PARTY_PAYLOAD_MANIFEST_FILE_NAME,
} from '../../componentArtifacts/firstPartyPayloadManifest.js';
import { createScpReadyPayloadCopy } from './createScpReadyPayloadCopy.js';

const execFileAsync = promisify(execFile);

export async function createScpReadyPayloadArchive(payloadRoot: string): Promise<Readonly<{
  archiveStageRoot: string;
  archiveFileName: string;
  extractedPayloadDirName: string;
  manifestFileName: string;
  manifestSha256: string;
  cleanup: () => Promise<void>;
}>> {
  const scpReadyPayload = await createScpReadyPayloadCopy(payloadRoot);
  const archiveStageRoot = await mkdtemp(join(tmpdir(), 'happier-first-party-scp-archive-'));
  const extractedPayloadDirName = basename(scpReadyPayload.payloadRoot);
  const archiveFileName = `${extractedPayloadDirName}.tar`;

  try {
    const manifest = await createFirstPartyPayloadContentManifest(scpReadyPayload.payloadRoot);
    await execFileAsync('tar', [
      '-cf',
      join(archiveStageRoot, archiveFileName),
      '-C',
      join(scpReadyPayload.payloadRoot, '..'),
      extractedPayloadDirName,
    ]);
    await writeFile(
      join(archiveStageRoot, FIRST_PARTY_PAYLOAD_MANIFEST_FILE_NAME),
      manifest.text,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    return {
      archiveStageRoot,
      archiveFileName,
      extractedPayloadDirName,
      manifestFileName: FIRST_PARTY_PAYLOAD_MANIFEST_FILE_NAME,
      manifestSha256: manifest.sha256,
      cleanup: async () => {
        await Promise.all([
          scpReadyPayload.cleanup(),
          rm(archiveStageRoot, { recursive: true, force: true }),
        ]);
      },
    };
  } catch (error) {
    await Promise.all([
      scpReadyPayload.cleanup(),
      rm(archiveStageRoot, { recursive: true, force: true }),
    ]);
    throw error;
  }
}
