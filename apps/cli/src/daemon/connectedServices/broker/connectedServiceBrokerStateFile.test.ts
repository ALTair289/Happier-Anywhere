import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isConnectedServiceBrokerStateFileUsable } from './connectedServiceBrokerStateFile';

async function writeState(value: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'happier-broker-state-'));
  const path = join(directory, 'broker.json');
  await writeFile(path, JSON.stringify(value), 'utf8');
  return path;
}

describe('isConnectedServiceBrokerStateFileUsable', () => {
  it('accepts only a bounded TCP port and non-blank scoped capability', async () => {
    await expect(isConnectedServiceBrokerStateFileUsable(await writeState({
      httpPort: 41_999,
      connectedServiceBrokerRefreshToken: ' scoped ',
    }))).resolves.toBe(true);
    await expect(isConnectedServiceBrokerStateFileUsable(await writeState({
      httpPort: 0,
      connectedServiceBrokerRefreshToken: 'scoped',
    }))).resolves.toBe(false);
    await expect(isConnectedServiceBrokerStateFileUsable(await writeState({
      httpPort: 65_536,
      connectedServiceBrokerRefreshToken: 'scoped',
    }))).resolves.toBe(false);
    await expect(isConnectedServiceBrokerStateFileUsable(await writeState({
      httpPort: 41_999,
      connectedServiceBrokerRefreshToken: '   ',
    }))).resolves.toBe(false);
  });
});
