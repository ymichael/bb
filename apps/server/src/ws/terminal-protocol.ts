import {
  terminalClientMessageSchema,
  terminalServerMessageSchema,
} from "@bb/server-contract";
import { ApiError } from "../errors.js";
import type { ServerAppDeps } from "../types.js";
import { decodeSocketPayload } from "./decode-payload.js";

type TerminalProtocolDeps = Pick<ServerAppDeps, "terminalSessions">;

interface TerminalSocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

interface TerminalSocketOpenArgs {
  socket: TerminalSocket;
  terminalId: string;
  threadId: string;
}

interface TerminalSocketMessageArgs {
  raw: unknown;
  socket: TerminalSocket;
  terminalId: string;
  threadId: string;
}

interface TerminalSocketCloseArgs {
  socket: TerminalSocket;
  terminalId: string;
}

interface TerminalSocketErrorArgs {
  code: string;
  message: string;
  socket: TerminalSocket;
}

function sendTerminalSocketError(args: TerminalSocketErrorArgs): void {
  const payload = terminalServerMessageSchema.parse({
    type: "error",
    code: args.code,
    message: args.message,
  });
  args.socket.send(JSON.stringify(payload));
}

function closeTerminalSocketWithError(args: TerminalSocketErrorArgs): void {
  sendTerminalSocketError(args);
  args.socket.close(1008, args.code);
}

export function onTerminalSocketOpen(
  deps: TerminalProtocolDeps,
  args: TerminalSocketOpenArgs,
): void {
  try {
    deps.terminalSessions.attachBrowserTerminal({
      socket: args.socket,
      terminalId: args.terminalId,
      threadId: args.threadId,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      closeTerminalSocketWithError({
        socket: args.socket,
        code: error.body.code,
        message: error.body.message,
      });
      return;
    }
    closeTerminalSocketWithError({
      socket: args.socket,
      code: "terminal_socket_error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function onTerminalSocketMessage(
  deps: TerminalProtocolDeps,
  args: TerminalSocketMessageArgs,
): void {
  let decoded: unknown;
  try {
    decoded = JSON.parse(decodeSocketPayload(args.raw));
  } catch {
    args.socket.close(1008, "invalid-message");
    return;
  }

  const result = terminalClientMessageSchema.safeParse(decoded);
  if (!result.success) {
    args.socket.close(1008, "invalid-message");
    return;
  }

  try {
    deps.terminalSessions.handleBrowserTerminalMessage({
      message: result.data,
      socket: args.socket,
      terminalId: args.terminalId,
      threadId: args.threadId,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      closeTerminalSocketWithError({
        socket: args.socket,
        code: error.body.code,
        message: error.body.message,
      });
      return;
    }
    closeTerminalSocketWithError({
      socket: args.socket,
      code: "terminal_socket_error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function onTerminalSocketClose(
  deps: TerminalProtocolDeps,
  args: TerminalSocketCloseArgs,
): void {
  deps.terminalSessions.detachBrowserTerminal({
    socket: args.socket,
    terminalId: args.terminalId,
  });
}
