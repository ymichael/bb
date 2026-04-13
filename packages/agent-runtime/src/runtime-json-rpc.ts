import type { ChildProcess } from "node:child_process";
import { z } from "zod";
import {
  ProviderRequestDecodeError,
  type JsonRpcMessage,
} from "./provider-adapter.js";

export interface PendingJsonRpcRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export const ignoredJsonRpcResultSchema = z.unknown();

export interface SendJsonRpcRequestArgs<TResult> {
  child: ChildProcess;
  getNextId: () => number;
  message: JsonRpcMessage;
  pending: Map<string | number, PendingJsonRpcRequest>;
  resultSchema: z.ZodType<TResult>;
  timeoutMs?: number;
}

interface SendJsonRpcResultArgs {
  child: ChildProcess;
  id: string | number;
  result: unknown;
}

interface SendJsonRpcErrorArgs {
  child: ChildProcess;
  code?: number;
  id: string | number;
  message: string;
}

interface SendProviderRequestDecodeErrorArgs {
  child: ChildProcess;
  error: unknown;
  id: string | number;
}

export function isJsonRpcId(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

export function sendJsonRpc(
  child: ChildProcess,
  message: JsonRpcMessage,
): void {
  const line = JSON.stringify(message);
  child.stdin?.write(line + "\n");
}

export function sendJsonRpcRequest<TResult>(
  args: SendJsonRpcRequestArgs<TResult>,
): Promise<TResult> {
  const id = args.getNextId();
  const withId: JsonRpcMessage = { ...args.message, id };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      args.pending.delete(id);
      reject(new Error(`JSON-RPC request timed out: ${args.message.method}`));
    }, args.timeoutMs ?? 30_000);
    args.pending.set(id, {
      resolve: (result) => {
        clearTimeout(timer);
        const parsedResult = args.resultSchema.safeParse(result);
        if (!parsedResult.success) {
          reject(new Error(`Invalid JSON-RPC result for ${args.message.method}`));
          return;
        }
        resolve(parsedResult.data);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    sendJsonRpc(args.child, withId);
  });
}

export function sendJsonRpcResult(args: SendJsonRpcResultArgs): void {
  args.child.stdin?.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: args.id,
      result: args.result,
    }) + "\n",
  );
}

export function sendJsonRpcError(args: SendJsonRpcErrorArgs): void {
  args.child.stdin?.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: args.id,
      error: {
        code: args.code ?? -32000,
        message: args.message,
      },
    }) + "\n",
  );
}

export function sendProviderRequestDecodeErrorIfKnown(
  args: SendProviderRequestDecodeErrorArgs,
): boolean {
  if (!(args.error instanceof ProviderRequestDecodeError)) {
    return false;
  }

  sendJsonRpcError({
    child: args.child,
    id: args.id,
    message: args.error.message,
    code: args.error.code,
  });
  return true;
}
