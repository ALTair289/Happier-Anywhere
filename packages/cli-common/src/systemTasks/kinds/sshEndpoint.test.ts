import { describe, expect, it, vi } from 'vitest';

import { resolveSystemTaskSshEndpoint } from './sshEndpoint.js';

describe('resolveSystemTaskSshEndpoint', () => {
  it('resolves an alias HostName and Port from the selected SSH config', () => {
    const resolveSshConfig = vi.fn(() => ({
      status: 0,
      stdout: 'hostname 2001:db8::25\nport 2205\n',
      stderr: '',
    }));

    const endpoint = resolveSystemTaskSshEndpoint({
      ssh: {
        target: 'ops@edge-alias',
        auth: 'agent',
        sshConfigFile: '/tmp/happier-ssh.config',
      },
    }, { resolveSshConfig });

    expect(resolveSshConfig).toHaveBeenCalledWith({
      sshConfigFile: '/tmp/happier-ssh.config',
      target: 'ops@edge-alias',
    });
    expect(endpoint).toEqual({
      ssh: {
        target: 'ops@edge-alias',
        auth: 'agent',
        sshConfigFile: '/tmp/happier-ssh.config',
        port: 2205,
      },
      keyscanHost: '2001:db8::25',
      knownHostsHost: '[2001:db8::25]:2205',
      assertConfigUnchanged: expect.any(Function),
      assertKeyscanSupported: expect.any(Function),
    });
  });

  it('keeps an explicit port authoritative over the selected SSH config', () => {
    const endpoint = resolveSystemTaskSshEndpoint({
      ssh: {
        target: 'edge-alias:2022',
        port: 2222,
        auth: 'agent',
        sshConfigFile: '/tmp/happier-ssh.config',
      },
    }, {
      resolveSshConfig: () => ({
        status: 0,
        stdout: 'hostname edge.internal\nport 2205\n',
      }),
    });

    expect(endpoint.ssh.target).toBe('edge-alias');
    expect(endpoint.ssh.port).toBe(2222);
    expect(endpoint.keyscanHost).toBe('edge.internal');
  });

  it('normalizes bracketed IPv6 targets while preserving the embedded port', () => {
    expect(resolveSystemTaskSshEndpoint({
      ssh: {
        target: 'ops@[2001:db8::42]:2224',
        auth: 'agent',
      },
    })).toEqual({
      ssh: {
        target: 'ops@[2001:db8::42]',
        auth: 'agent',
        port: 2224,
      },
      keyscanHost: '2001:db8::42',
      knownHostsHost: '[2001:db8::42]:2224',
      assertConfigUnchanged: expect.any(Function),
      assertKeyscanSupported: expect.any(Function),
    });
  });

  it('uses an embedded target port ahead of the selected SSH config port', () => {
    const endpoint = resolveSystemTaskSshEndpoint({
      ssh: {
        target: 'edge-alias:2022',
        auth: 'agent',
        sshConfigFile: '/tmp/happier-ssh.config',
      },
    }, {
      resolveSshConfig: () => ({ status: 0, stdout: 'hostname edge.internal\nport 2205\n' }),
    });

    expect(endpoint.ssh.port).toBe(2022);
    expect(endpoint.knownHostsHost).toBe('[edge.internal]:2022');
  });

  it('uses HostKeyAlias for the persisted known_hosts identity', () => {
    const endpoint = resolveSystemTaskSshEndpoint({
      ssh: {
        target: 'edge-alias',
        auth: 'agent',
        sshConfigFile: '/tmp/happier-ssh.config',
      },
    }, {
      resolveSshConfig: () => ({
        status: 0,
        stdout: 'hostname edge.internal\nport 2205\nhostkeyalias stable-edge-key\n',
      }),
    });

    expect(endpoint.keyscanHost).toBe('edge.internal');
    expect(endpoint.knownHostsHost).toBe('[stable-edge-key]:2205');
  });

  it.each(['proxyjump bastion', 'proxycommand ssh bastion -W %h:%p'])(
    'fails closed before direct keyscan for %s',
    (proxyLine) => {
      const endpoint = resolveSystemTaskSshEndpoint({
        ssh: {
          target: 'edge-alias',
          auth: 'agent',
          sshConfigFile: '/tmp/happier-ssh.config',
        },
      }, {
        resolveSshConfig: () => ({
          status: 0,
          stdout: `hostname edge.internal\nport 22\n${proxyLine}\n`,
        }),
      });

      expect(() => endpoint.assertKeyscanSupported()).toThrow(/cannot safely reproduce.*refusing direct keyscan/i);
    },
  );

  it('refuses transport when the canonical SSH config output changes', () => {
    const outputs = [
      'hostname edge.internal\r\nport 22\r\nuser ops\r\n',
      'hostname edge.internal\nport 22\nuser ops\n',
      'hostname edge.internal\nport 22\nuser root\n',
    ];
    const endpoint = resolveSystemTaskSshEndpoint({
      ssh: {
        target: 'edge-alias',
        auth: 'agent',
        sshConfigFile: '/tmp/happier-ssh.config',
      },
    }, {
      resolveSshConfig: () => ({ status: 0, stdout: outputs.shift() ?? '' }),
    });

    expect(() => endpoint.assertConfigUnchanged()).not.toThrow();
    expect(() => endpoint.assertConfigUnchanged()).toThrow(/config changed.*refusing/i);
  });
});
