import { describe, expect, it } from 'vitest';

import { buildServiceDefinition } from './manager';

describe('buildServiceDefinition restart policy', () => {
  it('renders an explicit on-failure systemd policy for a terminal successful disposition', () => {
    const definition = buildServiceDefinition({
      backend: 'systemd-user',
      homeDir: '/home/alice',
      spec: {
        label: 'dev.happier.stack.exp',
        programArgs: ['/opt/hstack', 'start', '--restart'],
        restartPolicy: 'on-failure',
      },
    });

    expect(definition.contents).toContain('Restart=on-failure');
    expect(definition.contents).not.toContain('Restart=always');
  });
});
