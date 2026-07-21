import type {
  AgentApp,
  ClientApp,
  ParamsParser,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  Stream,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import { RequestError } from '@agentclientprotocol/sdk';

export type AcpClientTransport = Stream | AgentApp;

export type AcpClientConnectionHandlers = Readonly<{
  requestPermission: (
    params: RequestPermissionRequest,
  ) => RequestPermissionResponse | Promise<RequestPermissionResponse>;
  sessionUpdate: (params: SessionNotification) => void | Promise<void>;
  readTextFile?: (params: ReadTextFileRequest) => ReadTextFileResponse | Promise<ReadTextFileResponse>;
  writeTextFile?: (params: WriteTextFileRequest) => WriteTextFileResponse | Promise<WriteTextFileResponse>;
}>;

export type AcpExtensionHandlerContext = Readonly<{
  method: string;
  sessionId: string | null;
  signal: AbortSignal;
  agentName: string;
}>;

export type AcpExtensionContextFactory = (
  method: string,
  sdkSignal: AbortSignal,
) => AcpExtensionHandlerContext;

export type AcpExtensionRegistration = Readonly<{
  kind: 'request' | 'notification';
  method: string;
  register: (app: ClientApp, createContext: AcpExtensionContextFactory) => void;
}>;

function parseExtensionParams<Params>(parser: ParamsParser<Params>, value: unknown): Params {
  try {
    return typeof parser === 'function' ? parser(value) : parser.parse(value);
  } catch (error) {
    if (error instanceof RequestError) {
      throw error;
    }
    throw RequestError.invalidParams(
      { details: 'Extension parameters failed validation' },
    );
  }
}

function wrapExtensionParamsParser<Params>(parser: ParamsParser<Params>): ParamsParser<Params> {
  return { parse: (value) => parseExtensionParams(parser, value) };
}

export function defineAcpExtensionRequest<Params, Response extends Record<string, unknown>>(definition: Readonly<{
  method: string;
  params: ParamsParser<Params>;
  handler: (
    params: Params,
    context: AcpExtensionHandlerContext,
  ) => Response | Promise<Response>;
}>): AcpExtensionRegistration {
  return {
    kind: 'request',
    method: definition.method,
    register: (app, createContext) => {
      app.onRequest(definition.method, wrapExtensionParamsParser(definition.params), async (context) => {
        const extensionContext = createContext(definition.method, context.signal);
        const response = await definition.handler(
          context.params,
          extensionContext,
        );
        if (extensionContext.signal.aborted) {
          throw RequestError.invalidRequest(
            { reason: 'prompt_turn_ended' },
            'ACP extension request outlived its prompt turn',
          );
        }
        return response;
      });
    },
  };
}

export function defineAcpExtensionNotification<Params>(definition: Readonly<{
  method: string;
  params: ParamsParser<Params>;
  handler: (
    params: Params,
    context: AcpExtensionHandlerContext,
  ) => void | Promise<void>;
}>): AcpExtensionRegistration {
  return {
    kind: 'notification',
    method: definition.method,
    register: (app, createContext) => {
      app.onNotification(definition.method, wrapExtensionParamsParser(definition.params), (context) => (
        definition.handler(
          context.params,
          createContext(definition.method, context.signal),
        )
      ));
    },
  };
}

export type AcpClientConnectionOptions = Readonly<{
  name: string;
  transport: AcpClientTransport;
  handlers: AcpClientConnectionHandlers;
  extensions?: ReadonlyArray<AcpExtensionRegistration>;
  createExtensionContext?: AcpExtensionContextFactory;
}>;
