import { describe, expect, it } from 'vitest';

import { initialMachineMetadata } from './metadata';

describe('initialMachineMetadata', () => {
  it('advertises typed daemon terminal session attach support', () => {
    expect(initialMachineMetadata.daemonTerminalSessionAttachSupported).toBe(true);
  });
});
