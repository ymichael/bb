import {
  hostDaemonOnlineRpcResponseMessageSchema,
  hostDaemonServerWsMessageSchema,
  type HostDaemonOnlineRpcRequestMessage,
  type HostDaemonOnlineRpcResponseMessage,
  type HostDaemonRpcResultForCommand,
} from "@bb/host-daemon-contract";
import type { AvailableModel } from "@bb/domain";
import type { TestAppHarness } from "./test-app.js";
import { registerTestHostRpcCapture } from "./commands.js";

interface TestHostRpcSocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

interface ProviderModelResponse {
  models: AvailableModel[];
  selectedOnlyModels: AvailableModel[];
}

interface ProviderModelError {
  errorCode: string;
  errorMessage: string;
}

interface RegisterProviderHostRpcArgs {
  hostId: string;
  modelErrorsByProviderId?: Record<string, ProviderModelError>;
  modelsByProviderId?: Record<string, ProviderModelResponse>;
  sessionId: string;
  restoreCommandCaptureAfterResponse?: boolean;
}

interface ProviderHostRpcResponder {
  requests: HostDaemonOnlineRpcRequestMessage[];
  unregister(): void;
}

export type HostRpcHandlerResult =
  | {
      ok: true;
      result: HostDaemonRpcResultForCommand<
        HostDaemonOnlineRpcRequestMessage["command"]
      >;
    }
  | {
      ok: false;
      errorCode: string;
      errorMessage: string;
    };

export interface RegisterHostRpcResponderArgs {
  handle: (
    request: HostDaemonOnlineRpcRequestMessage,
  ) => HostRpcHandlerResult | Promise<HostRpcHandlerResult>;
  hostId: string;
  sessionId: string;
  restoreCommandCaptureAfterResponse?: boolean;
}

export interface HostRpcResponder {
  requests: HostDaemonOnlineRpcRequestMessage[];
  unregister(): void;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildTestFailureResponse(
  request: HostDaemonOnlineRpcRequestMessage,
  error: unknown,
): HostDaemonOnlineRpcResponseMessage {
  return {
    type: "host-rpc.response",
    requestId: request.requestId,
    commandType: request.command.type,
    ok: false,
    errorCode: "test_rpc_error",
    errorMessage: toErrorMessage(error),
  };
}

function buildProviderRpcResponse(
  args: RegisterProviderHostRpcArgs,
  request: HostDaemonOnlineRpcRequestMessage,
): HostDaemonOnlineRpcResponseMessage {
  if (request.command.type !== "provider.list_models") {
    throw new Error(`Unexpected provider RPC command ${request.command.type}`);
  }

  const providerId = request.command.providerId;
  const error = args.modelErrorsByProviderId?.[providerId];
  if (error) {
    return {
      type: "host-rpc.response",
      requestId: request.requestId,
      commandType: request.command.type,
      ok: false,
      errorCode: error.errorCode,
      errorMessage: error.errorMessage,
    };
  }

  const result = args.modelsByProviderId?.[providerId] ?? {
    models: [],
    selectedOnlyModels: [],
  };
  return {
    type: "host-rpc.response",
    requestId: request.requestId,
    commandType: request.command.type,
    ok: true,
    result,
  };
}

function buildHostRpcResponse(
  request: HostDaemonOnlineRpcRequestMessage,
  result: HostRpcHandlerResult,
): HostDaemonOnlineRpcResponseMessage {
  if (result.ok) {
    return hostDaemonOnlineRpcResponseMessageSchema.parse({
      type: "host-rpc.response",
      requestId: request.requestId,
      commandType: request.command.type,
      ok: true,
      result: result.result,
    });
  }
  return {
    type: "host-rpc.response",
    requestId: request.requestId,
    commandType: request.command.type,
    ok: false,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
  };
}

export function registerHostRpcResponder(
  harness: TestAppHarness,
  args: RegisterHostRpcResponderArgs,
): HostRpcResponder {
  const requests: HostDaemonOnlineRpcRequestMessage[] = [];
  const socket: TestHostRpcSocket = {
    close() {},
    send(data) {
      const message = hostDaemonServerWsMessageSchema.parse(JSON.parse(data));
      if (message.type !== "host-rpc.request") {
        throw new Error(`Unexpected daemon websocket message ${message.type}`);
      }
      requests.push(message);
      const respond = (
        build: () => HostDaemonOnlineRpcResponseMessage,
      ): void => {
        let response: HostDaemonOnlineRpcResponseMessage;
        try {
          response = build();
        } catch (error) {
          response = buildTestFailureResponse(message, error);
        }
        harness.hub.recordHostOnlineRpcResponse({
          message: response,
          sessionId: args.sessionId,
        });
        if (args.restoreCommandCaptureAfterResponse) {
          registerTestHostRpcCapture(harness, {
            hostId: args.hostId,
            sessionId: args.sessionId,
          });
        }
      };
      let handled: HostRpcHandlerResult | Promise<HostRpcHandlerResult>;
      try {
        handled = args.handle(message);
      } catch (error) {
        respond(() => buildTestFailureResponse(message, error));
        return;
      }
      if (handled instanceof Promise) {
        void handled.then(
          (result) => respond(() => buildHostRpcResponse(message, result)),
          (error: unknown) =>
            respond(() => buildTestFailureResponse(message, error)),
        );
        return;
      }
      const result = handled;
      respond(() => buildHostRpcResponse(message, result));
    },
  };
  harness.hub.registerDaemon(args.sessionId, args.hostId, socket);

  return {
    requests,
    unregister() {
      harness.hub.unregisterDaemon(args.sessionId);
    },
  };
}

export function registerProviderHostRpcResponder(
  harness: TestAppHarness,
  args: RegisterProviderHostRpcArgs,
): ProviderHostRpcResponder {
  return registerHostRpcResponder(harness, {
    hostId: args.hostId,
    sessionId: args.sessionId,
    restoreCommandCaptureAfterResponse: args.restoreCommandCaptureAfterResponse,
    handle: (request) => {
      const response = buildProviderRpcResponse(args, request);
      if (response.ok) {
        return { ok: true, result: response.result };
      }
      return {
        ok: false,
        errorCode: response.errorCode,
        errorMessage: response.errorMessage,
      };
    },
  });
}
