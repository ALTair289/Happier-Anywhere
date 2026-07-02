import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Machine } from '@/api/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { TransferSessionStore } from '@/transfers/core/transferSessionStore';
import { createTransferRecipientKeyPair } from '@/machines/transfer/transferChunkEncryption';

import { ApiMachineClient } from './apiMachine';

function createMachine(): Machine {
  return {
    id: 'machine-test',
    encryptionKey: new Uint8Array(32).fill(7),
    encryptionVariant: 'legacy',
    metadata: null,
    metadataVersion: 0,
    daemonState: null,
    daemonStateVersion: 0,
  };
}

async function expectPathMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('ApiMachineClient filesystem handlers', () => {
  it('registers filesystem RPCs as machine-scoped handlers', () => {
    const client = new ApiMachineClient('token', createMachine());
    const rpc = (client as any).rpcHandlerManager as {
      hasHandler: (method: string) => boolean;
    };

    expect(rpc.hasHandler(RPC_METHODS.READ_FILE)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.WRITE_FILE)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.CREATE_DIRECTORY)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.LIST_DIRECTORY)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.GET_DIRECTORY_TREE)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.STAT_FILE)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.RENAME_PATH)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DELETE_PATH)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_CHUNK)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_FINALIZE)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_ABORT)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_CHUNK)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT)).toBe(true);
  });

  it('disposes abandoned filesystem transfer resources when the machine client shuts down', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'happier-machine-client-transfer-'));
    const client = new ApiMachineClient('token', createMachine());
    const registration = (client as any).rpcLifecycleRegistrations?.[1] as {
      transferSessionStore: TransferSessionStore;
    } | undefined;

    try {
      expect(registration).toBeTruthy();

      const uploadInitResult = await (client as any).rpcHandlerManager.invokeLocal(
        RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT,
        {
          t: 'session_file_upload_v1',
          path: join(workspace, 'abandoned-upload.txt'),
          sizeBytes: 4,
          overwrite: false,
        },
      );
      expect(uploadInitResult).toMatchObject({ success: true, uploadId: expect.any(String) });
      const uploadId = (uploadInitResult as { uploadId: string }).uploadId;
      const uploadSession = registration?.transferSessionStore.getUploadSession(uploadId);
      const uploadTempPath = uploadSession?.tempPath ?? '';
      await expect(access(uploadTempPath)).resolves.toBeUndefined();

      const downloadDir = join(workspace, 'download-dir');
      await mkdir(downloadDir, { recursive: true });
      await writeFile(join(downloadDir, 'source.txt'), 'download me', 'utf8');
      const recipient = createTransferRecipientKeyPair();
      const downloadInitResult = await (client as any).rpcHandlerManager.invokeLocal(
        RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT,
        {
          t: 'session_file_download_v1',
          path: downloadDir,
          asZip: true,
          recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
        },
      );
      expect(downloadInitResult).toMatchObject({ success: true, downloadId: expect.any(String) });
      const downloadId = (downloadInitResult as { downloadId: string }).downloadId;
      const downloadSession = registration?.transferSessionStore.getDownloadSession(downloadId);
      const downloadTempPath = downloadSession?.filePath ?? '';
      await expect(access(downloadTempPath)).resolves.toBeUndefined();

      await client.shutdown();
      await client.shutdown();

      expect(registration?.transferSessionStore.getUploadSession(uploadId)).toBeNull();
      expect(registration?.transferSessionStore.getDownloadSession(downloadId)).toBeNull();
      await expectPathMissing(uploadTempPath);
      await expectPathMissing(downloadTempPath);
    } finally {
      await client.shutdown();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
