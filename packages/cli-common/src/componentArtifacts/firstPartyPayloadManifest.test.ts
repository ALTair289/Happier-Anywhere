import { link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createFirstPartyPayloadContentManifest,
  FIRST_PARTY_PAYLOAD_MANIFEST_FILE_NAME,
} from './firstPartyPayloadManifest.js';

const cleanupRoots: string[] = [];

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'happier-payload-manifest-'));
  cleanupRoots.push(root);
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'runtime'), 'runtime-v1', 'utf8');
  await writeFile(join(root, 'nested', 'index.mjs'), 'export {};\n', 'utf8');
  return root;
}

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe('createFirstPartyPayloadContentManifest', () => {
  it('is deterministic across root paths and changes when immutable file content changes', async () => {
    const firstRoot = await createFixture();
    const secondRoot = await createFixture();

    const first = await createFirstPartyPayloadContentManifest(firstRoot);
    const second = await createFirstPartyPayloadContentManifest(secondRoot);
    expect(first).toEqual(second);
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.text).toContain('F\t');
    expect(first.text).toContain('\tnested/index.mjs\n');

    await writeFile(join(secondRoot, 'runtime'), 'runtime-v2', 'utf8');
    const changed = await createFirstPartyPayloadContentManifest(secondRoot);
    expect(changed.sha256).not.toBe(first.sha256);
  });

  it('rejects hard-linked files instead of assigning one digest to aliased mutable content', async () => {
    const root = await createFixture();
    await link(join(root, 'runtime'), join(root, 'runtime-hardlink'));

    await expect(createFirstPartyPayloadContentManifest(root)).rejects.toThrow(/hard link/i);
  });

  it('reserves the installed manifest filename so payload content cannot shadow provenance', async () => {
    const root = await createFixture();
    await writeFile(join(root, FIRST_PARTY_PAYLOAD_MANIFEST_FILE_NAME), 'shadow', 'utf8');

    await expect(createFirstPartyPayloadContentManifest(root)).rejects.toThrow(/reserved/i);
  });
});
