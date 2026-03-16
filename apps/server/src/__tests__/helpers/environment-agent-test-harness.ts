import { EventEmitter, Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  ENVIRONMENT_AGENT_PROTOCOL_VERSION,
  type EnvironmentAgentCommand,
  type EnvironmentAgentClient,
} from "@bb/environment-daemon";
import { assertNever, toRecord } from "@bb/core";
import { vi } from "vitest";

export const CODEX_THREAD_ID = "codex-thread-abc-123";

export interface ParsedRpcMessage {
  jsonrpc?: string;
  method?: string;
  id?: number;
  params: Record<string, unknown>;
}

export type FakeChildProcess = Omit<
  ChildProcess,
  "pid" | "exitCode" | "stdin" | "stdout" | "stderr"
> & {
  pid: number;
  exitCode: number | null;
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  _stdinData: string[];
  _pushStdout: (line: string) => void;
  _pushStderr: (line: string) => void;
  _emitExit: (code: number | null, signal: string | null) => void;
};

type EnvironmentAgentProviderEnsureCommand = Extract<
  EnvironmentAgentCommand,
  { type: "provider.ensure" }
>;
type EnvironmentAgentRpcCommand = Exclude<
  EnvironmentAgentCommand,
  EnvironmentAgentProviderEnsureCommand
>;

function toProviderMethod(command: EnvironmentAgentRpcCommand): string {
  switch (command.type) {
    case "thread.start":
      return "thread/start";
    case "thread.resume":
      return "thread/resume";
    case "thread.stop":
      return "thread/stop";
    case "turn.start":
      return "turn/start";
    case "turn.steer":
      return "turn/steer";
    case "thread.rename":
      return "thread/name/set";
    case "workspace.status":
      return "workspace/status";
    case "workspace.diff":
      return "workspace/diff";
  }

  return assertNever(command);
}

function toProviderParams(command: EnvironmentAgentRpcCommand): unknown {
  switch (command.type) {
    case "thread.start":
    case "thread.resume":
    case "turn.start":
    case "turn.steer":
    case "thread.rename":
      return command.params;
    case "thread.stop":
      return command.params ?? {};
    case "workspace.status":
    case "workspace.diff":
      return { threadId: command.threadId };
  }

  return assertNever(command);
}

export function respondToEnvironmentAgentControlMessage(
  child: Pick<FakeChildProcess, "stdout">,
  msg: {
    environmentAgentMessage?: boolean;
    requestId?: string;
    type?: string;
    payload?: {
      afterSequence?: number;
      sequence?: number;
      threadId?: string;
    };
  },
): boolean {
  if (msg.environmentAgentMessage !== true || !msg.requestId) {
    return false;
  }

  switch (msg.type) {
    case "provider.ensure":
      process.nextTick(() => {
        child.stdout.push(
          JSON.stringify({
            environmentAgentMessage: true,
            requestId: msg.requestId,
            type: "provider.ensure.response",
            payload: {
              running: true,
              launched: true,
              pid: 12345,
            },
          }) + "\n",
        );
      });
      return true;
    case "status":
      process.nextTick(() => {
        child.stdout.push(
          JSON.stringify({
            environmentAgentMessage: true,
            requestId: msg.requestId,
            type: "status.response",
            payload: {
              protocolVersion: 1,
              latestSequence: 0,
              connectedToDaemon: true,
              pendingEventCount: 0,
              pendingCommandCount: 0,
              deliveryState: "healthy",
              retryAttemptCount: 0,
            },
          }) + "\n",
        );
      });
      return true;
    default:
      return false;
  }
}

export function respondToProviderRpcMessage(
  child: Pick<FakeChildProcess, "stdout">,
  msg: {
    id?: number;
    method?: string;
  },
  opts?: {
    threadId?: string;
    model?: string;
  },
): boolean {
  if (!msg.id) {
    return false;
  }

  switch (msg.method) {
    case "initialize":
      process.nextTick(() => {
        child.stdout.push(
          JSON.stringify({
            id: msg.id,
            result: {
              capabilities: {},
            },
          }) + "\n",
        );
      });
      return true;
    case "thread/start":
    case "thread/resume":
      process.nextTick(() => {
        child.stdout.push(
          JSON.stringify({
            id: msg.id,
            result: {
              thread: { id: opts?.threadId ?? CODEX_THREAD_ID },
              model: opts?.model ?? "test-model",
            },
          }) + "\n",
        );
      });
      return true;
    case "turn/start":
    case "turn/steer":
    case "thread/stop":
    case "thread/name/set":
      process.nextTick(() => {
        child.stdout.push(
          JSON.stringify({
            id: msg.id,
            result: {},
          }) + "\n",
        );
      });
      return true;
    default:
      return false;
  }
}

export function parseRpcMessage(raw: string): ParsedRpcMessage {
  const parsed = toRecord(JSON.parse(raw.trim()));
  if (!parsed) {
    return { params: {} };
  }
  return {
    jsonrpc: typeof parsed.jsonrpc === "string" ? parsed.jsonrpc : undefined,
    method: typeof parsed.method === "string" ? parsed.method : undefined,
    id: typeof parsed.id === "number" ? parsed.id : undefined,
    params: toRecord(parsed.params) ?? {},
  };
}

export function findRpcMessageByMethod(
  rawMessages: string[],
  method: string,
): ParsedRpcMessage {
  const message = rawMessages
    .map((entry) => parseRpcMessage(entry))
    .find((entry) => entry.method === method);
  if (!message) {
    throw new Error(`Expected ${method} message in fake child stdin`);
  }
  return message;
}

export function createFakeChildProcess(opts?: {
  autoRespond?: boolean;
}): FakeChildProcess {
  const autoRespond = opts?.autoRespond ?? true;
  const child = new EventEmitter() as unknown as FakeChildProcess;
  const stdinData: string[] = [];

  child.stdin = new Writable({
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      const data = chunk.toString();
      try {
        const msg = JSON.parse(data.trim());
        if (respondToEnvironmentAgentControlMessage(child, msg)) {
          callback();
          return;
        }

        stdinData.push(data);

        if (autoRespond && respondToProviderRpcMessage(child, msg)) {
          callback();
          return;
        }
      } catch {
        stdinData.push(data);
      }

      callback();
    },
  });
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.pid = 12345;
  child.exitCode = null;
  child.kill = vi.fn();
  child._stdinData = stdinData;
  child._pushStdout = (line: string) => {
    child.stdout.push(line + "\n");
  };
  child._pushStderr = (line: string) => {
    child.stderr.push(line + "\n");
  };
  child._emitExit = (code: number | null, signal: string | null) => {
    child.exitCode = code;
    child.emit("exit", code, signal);
  };

  return child;
}

export function createFakeEnvironmentAgentClient(
  child: FakeChildProcess,
): EnvironmentAgentClient & {
  __fakeChild: FakeChildProcess;
  __ensureSpecs: Array<{
    command: string;
    args: string[];
    launchCommand?: string;
    launchArgs?: string[];
  }>;
} {
  let handlers:
    | {
        onLine: (line: string) => void;
        onStderrLine?: (line: string) => void;
        onClose?: (reason?: Error) => void;
      }
    | undefined;
  let replayThreadId = "thread-1";
  let initialized = false;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string | Buffer) => {
    const value = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const line of value.split(/\r\n|\n|\r/g)) {
      if (!line.trim()) continue;
      handlers?.onLine(line);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string | Buffer) => {
    const value = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const line of value.split(/\r\n|\n|\r/g)) {
      if (!line.trim()) continue;
      handlers?.onStderrLine?.(line);
    }
  });
  child.on("exit", (code: number | null, signal: string | null) => {
    handlers?.onClose?.(
      new Error(`Process exited (${signal ?? code ?? "unknown"})`),
    );
  });
  child.on("error", (error: Error) => {
    handlers?.onClose?.(error instanceof Error ? error : new Error(String(error)));
  });

  const existingEnsureSpecs = (
    child as FakeChildProcess & {
      __ensureSpecs?: Array<{
        command: string;
        args: string[];
        launchCommand?: string;
        launchArgs?: string[];
      }>;
    }
  ).__ensureSpecs;
  const ensureSpecs =
    existingEnsureSpecs ??
    ([] as Array<{
      command: string;
      args: string[];
      launchCommand?: string;
      launchArgs?: string[];
    }>);
  (child as FakeChildProcess & { __ensureSpecs?: typeof ensureSpecs }).__ensureSpecs = ensureSpecs;

  let rpcId = 0;
  const sendRpcRequest = (method: string, params: unknown): Promise<unknown> => {
    const id = ++rpcId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.stdout.off("data", onData);
        reject(new Error(`RPC timeout waiting for ${method}`));
      }, 10_000);
      const onData = (chunk: string | Buffer) => {
        const value = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        for (const line of value.split(/\r\n|\n|\r/g)) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as {
              id?: unknown;
              result?: unknown;
              error?: unknown;
            };
            if (parsed.id !== id) continue;
            clearTimeout(timeout);
            child.stdout.off("data", onData);
            if (parsed.error !== undefined) {
              reject(new Error(JSON.stringify(parsed.error)));
              return;
            }
            resolve(parsed.result);
            return;
          } catch {
            continue;
          }
        }
      };
      child.stdout.on("data", onData);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  };

  return {
    __fakeChild: child,
    __ensureSpecs: ensureSpecs,
    providerTransport: {
      setHandlers(nextHandlers) {
        handlers = nextHandlers;
      },
      send(line) {
        child.stdin.write(`${line}\n`);
      },
      close(reason) {
        handlers?.onClose?.(reason);
      },
    },
    ensureProviderRunning: async (spec) => {
      ensureSpecs.push({
        command: spec.command,
        args: [...spec.args],
        ...(spec.launchCommand ? { launchCommand: spec.launchCommand } : {}),
        ...(spec.launchArgs ? { launchArgs: [...spec.launchArgs] } : {}),
      });
      return {
        running: true,
        launched: true,
        pid: child.pid,
      };
    },
    sendCommand: async (envelope) => {
      const command = envelope.command;
      if (command.type === "provider.ensure") {
        throw new Error("provider.ensure should be sent via ensureProviderRunning");
      }
      replayThreadId = command.threadId;
      const initialize =
        "initialize" in command ? command.initialize : undefined;
      if (initialize && !initialized) {
        await sendRpcRequest(initialize.method, initialize.params);
        initialized = true;
      }
      let result: unknown;
      try {
        result = await sendRpcRequest(
          toProviderMethod(command),
          toProviderParams(command),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const normalizedMessage = message.includes("no rollout found") || message.includes("missing thread")
          ? "missing provider thread"
          : message;
        return {
          protocolVersion: 1,
          commandId: envelope.meta.commandId,
          idempotencyKey: envelope.meta.idempotencyKey,
          state: "rejected",
          acknowledgedAt: Date.now(),
          latestSequence: 0,
          message,
          errorCode:
            normalizedMessage === "missing provider thread"
              ? "missing_provider_thread"
              : "provider_rpc_error",
        };
      }
      return {
        protocolVersion: 1,
        commandId: envelope.meta.commandId,
        idempotencyKey: envelope.meta.idempotencyKey,
        state: "accepted",
        acknowledgedAt: Date.now(),
        latestSequence: 0,
        result,
      };
    },
    status: async () => ({
      protocolVersion: 1,
      latestSequence: 0,
      connectedToDaemon: true,
      pendingEventCount: 0,
      pendingCommandCount: 0,
      deliveryState: "healthy",
      retryAttemptCount: 0,
    }),
    close: vi.fn(),
  };
}
