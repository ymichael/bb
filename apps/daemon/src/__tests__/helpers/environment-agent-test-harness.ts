import { EventEmitter, Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { EnvironmentAgentClient } from "@beanbag/environment-agent";
import { toRecord } from "@beanbag/agent-core";
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
    case "replay":
      process.nextTick(() => {
        child.stdout.push(
          JSON.stringify({
            environmentAgentMessage: true,
            requestId: msg.requestId,
            type: "replay.response",
            payload: {
              protocolVersion: 1,
              fromSequenceExclusive: msg.payload?.afterSequence ?? 0,
              toSequenceInclusive: msg.payload?.afterSequence ?? 0,
              events: [],
              hasMore: false,
            },
          }) + "\n",
        );
      });
      return true;
    case "ack":
      process.nextTick(() => {
        child.stdout.push(
          JSON.stringify({
            environmentAgentMessage: true,
            requestId: msg.requestId,
            type: "ack.response",
            payload: {
              protocolVersion: 1,
              acknowledgedSequence: msg.payload?.sequence ?? 0,
              ...(msg.payload?.threadId ? { threadId: msg.payload.threadId } : {}),
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
            },
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

        if (autoRespond && msg.method === "thread/start" && msg.id) {
          process.nextTick(() => {
            child.stdout.push(
              JSON.stringify({
                id: msg.id,
                result: {
                  thread: { id: CODEX_THREAD_ID },
                  model: "test-model",
                },
              }) + "\n",
            );
          });
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

  const ensureSpecs: Array<{
    command: string;
    args: string[];
    launchCommand?: string;
    launchArgs?: string[];
  }> = [];

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
    retryDaemonDelivery: async () => ({
      protocolVersion: 1,
      latestSequence: 0,
      connectedToDaemon: true,
      pendingEventCount: 0,
      pendingCommandCount: 0,
    }),
    acknowledge: async (request) => ({
      protocolVersion: 1,
      acknowledgedSequence: request.sequence,
      ...(request.threadId ? { threadId: request.threadId } : {}),
    }),
    replay: async (request) => ({
      protocolVersion: 1,
      fromSequenceExclusive: request.afterSequence,
      toSequenceInclusive: request.afterSequence,
      events: [],
      hasMore: false,
    }),
    status: async () => ({
      protocolVersion: 1,
      latestSequence: 0,
      connectedToDaemon: true,
      pendingEventCount: 0,
      pendingCommandCount: 0,
    }),
    getLatestObservedSequence: () => 0,
    close: vi.fn(),
  };
}
