import {
  methods,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type ClientContext,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
} from '@agentclientprotocol/sdk';

export class AcpAgentPeer {
  constructor(
    private readonly context: ClientContext,
    private readonly connectionSignal: AbortSignal,
  ) {}

  private assertActive(): void {
    if (this.connectionSignal.aborted) {
      throw new Error('ACP connection is closed');
    }
  }

  initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.assertActive();
    return this.context.request(methods.agent.initialize, params);
  }

  authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
    this.assertActive();
    return this.context.request(methods.agent.authenticate, params);
  }

  newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.assertActive();
    return this.context.request(methods.agent.session.new, params);
  }

  loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.assertActive();
    return this.context.request(methods.agent.session.load, params).then((response) => response ?? {});
  }

  forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    this.assertActive();
    return this.context.request(methods.agent.session.fork, params);
  }

  prompt(params: PromptRequest): Promise<PromptResponse> {
    this.assertActive();
    return this.context.request(methods.agent.session.prompt, params);
  }

  setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    this.assertActive();
    return this.context.request(methods.agent.session.setMode, params);
  }

  setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    this.assertActive();
    return this.context.request(methods.agent.session.setConfigOption, params);
  }

  setSessionModelLegacy(params: Readonly<{ sessionId: string; modelId: string }>): Promise<unknown> {
    this.assertActive();
    return this.context.request('session/set_model', params);
  }

  cancel(params: CancelNotification): Promise<void> {
    this.assertActive();
    return this.context.notify(methods.agent.session.cancel, params);
  }

  async requestExtension<Response = unknown, Params = unknown>(
    method: string,
    params?: Params,
    options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>,
  ): Promise<Response> {
    this.assertActive();
    const timeoutMs = typeof options?.timeoutMs === 'number'
      && Number.isFinite(options.timeoutMs)
      && options.timeoutMs > 0
      ? Math.trunc(options.timeoutMs)
      : null;
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | null = null;

    const abortFromCaller = (): void => {
      if (!controller.signal.aborted) {
        const error = new Error('ACP extension request was aborted');
        error.name = 'AbortError';
        controller.abort(error);
      }
    };
    options?.signal?.addEventListener('abort', abortFromCaller, { once: true });
    if (options?.signal?.aborted) {
      abortFromCaller();
    }

    let timeoutError: Error | null = null;
    if (timeoutMs !== null) {
      timeout = setTimeout(() => {
        timeoutError = new Error(`ACP extension request timed out after ${timeoutMs}ms`);
        if (!controller.signal.aborted) {
          controller.abort(timeoutError);
        }
      }, timeoutMs);
      timeout.unref?.();
    }

    const request = this.context.request<Response, Params>(method, params, {
      cancellationSignal: controller.signal,
    });
    const aborted = new Promise<never>((_resolve, reject) => {
      const rejectAborted = (): void => {
        const reason = timeoutError ?? controller.signal.reason;
        if (reason instanceof Error) {
          reject(reason);
          return;
        }
        const error = new Error('ACP extension request was aborted');
        error.name = 'AbortError';
        reject(error);
      };
      if (controller.signal.aborted) {
        rejectAborted();
        return;
      }
      controller.signal.addEventListener('abort', rejectAborted, { once: true });
    });

    return await Promise.race([request, aborted]).finally(() => {
      if (timeout) clearTimeout(timeout);
      options?.signal?.removeEventListener('abort', abortFromCaller);
    });
  }

}
