import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TransferSessionStore } from '@/transfers/core/transferSessionStore';
import { createTransferRecipientKeyPair } from '@/machines/transfer/transferChunkEncryption';
import {
  type ApiSessionSocketStub,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

import { ApiSessionClient } from './sessionClient';

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;

vi.mock('./sockets', () => ({
  createUserScopedSocket: () => {
    if (!userSocketStub) throw new Error('Missing user socket stub');
    return userSocketStub as any;
  },
}));

vi.mock('./connection/createSessionSocketTransport', () => ({
  createSessionSocketTransport: () => {
    if (!sessionSocketStub) throw new Error('Missing session socket stub');
    return {
      socket: sessionSocketStub as any,
      transport: {
        connect: async () => {},
        disconnect: async () => {},
        destroy: async () => {},
        isConnected: () => sessionSocketStub?.connected === true,
        onConnected: () => () => {},
        onDisconnected: () => () => {},
        onError: () => () => {},
      },
    };
  },
}));

vi.mock('@happier-dev/connection-supervisor', () => ({
  DEFAULT_MANAGED_CONNECTION_POLICY: {},
  createManagedConnectionSupervisor: (params: { createTransport: () => unknown }) => ({
    start: async () => {
      params.createTransport();
    },
    stop: async () => {},
  }),
}));

vi.mock('./sessionMessageCatchUp', () => ({
  catchUpSessionMessagesAfterSeq: vi.fn(async () => {}),
}));

async function expectPathMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

async function withTimeout<T>(label: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 5_000);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

describe('ApiSessionClient transfer lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('disposes abandoned transfer resources when the session client closes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'happier-session-client-transfer-'));
    sessionSocketStub = createApiSessionSocketStub({ id: 'session-socket', connected: true });
    userSocketStub = createApiSessionSocketStub({ id: 'user-socket', connected: false });

    try {
      const client = new ApiSessionClient('tok', createPlainSessionFixture({
        id: 's1',
        metadata: createTestMetadata({ path: workspace }),
      }));
      const registration = (client as any).rpcLifecycleRegistrations?.[0] as {
        transferSessionStore: TransferSessionStore;
      } | undefined;

      expect(registration).toBeTruthy();

      const uploadInitResult = await withTimeout('upload init', client.rpcHandlerManager.invokeLocal(
        RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT,
        {
          t: 'session_file_upload_v1',
          path: 'abandoned-upload.txt',
          sizeBytes: 4,
          overwrite: false,
        },
      ));
      expect(uploadInitResult).toMatchObject({ success: true, uploadId: expect.any(String) });
      const uploadId = (uploadInitResult as { uploadId: string }).uploadId;
      const uploadSession = registration?.transferSessionStore.getUploadSession(uploadId);
      const uploadTempPath = uploadSession?.tempPath ?? '';
      await expect(access(uploadTempPath)).resolves.toBeUndefined();

      const downloadDir = join(workspace, 'download-dir');
      await mkdir(downloadDir, { recursive: true });
      await writeFile(join(downloadDir, 'source.txt'), 'download me', 'utf8');
      const recipient = createTransferRecipientKeyPair();
      const downloadInitResult = await withTimeout('download init', client.rpcHandlerManager.invokeLocal(
        RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT,
        {
          t: 'session_file_download_v1',
          path: 'download-dir',
          asZip: true,
          recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
        },
      ));
      expect(downloadInitResult).toMatchObject({ success: true, downloadId: expect.any(String) });
      const downloadId = (downloadInitResult as { downloadId: string }).downloadId;
      const downloadSession = registration?.transferSessionStore.getDownloadSession(downloadId);
      const downloadTempPath = downloadSession?.filePath ?? '';
      await expect(access(downloadTempPath)).resolves.toBeUndefined();

      await withTimeout('first close', client.close());
      await withTimeout('second close', client.close());

      expect(registration?.transferSessionStore.getUploadSession(uploadId)).toBeNull();
      expect(registration?.transferSessionStore.getDownloadSession(downloadId)).toBeNull();
      await expectPathMissing(uploadTempPath);
      await expectPathMissing(downloadTempPath);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
