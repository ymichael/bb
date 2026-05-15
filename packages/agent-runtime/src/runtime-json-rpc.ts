import type { ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import { z } from "zod";
import type { ProviderRequestCommandPlan } from "./provider-adapter.js";

export type JsonRpcObject = Record<string, unknown>;

export interface JsonRpcMessage extends JsonRpcObject {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: unknown;
}

export interface ProviderInboundRequest {
  id?: string | number;
  method: string;
  params?: unknown;
}

export type ProviderRuntimeEvent = JsonRpcObject;

export type JsonValue =
  | boolean
  | number
  | string
  | null
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

export const JSON_RPC_INVALID_PARAMS_CODE = -32602;

export class ProviderRequestDecodeError extends Error {
  readonly code = JSON_RPC_INVALID_PARAMS_CODE;

  constructor(message: string) {
    super(message);
    this.name = "ProviderRequestDecodeError";
  }
}

export class ProviderResponseEncodeError extends Error {
  readonly code = JSON_RPC_INVALID_PARAMS_CODE;

  constructor(message: string) {
    super(message);
    this.name = "ProviderResponseEncodeError";
  }
}

export interface PendingJsonRpcRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export const ignoredJsonRpcResultSchema = z.unknown();

export interface ParsedJsonRpcNonJsonLine {
  kind: "non_json";
}

export interface ParsedJsonRpcInvalidLine {
  kind: "invalid_json_rpc";
}

export interface ParsedJsonRpcResponseLine {
  kind: "response";
  parsed: JsonRpcObject;
  parsedId: string | number;
}

export interface ParsedJsonRpcRequestLine {
  kind: "request";
  parsedId: string | number;
  parsedMethod: string;
  rawRequest: JsonRpcMessage;
}

export interface ParsedJsonRpcNotificationLine {
  kind: "notification";
  notificationMethod: string;
  parsed: JsonRpcObject;
}

export type ParsedJsonRpcLine =
  | ParsedJsonRpcNonJsonLine
  | ParsedJsonRpcInvalidLine
  | ParsedJsonRpcResponseLine
  | ParsedJsonRpcRequestLine
  | ParsedJsonRpcNotificationLine;

export interface SendJsonRpcRequestArgs<TResult> {
  child: ChildProcess;
  getNextId: () => number;
  message: JsonRpcMessage | ProviderRequestCommandPlan;
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

interface SendProviderResponseEncodeErrorArgs {
  child: ChildProcess;
  error: unknown;
  id: string | number;
}

interface SettleJsonRpcResponseArgs {
  id: string | number;
  pending: Map<string | number, PendingJsonRpcRequest>;
  response: JsonRpcObject;
}

const closedJsonRpcStdinErrorCodes = new Set([
  "EPIPE",
  "ERR_STREAM_DESTROYED",
]);
const jsonRpcStdinErrorHandledStreams = new WeakSet<Writable>();

function isJsonRpcObject(value: unknown): value is JsonRpcObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

function formatJsonRpcErrorMessage(error: unknown): string {
  if (isJsonRpcObject(error) && typeof error.message === "string") {
    return error.message;
  }
  return JSON.stringify(error);
}

function isClosedJsonRpcStdinError(error: Error): boolean {
  return (
    "code" in error &&
    typeof error.code === "string" &&
    closedJsonRpcStdinErrorCodes.has(error.code)
  );
}

function handleJsonRpcStdinError(error: Error): void {
  if (isClosedJsonRpcStdinError(error)) {
    return;
  }
  throw error;
}

function ensureJsonRpcStdinErrorHandler(stdin: Writable): void {
  if (jsonRpcStdinErrorHandledStreams.has(stdin)) {
    return;
  }
  jsonRpcStdinErrorHandledStreams.add(stdin);
  stdin.on("error", handleJsonRpcStdinError);
}

function writeJsonRpcLine(child: ChildProcess, line: string): void {
  const stdin = child.stdin;
  if (!stdin || stdin.destroyed || !stdin.writable) {
    return;
  }
  ensureJsonRpcStdinErrorHandler(stdin);
  stdin.write(line + "\n");
}

export function parseJsonRpcLine(line: string): ParsedJsonRpcLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: "non_json" };
  }

  if (!isJsonRpcObject(parsed)) {
    return { kind: "invalid_json_rpc" };
  }

  const parsedId = parsed.id;
  const parsedMethod = parsed.method;
  if (isJsonRpcId(parsedId) && !parsedMethod) {
    return {
      kind: "response",
      parsed,
      parsedId,
    };
  }

  if (isJsonRpcId(parsedId) && typeof parsedMethod === "string") {
    const rawRequest: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: parsedId,
      method: parsedMethod,
      ...(Object.hasOwn(parsed, "params") ? { params: parsed.params } : {}),
    };
    return {
      kind: "request",
      parsedId,
      parsedMethod,
      rawRequest,
    };
  }

  if (typeof parsedMethod === "string") {
    return {
      kind: "notification",
      notificationMethod: parsedMethod,
      parsed,
    };
  }

  return { kind: "invalid_json_rpc" };
}

export function getJsonRpcStringParam(
  message: JsonRpcObject,
  key: string,
): string | undefined {
  if (!isJsonRpcObject(message.params)) {
    return undefined;
  }

  const value = message.params[key];
  return typeof value === "string" ? value : undefined;
}

export function settleJsonRpcResponse(args: SettleJsonRpcResponseArgs): void {
  const pending = args.pending.get(args.id);
  if (!pending) {
    return;
  }

  args.pending.delete(args.id);
  if (args.response.error) {
    pending.reject(new Error(formatJsonRpcErrorMessage(args.response.error)));
    return;
  }

  pending.resolve(args.response.result);
}

export function sendJsonRpc(
  child: ChildProcess,
  message: JsonRpcMessage | ProviderRequestCommandPlan,
): void {
  const line = JSON.stringify(toJsonRpcMessage(message));
  writeJsonRpcLine(child, line);
}

export function toJsonRpcMessage(
  message: JsonRpcMessage | ProviderRequestCommandPlan,
): JsonRpcMessage {
  if ("jsonrpc" in message) {
    return message;
  }
  return {
    jsonrpc: "2.0",
    method: message.method,
    ...(message.params !== undefined ? { params: message.params } : {}),
  };
}

export function sendJsonRpcRequest<TResult>(
  args: SendJsonRpcRequestArgs<TResult>,
): Promise<TResult> {
  const id = args.getNextId();
  const message = toJsonRpcMessage(args.message);
  const withId: JsonRpcMessage = { ...message, id };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      args.pending.delete(id);
      reject(new Error(`JSON-RPC request timed out: ${message.method}`));
    }, args.timeoutMs ?? 30_000);
    args.pending.set(id, {
      resolve: (result) => {
        clearTimeout(timer);
        const parsedResult = args.resultSchema.safeParse(result);
        if (!parsedResult.success) {
          reject(new Error(`Invalid JSON-RPC result for ${message.method}`));
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
  writeJsonRpcLine(
    args.child,
    JSON.stringify({
      jsonrpc: "2.0",
      id: args.id,
      result: args.result,
    }),
  );
}

export function sendJsonRpcError(args: SendJsonRpcErrorArgs): void {
  writeJsonRpcLine(
    args.child,
    JSON.stringify({
      jsonrpc: "2.0",
      id: args.id,
      error: {
        code: args.code ?? -32000,
        message: args.message,
      },
    }),
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

export function sendProviderResponseEncodeErrorIfKnown(
  args: SendProviderResponseEncodeErrorArgs,
): boolean {
  if (!(args.error instanceof ProviderResponseEncodeError)) {
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
