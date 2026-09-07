import type { BridgeErrorData, ProviderRecoveryHint } from "../errors.js";

export type BridgeJsonRpcId = string | number;

type BridgeJsonRpcResponse =
  | {
      jsonrpc: "2.0";
      id: BridgeJsonRpcId;
      result: unknown;
    }
  | {
      jsonrpc: "2.0";
      id: BridgeJsonRpcId;
      error: { code: number; message: string; data?: BridgeErrorData };
    };

export type BridgeSendError = (
  id: BridgeJsonRpcId,
  code: number,
  message: string,
  data?: BridgeErrorData,
) => void;

export class BridgeRecoveryError extends Error {
  readonly code: number;
  readonly recovery: ProviderRecoveryHint;

  constructor(args: {
    code: number;
    message: string;
    recovery: ProviderRecoveryHint;
    cause?: unknown;
  }) {
    super(
      args.message,
      args.cause === undefined ? undefined : { cause: args.cause },
    );
    this.name = "BridgeRecoveryError";
    this.code = args.code;
    this.recovery = args.recovery;
  }
}

interface CreateBridgeIoArgs {
  write?: (line: string) => void;
}

export function createBridgeIo<TMessage>({
  write = (line) => process.stdout.write(line),
}: CreateBridgeIoArgs = {}): {
  send: (message: TMessage | BridgeJsonRpcResponse) => void;
  sendError: BridgeSendError;
  sendResult: (id: BridgeJsonRpcId, result: unknown) => void;
} {
  const send = (message: TMessage | BridgeJsonRpcResponse): void => {
    write(`${JSON.stringify(message)}\n`);
  };
  return {
    send,
    sendError: (id, code, message, data) => {
      send({
        jsonrpc: "2.0",
        id,
        error: { code, message, ...(data === undefined ? {} : { data }) },
      });
    },
    sendResult: (id, result) => {
      send({ jsonrpc: "2.0", id, result });
    },
  };
}

export function createBridgeLineHandler(args: {
  handleParsedMessage: (message: unknown) => void;
}): (line: string) => void {
  return (line): void => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    args.handleParsedMessage(parsed);
  };
}

export function runBridgeRequest<
  TRequest extends { id: BridgeJsonRpcId },
>(args: {
  handleRequest: (request: TRequest) => Promise<void>;
  request: TRequest;
  sendError: BridgeSendError;
}): void {
  void args.handleRequest(args.request).catch((error: unknown) => {
    if (error instanceof BridgeRecoveryError) {
      args.sendError(args.request.id, error.code, error.message, {
        recovery: error.recovery,
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    args.sendError(args.request.id, -32000, message);
  });
}
