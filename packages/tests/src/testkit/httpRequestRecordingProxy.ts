import { once } from 'node:events';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';

export type RecordedHttpProxyRequest = Readonly<{
  id: number;
  method: string;
  path: string;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  startedAtMs: number;
  endedAtMs: number | null;
  statusCode: number | null;
  upgraded: boolean;
  error: string | null;
  responseDisposition: 'forwarded' | 'dropped_after_upstream' | null;
  responseBodyBytes: number | null;
}>;

export type OneShotResponseDropArm = Readonly<{
  armId: string;
  method: string;
  path: string;
  maxResponseBytes?: number;
}>;

export type HttpRequestRecordingProxy = Readonly<{
  baseUrl: string;
  entries: () => readonly RecordedHttpProxyRequest[];
  clear: () => void;
  count: (predicate?: (request: RecordedHttpProxyRequest) => boolean) => number;
  maxConcurrent: (predicate?: (request: RecordedHttpProxyRequest) => boolean) => number;
  armOneShotResponseDrop: (arm: OneShotResponseDropArm) => void;
  stop: () => Promise<void>;
}>;

const DEFAULT_RESPONSE_DROP_MAX_BYTES = 1024 * 1024;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
const SAFE_RECORDED_HEADER_NAMES = new Set(['x-happier-request-purpose']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeDelayMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.trunc(value), 60_000);
}

function cloneHeaders(headers: IncomingMessage['headers']): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase();
    out[normalized] = SAFE_RECORDED_HEADER_NAMES.has(normalized)
      ? Array.isArray(value) ? [...value] : value
      : '[redacted]';
  }
  return out;
}

function requireOriginFormPath(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error('httpRequestRecordingProxy requires an exact origin-form path');
  }
  return path;
}

function readOriginFormPathname(path: string): string {
  const originFormPath = requireOriginFormPath(path);
  const queryIndex = originFormPath.indexOf('?');
  return queryIndex < 0 ? originFormPath : originFormPath.slice(0, queryIndex);
}

function normalizeResponseDropArm(arm: OneShotResponseDropArm): Required<OneShotResponseDropArm> {
  const armId = arm.armId.trim();
  const method = arm.method.trim().toUpperCase();
  const path = readOriginFormPathname(arm.path);
  const maxResponseBytes = arm.maxResponseBytes ?? DEFAULT_RESPONSE_DROP_MAX_BYTES;
  if (!armId) throw new Error('httpRequestRecordingProxy response-drop armId is required');
  if (!method) throw new Error('httpRequestRecordingProxy response-drop method is required');
  if (path !== arm.path) throw new Error('httpRequestRecordingProxy response-drop path must be a pathname without a query');
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0 || maxResponseBytes > DEFAULT_RESPONSE_DROP_MAX_BYTES) {
    throw new Error(`httpRequestRecordingProxy response-drop maxResponseBytes must be between 1 and ${DEFAULT_RESPONSE_DROP_MAX_BYTES}`);
  }
  return { armId, method, path, maxResponseBytes };
}

function headerLinesFromRawHeaders(rawHeaders: readonly string[]): string {
  let out = '';
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const key = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (!key || value === undefined) continue;
    out += `${key}: ${value}\r\n`;
  }
  return out;
}

export async function startHttpRequestRecordingProxy(params: Readonly<{
  targetBaseUrl: string;
  delayRequestMs?: (request: RecordedHttpProxyRequest) => number | Promise<number>;
}>): Promise<HttpRequestRecordingProxy> {
  const target = new URL(params.targetBaseUrl);
  if (target.protocol !== 'http:') {
    throw new Error(`httpRequestRecordingProxy only supports http targets, got ${target.protocol}`);
  }
  if (!LOOPBACK_HOSTNAMES.has(target.hostname) || !target.port || target.username || target.password) {
    throw new Error('httpRequestRecordingProxy requires an explicit loopback target with a port');
  }
  if (target.pathname !== '/' || target.search || target.hash) {
    throw new Error('httpRequestRecordingProxy target must not contain a path, query, or fragment');
  }
  const targetConnectionHostname = target.hostname === '[::1]' ? '::1' : target.hostname;

  let nextId = 1;
  const entries: RecordedHttpProxyRequest[] = [];
  const usedResponseDropArmIds = new Set<string>();
  let responseDropArm: Required<OneShotResponseDropArm> | null = null;
  const sockets = new Set<Duplex>();
  const trackSocket = <T extends Duplex>(socket: T): T => {
    if (!sockets.has(socket)) {
      sockets.add(socket);
      socket.once('close', () => {
        sockets.delete(socket);
      });
    }
    return socket;
  };

  const begin = (req: IncomingMessage, upgraded: boolean) => {
    const entry: {
      id: number;
      method: string;
      path: string;
      headers: Readonly<Record<string, string | readonly string[] | undefined>>;
      startedAtMs: number;
      endedAtMs: number | null;
      statusCode: number | null;
      upgraded: boolean;
      error: string | null;
      responseDisposition: 'forwarded' | 'dropped_after_upstream' | null;
      responseBodyBytes: number | null;
    } = {
      id: nextId,
      method: req.method ?? 'GET',
      path: readOriginFormPathname(req.url ?? '/'),
      headers: cloneHeaders(req.headers),
      startedAtMs: Date.now(),
      endedAtMs: null,
      statusCode: null,
      upgraded,
      error: null,
      responseDisposition: null,
      responseBodyBytes: null,
    };
    nextId += 1;
    entries.push(entry);
    return entry;
  };

  const finish = (entry: ReturnType<typeof begin>, patch?: {
    statusCode?: number | null;
    error?: string | null;
    responseDisposition?: 'forwarded' | 'dropped_after_upstream' | null;
    responseBodyBytes?: number | null;
  }) => {
    if (entry.endedAtMs !== null) return;
    if (patch && 'statusCode' in patch) entry.statusCode = patch.statusCode ?? null;
    if (patch && 'error' in patch) entry.error = patch.error ?? null;
    if (patch && 'responseDisposition' in patch) entry.responseDisposition = patch.responseDisposition ?? null;
    if (patch && 'responseBodyBytes' in patch) entry.responseBodyBytes = patch.responseBodyBytes ?? null;
    entry.endedAtMs = Date.now();
  };

  const consumeMatchingResponseDropArm = (entry: ReturnType<typeof begin>): Required<OneShotResponseDropArm> | null => {
    const arm = responseDropArm;
    if (!arm || entry.method.toUpperCase() !== arm.method || entry.path !== arm.path) return null;
    responseDropArm = null;
    usedResponseDropArmIds.add(arm.armId);
    return arm;
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      requireOriginFormPath(req.url ?? '/');
    } catch (error) {
      res.statusCode = 400;
      res.end('invalid proxy request path');
      return;
    }
    const entry = begin(req, false);
    try {
      const delayMs = normalizeDelayMs(await params.delayRequestMs?.(entry));
      if (delayMs > 0) await sleep(delayMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.statusCode = 502;
      res.end('proxy delay failed');
      finish(entry, { statusCode: 502, error: message });
      return;
    }

    const headers = { ...req.headers, host: target.host };
    const dropArm = consumeMatchingResponseDropArm(entry);
    const upstream = httpRequest({
      protocol: target.protocol,
      hostname: targetConnectionHostname,
      port: target.port,
      method: req.method,
      path: req.url,
      headers,
    }, (upstreamRes) => {
      const statusCode = upstreamRes.statusCode ?? 502;
      if (!dropArm) {
        let responseBodyBytes = 0;
        upstreamRes.on('data', (chunk: Buffer | string) => {
          responseBodyBytes += Buffer.byteLength(chunk);
        });
        res.writeHead(statusCode, upstreamRes.statusMessage, upstreamRes.headers);
        upstreamRes.pipe(res);
        upstreamRes.once('end', () => finish(entry, {
          statusCode,
          responseDisposition: 'forwarded',
          responseBodyBytes,
        }));
        upstreamRes.once('error', (error) => finish(entry, { error: error.message }));
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        let responseBodyBytes = 0;
        upstreamRes.on('data', (chunk: Buffer | string) => {
          responseBodyBytes += Buffer.byteLength(chunk);
        });
        res.writeHead(statusCode, upstreamRes.statusMessage, upstreamRes.headers);
        upstreamRes.pipe(res);
        upstreamRes.once('end', () => finish(entry, {
          statusCode,
          error: 'response_drop_upstream_not_successful',
          responseDisposition: 'forwarded',
          responseBodyBytes,
        }));
        upstreamRes.once('error', (error) => finish(entry, { error: error.message }));
        return;
      }

      let responseBodyBytes = 0;
      let exceededLimit = false;
      const failIncompleteResponse = () => {
        finish(entry, {
          statusCode,
          error: 'response_drop_upstream_incomplete',
          responseBodyBytes,
        });
        res.destroy();
      };
      upstreamRes.on('data', (chunk: Buffer | string) => {
        if (exceededLimit) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        responseBodyBytes += buffer.byteLength;
        if (responseBodyBytes > dropArm.maxResponseBytes) {
          exceededLimit = true;
          finish(entry, {
            statusCode,
            error: 'response_drop_buffer_limit_exceeded',
            responseBodyBytes,
          });
          upstreamRes.destroy();
          res.destroy();
          return;
        }
      });
      upstreamRes.once('end', () => {
        if (exceededLimit) return;
        finish(entry, {
          statusCode,
          responseDisposition: 'dropped_after_upstream',
          responseBodyBytes,
        });
        res.destroy();
      });
      upstreamRes.once('aborted', failIncompleteResponse);
      upstreamRes.once('error', failIncompleteResponse);
    });

    upstream.once('error', (error) => {
      if (!res.headersSent) {
        res.statusCode = 502;
      }
      res.end('proxy upstream failed');
      finish(entry, { statusCode: res.statusCode, error: error.message, responseDisposition: 'forwarded' });
    });
    res.once('close', () => finish(entry, { statusCode: res.statusCode || null }));
    req.pipe(upstream);
  });

  server.on('connection', (socket) => {
    trackSocket(socket);
  });

  server.on('upgrade', (req, socket, head) => {
    try {
      requireOriginFormPath(req.url ?? '/');
    } catch {
      socket.destroy();
      return;
    }
    const entry = begin(req, true);
    trackSocket(socket);
    const targetSocket = trackSocket(connect({
      host: targetConnectionHostname,
      port: Number(target.port),
    }));
    targetSocket.once('connect', () => {
      targetSocket.write(`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/${req.httpVersion}\r\n`);
      targetSocket.write(headerLinesFromRawHeaders(req.rawHeaders));
      targetSocket.write('\r\n');
      if (head.length > 0) targetSocket.write(head);
      socket.pipe(targetSocket);
      targetSocket.pipe(socket);
    });
    targetSocket.once('error', (error) => {
      finish(entry, { error: error.message });
      socket.destroy();
    });
    targetSocket.once('close', () => socket.destroy());
    socket.once('close', () => {
      finish(entry);
      targetSocket.destroy();
    });
    socket.once('error', () => targetSocket.destroy());
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('http request recording proxy missing address');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    entries: () => entries.map((entry) => ({ ...entry, headers: { ...entry.headers } })),
    clear: () => {
      entries.length = 0;
    },
    count: (predicate) => entries.filter((entry) => predicate ? predicate(entry) : true).length,
    maxConcurrent: (predicate) => {
      const selected = entries.filter((entry) => predicate ? predicate(entry) : true);
      const events: Array<{ at: number; delta: 1 | -1 }> = [];
      for (const entry of selected) {
        events.push({ at: entry.startedAtMs, delta: 1 });
        events.push({ at: entry.endedAtMs ?? Date.now(), delta: -1 });
      }
      events.sort((a, b) => a.at === b.at ? b.delta - a.delta : a.at - b.at);
      let active = 0;
      let max = 0;
      for (const event of events) {
        active += event.delta;
        max = Math.max(max, active);
      }
      return max;
    },
    armOneShotResponseDrop: (rawArm) => {
      const arm = normalizeResponseDropArm(rawArm);
      if (responseDropArm) {
        throw new Error(`httpRequestRecordingProxy response drop is already armed (${responseDropArm.armId})`);
      }
      if (usedResponseDropArmIds.has(arm.armId)) {
        throw new Error(`httpRequestRecordingProxy response-drop armId was already used (${arm.armId})`);
      }
      responseDropArm = arm;
    },
    stop: async () => {
      for (const socket of [...sockets]) {
        socket.destroy();
      }
      if (!server.listening) return;
      await new Promise<void>((resolveStop, reject) => {
        server.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolveStop();
        });
      });
    },
  };
}
