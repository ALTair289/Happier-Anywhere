import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/configuration', () => ({
  configuration: { serverUrl: 'http://example.test', apiServerUrl: 'http://example.test' },
}))

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn() },
}))

vi.mock('../client/loopbackUrl', () => ({
  resolveLoopbackHttpUrl: (url: string) => url,
}))

import axios from 'axios'
import { AxiosError, AxiosHeaders } from 'axios'

import { HttpStatusError, isAuthenticationError } from '@/api/client/httpStatusError'
import { logger } from '@/ui/logger'
import {
  fetchLatestUserPermissionIntentFromEncryptedTranscript,
  fetchRecentTranscriptTextItemsForAcpImportFromServer,
  hasCommittedUserMessageAfterMs,
} from './transcriptQueries'

const queryParams = {
  token: 't',
  sessionId: 's1',
  encryptionKey: new Uint8Array(32),
  encryptionVariant: 'dataKey' as const,
  sessionEncryptionMode: 'plain' as const,
}

describe('transcriptQueries (plaintext envelopes)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('prefilters ACP import candidates to user and agent rows while validating semantic transcript text', async () => {
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        messages: [
          {
            createdAt: 300,
            content: {
              t: 'plain',
              v: {
                role: 'agent',
                content: { type: 'acp', data: { type: 'tool-call', name: 'Bash' } },
              },
            },
          },
          {
            createdAt: 200,
            content: {
              t: 'plain',
              v: {
                role: 'agent',
                content: { type: 'acp', data: { type: 'message', message: 'assistant reply' } },
              },
            },
          },
          {
            createdAt: 100,
            content: {
              t: 'plain',
              v: {
                role: 'user',
                content: { type: 'text', text: 'user prompt' },
              },
            },
          },
        ],
      },
    } as any)

    await expect(fetchRecentTranscriptTextItemsForAcpImportFromServer({
      ...queryParams,
      take: 25,
    })).resolves.toEqual([
      { role: 'user', text: 'user prompt' },
      { role: 'agent', text: 'assistant reply' },
    ])

    expect(getSpy.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      params: { limit: 25, roles: 'user,agent' },
    }))
  })

  it('uses canonical semantic extraction for Codex assistant text during ACP import', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        messages: [
          {
            createdAt: 100,
            content: {
              t: 'plain',
              v: {
                role: 'agent',
                content: { type: 'codex', data: { type: 'message', message: 'codex reply' } },
              },
            },
          },
        ],
      },
    } as any)

    await expect(fetchRecentTranscriptTextItemsForAcpImportFromServer(queryParams)).resolves.toEqual([
      { role: 'agent', text: 'codex reply' },
    ])
  })

  it('resolves permission intent from plaintext transcript messages', async () => {
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        messages: [
          {
            createdAt: 123,
            content: {
              t: 'plain',
              v: {
                role: 'user',
                content: { type: 'text', text: 'hello' },
                meta: { permissionMode: 'yolo' },
              },
            },
          },
        ],
      },
    } as any)

    const res = await fetchLatestUserPermissionIntentFromEncryptedTranscript({
      ...queryParams,
    })

    expect(res).toEqual({ intent: 'yolo', updatedAt: 123 })
    expect(getSpy.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      params: { limit: 200, role: 'user' },
    }))
  })

  it('ignores plaintext permission metadata for an E2EE session', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        messages: [
          {
            createdAt: 123,
            content: {
              t: 'plain',
              v: {
                role: 'user',
                content: { type: 'text', text: 'hello' },
                meta: { permissionMode: 'yolo' },
              },
            },
          },
        ],
      },
    } as any)

    await expect(fetchLatestUserPermissionIntentFromEncryptedTranscript({
      ...queryParams,
      sessionEncryptionMode: 'e2ee',
    })).resolves.toBeNull()
  })

  it('checks committed user messages after a timestamp without decrypting content', async () => {
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        messages: [
          { createdAt: 1_500, content: { t: 'encrypted', c: 'opaque' } },
          { createdAt: 900, content: { t: 'encrypted', c: 'opaque' } },
        ],
      },
    } as any)

    await expect(hasCommittedUserMessageAfterMs({
      token: 't',
      sessionId: 's1',
      failureAtMs: 1_000,
    })).resolves.toBe(true)

    expect(getSpy.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      params: { limit: 25, role: 'user' },
    }))
  })

  it('keeps permission intent resolution scoped to semantically valid user rows', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        messages: [
          {
            createdAt: 300,
            content: {
              t: 'plain',
              v: {
                role: 'agent',
                content: { type: 'text', text: 'assistant text' },
                meta: { permissionMode: 'yolo' },
              },
            },
          },
          {
            createdAt: 200,
            content: {
              t: 'plain',
              v: {
                role: 'user',
                content: { type: 'acp', data: { type: 'tool-call', name: 'Bash' } },
                meta: { permissionMode: 'acceptEdits' },
              },
            },
          },
          {
            createdAt: 100,
            content: {
              t: 'plain',
              v: {
                role: 'user',
                content: { type: 'text', text: 'real user prompt' },
                meta: { permissionMode: 'read-only' },
              },
            },
          },
        ],
      },
    } as any)

    await expect(fetchLatestUserPermissionIntentFromEncryptedTranscript(queryParams)).resolves.toEqual({
      intent: 'read-only',
      updatedAt: 100,
    })
  })

  it.each([401, 403] as const)('rethrows auth failures while fetching ACP import transcript text (%s)', async (status) => {
    const authError = new HttpStatusError(status, 'Authentication failed')
    vi.spyOn(axios, 'get').mockRejectedValueOnce(authError)

    await expect(fetchRecentTranscriptTextItemsForAcpImportFromServer(queryParams)).rejects.toBe(authError)
    expect(isAuthenticationError(authError)).toBe(true)
  })

  it.each([401, 403] as const)('rethrows auth failures while fetching permission intent (%s)', async (status) => {
    const authError = new HttpStatusError(status, 'Authentication failed')
    vi.spyOn(axios, 'get').mockRejectedValueOnce(authError)

    await expect(fetchLatestUserPermissionIntentFromEncryptedTranscript(queryParams)).rejects.toBe(authError)
    expect(isAuthenticationError(authError)).toBe(true)
  })

  it('keeps non-auth ACP import fetch failures empty', async () => {
    vi.spyOn(axios, 'get').mockRejectedValueOnce(new Error('temporary server failure'))

    await expect(fetchRecentTranscriptTextItemsForAcpImportFromServer(queryParams)).resolves.toEqual([])
  })

  it('keeps non-auth permission intent fetch failures null', async () => {
    vi.spyOn(axios, 'get').mockRejectedValueOnce(new Error('temporary server failure'))

    await expect(fetchLatestUserPermissionIntentFromEncryptedTranscript(queryParams)).resolves.toBeNull()
  })

  it('redacts continuation transcript fetch diagnostics', async () => {
    const error = new AxiosError('connect failed', 'ECONNRESET', {
      method: 'get',
      url: 'https://api.example.test/v1/sessions/s1/messages?token=SECRET#hash',
      headers: new AxiosHeaders({ Authorization: 'Bearer SECRET' }),
      data: { secret: 'SECRET_BODY' },
    })
    vi.spyOn(axios, 'get').mockRejectedValueOnce(error)

    await expect(hasCommittedUserMessageAfterMs({
      token: 't',
      sessionId: 's1',
      failureAtMs: 1_000,
    })).rejects.toBe(error)

    const calls = JSON.stringify(vi.mocked(logger.debug).mock.calls)
    expect(calls).toContain('[API] Failed to fetch transcript messages for continuation recovery suppression')
    expect(calls).toContain('https://api.example.test/v1/sessions/s1/messages')
    expect(calls).not.toContain('Authorization')
    expect(calls).not.toContain('Bearer SECRET')
    expect(calls).not.toContain('SECRET_BODY')
    expect(calls).not.toContain('"headers"')
    expect(calls).not.toContain('"data"')
  })
})
