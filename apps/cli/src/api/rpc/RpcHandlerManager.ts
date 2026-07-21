/**
 * Generic RPC handler manager for session and machine clients
 * Manages RPC method registration, encryption/decryption, and handler execution
 */

import { logger as defaultLogger } from '@/ui/logger';
import { decodeBase64, encodeBase64, encrypt, decrypt } from '@/api/encryption';
import {
    RpcHandler,
    RpcHandlerMap,
    RpcRequest,
    RpcHandlerConfig,
    type RpcAuthorizationResult,
} from './types';
import { Socket } from 'socket.io-client';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import {
    RPC_ERROR_CODES,
    RPC_ERROR_MESSAGES,
    isDelegatedSessionApprovalRpcMethod,
} from '@happier-dev/protocol/rpc';
import { isPublicRpcHandlerError, toSocketRpcTargetFailureV1 } from '@happier-dev/protocol/rpcErrors';

export class RpcHandlerManager {
    private handlers: RpcHandlerMap = new Map();
    private readonly scopePrefix: string;
    private readonly encryptionKey: Uint8Array;
    private readonly encryptionVariant: 'legacy' | 'dataKey';
    private readonly encryptionMode: 'e2ee' | 'plain';
    private readonly logger: (message: string, data?: any) => void;
    private readonly authorizeRequest: RpcHandlerConfig['authorizeRequest'];
    private socket: Socket | null = null;
    private inFlightRequestCount = 0;
    private idleResolvers = new Set<() => void>();

    constructor(config: RpcHandlerConfig) {
        this.scopePrefix = config.scopePrefix;
        this.encryptionKey = config.encryptionKey;
        this.encryptionVariant = config.encryptionVariant;
        this.encryptionMode = config.encryptionMode ?? 'e2ee';
        this.logger = config.logger || ((msg, data) => defaultLogger.debug(msg, data));
        this.authorizeRequest = config.authorizeRequest;
    }

    private encodeResponse(response: unknown): unknown {
        if (this.encryptionMode === 'plain') return response;
        return encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, response));
    }

    /**
     * Register an RPC handler for a specific method
     * @param method - The method name (without prefix)
     * @param handler - The handler function
     */
    registerHandler<TRequest = any, TResponse = any>(
        method: string,
        handler: RpcHandler<TRequest, TResponse>
    ): void {
        const prefixedMethod = this.getPrefixedMethod(method);

        // Store the handler
        this.handlers.set(prefixedMethod, handler);

        if (this.socket) {
            this.socket.emit(SOCKET_RPC_EVENTS.REGISTER, { method: prefixedMethod });
        }
    }

    /**
     * Handle an incoming RPC request
     * @param request - The RPC request data
     * @param callback - The response callback
     */
    async handleRequest(
        request: RpcRequest,
    ): Promise<any> {
        this.beginInFlightRequest();
        try {
            const handler = this.handlers.get(request.method);

            if (!handler) {
                this.logger('[RPC] [ERROR] Method not found', { method: request.method });
                const errorResponse = { error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
                return this.encodeResponse(errorResponse);
            }

            // Decrypt the incoming params (unless session is plaintext).
            const decryptedParams = this.encryptionMode === 'plain'
              ? request.params
              : typeof request.params === 'string'
                ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(request.params))
                : null;
            if (this.encryptionMode !== 'plain' && decryptedParams === null) {
              const errorResponse = {
                error: 'Invalid RPC params',
              };
              return this.encodeResponse(errorResponse);
            }

            const authorizationResult: RpcAuthorizationResult = this.authorizeRequest
              ? await this.authorizeRequest({
                method: request.method,
                params: decryptedParams,
                authorization: request.authorization,
              })
              : { ok: true };
            if (authorizationResult.ok !== true) {
              return this.encodeResponse({
                error: authorizationResult.error,
                ...(authorizationResult.errorCode ? { errorCode: authorizationResult.errorCode } : {}),
              });
            }

            // Call the handler
            this.logger('[RPC] Calling handler', { method: request.method });
            const result = await handler(decryptedParams);
            this.logger('[RPC] Handler returned', { method: request.method, hasResult: result !== undefined });

            // Encrypt and return the response
            const response = this.encodeResponse(result);
            if (this.encryptionMode !== 'plain' && typeof response === 'string') {
              this.logger('[RPC] Sending encrypted response', { method: request.method, responseLength: response.length });
            }
            return response;
        } catch (error) {
            const scopePrefix = `${this.scopePrefix}:`;
            const methodSuffix = request.method.startsWith(scopePrefix)
                ? request.method.slice(scopePrefix.length)
                : '';
            if (isPublicRpcHandlerError(error) && isDelegatedSessionApprovalRpcMethod(methodSuffix)) {
                return toSocketRpcTargetFailureV1(error);
            }
            this.logger('[RPC] [ERROR] Error handling request', { error });
            const errorResponse = {
                error: error instanceof Error ? error.message : 'Unknown error'
            };
            return this.encodeResponse(errorResponse);
        } finally {
            this.finishInFlightRequest();
        }
    }

    /**
     * Invoke a registered handler in-process (no encryption/decryption).
     *
     * This is intended for internal control-plane surfaces (e.g. MCP tools) that
     * must delegate to the same handler implementations as session RPC.
     */
    async invokeLocal(method: string, params: unknown): Promise<unknown> {
        const prefixedMethod = this.getPrefixedMethod(method);
        const handler = this.handlers.get(prefixedMethod);
        if (!handler) {
            return { error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
        }
        this.beginInFlightRequest();
        try {
            return await handler(params as any);
        } finally {
            this.finishInFlightRequest();
        }
    }

    onSocketConnect(socket: Socket): void {
        this.socket = socket;
        for (const [prefixedMethod] of this.handlers) {
            socket.emit(SOCKET_RPC_EVENTS.REGISTER, { method: prefixedMethod });
        }
    }

    onSocketDisconnect(): void {
        this.socket = null;
    }

    /**
     * Get the number of registered handlers
     */
    getHandlerCount(): number {
        return this.handlers.size;
    }

    getInFlightRequestCount(): number {
        return this.inFlightRequestCount;
    }

    async waitForIdle(): Promise<void> {
        if (this.inFlightRequestCount === 0) {
            return;
        }
        await new Promise<void>((resolve) => {
            this.idleResolvers.add(resolve);
        });
    }

    /**
     * Check if a handler is registered
     * @param method - The method name (without prefix)
     */
    hasHandler(method: string): boolean {
        const prefixedMethod = this.getPrefixedMethod(method);
        return this.handlers.has(prefixedMethod);
    }

    /**
     * Clear all handlers
     */
    clearHandlers(): void {
        this.handlers.clear();
        this.logger('Cleared all RPC handlers');
    }

    /**
     * Get the prefixed method name
     * @param method - The method name
     */
    private getPrefixedMethod(method: string): string {
        return `${this.scopePrefix}:${method}`;
    }

    private beginInFlightRequest(): void {
        this.inFlightRequestCount += 1;
    }

    private finishInFlightRequest(): void {
        this.inFlightRequestCount = Math.max(0, this.inFlightRequestCount - 1);
        if (this.inFlightRequestCount === 0 && this.idleResolvers.size > 0) {
            const resolvers = Array.from(this.idleResolvers);
            this.idleResolvers.clear();
            for (const resolve of resolvers) {
                resolve();
            }
        }
    }
}

/**
 * Factory function to create an RPC handler manager
 */
export function createRpcHandlerManager(config: RpcHandlerConfig): RpcHandlerManager {
    return new RpcHandlerManager(config);
}
