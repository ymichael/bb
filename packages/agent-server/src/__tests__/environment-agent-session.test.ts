import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ENVIRONMENT_AGENT_PROTOCOL_VERSION } from "../../../environment-agent/src/index.js";
import { AgentServer } from "../agent-server.js";
import { createCodexProviderAdapter } from "../codex-provider-adapter.js";

type FakeChildProcess = Omit<ChildProcess, "stdout" | "stderr" | "stdin"> & {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  _emitExit: (code: number | null, signal: string | null) => void;
  _stdinLines: string[];
};

function createFakeChildProcess(): FakeChildProcess {
  const child = new EventEmitter() as unknown as FakeChildProcess;
  const stdinLines: string[] = [];

  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const line = chunk.toString().trim();
      stdinLines.push(line);
      if (!line) {
        callback();
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        callback();
        return;
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        callback();
        return;
      }

      const record = parsed as Record<string, unknown>;
      const requestId =
        typeof record.requestId === "string" ? record.requestId : undefined;

      if (record.environmentAgentMessage === true && requestId) {
        if (record.type === "status") {
          process.nextTick(() => {
            child.stdout.push(
              JSON.stringify({
                environmentAgentMessage: true,
                requestId,
                type: "status.response",
                payload: {
                  protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
                  threadId: "thread-1",
                  latestSequence: 3,
                  connectedToDaemon: true,
                  pendingEventCount: 2,
                  pendingCommandCount: 0,
                },
              }) + "\n",
            );
          });
        } else if (record.type === "replay") {
          process.nextTick(() => {
            child.stdout.push(
              JSON.stringify({
                environmentAgentMessage: true,
                requestId,
                type: "replay.response",
                payload: {
                  protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
                  fromSequenceExclusive: 1,
                  toSequenceInclusive: 3,
                  hasMore: false,
                  events: [
                    {
                      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
                      sequence: 2,
                      emittedAt: 1000,
                      threadId: "thread-1",
                      event: {
                        type: "environment.ready",
                        threadId: "thread-1",
                      },
                    },
                  ],
                },
              }) + "\n",
            );
          });
        } else if (record.type === "ack") {
          process.nextTick(() => {
            child.stdout.push(
              JSON.stringify({
                environmentAgentMessage: true,
                requestId,
                type: "ack.response",
                payload: {
                  protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
                  threadId: "thread-1",
                  acknowledgedSequence: 3,
                },
              }) + "\n",
            );
          });
        }
        callback();
        return;
      }

      if (record.jsonrpc === "2.0" && typeof record.id !== "undefined") {
        if (record.method === "thread/start") {
          process.nextTick(() => {
            child.stdout.push(
              JSON.stringify({
                environmentAgentMessage: true,
                type: "event.emitted",
                payload: {
                  protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
                  sequence: 1,
                  emittedAt: 999,
                  threadId: "thread-1",
                  event: {
                    type: "environment.ready",
                    threadId: "thread-1",
                  },
                },
              }) + "\n",
            );
          });
        }
        process.nextTick(() => {
          child.stdout.push(
            JSON.stringify({
              jsonrpc: "2.0",
              id: record.id,
              result:
                record.method === "thread/start"
                  ? { threadId: "provider-thread-1" }
                  : {},
            }) + "\n",
          );
        });
      }

      callback();
    },
  });

  Object.defineProperty(child, "pid", {
    value: 12345,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(child, "exitCode", {
    value: null,
    writable: true,
    configurable: true,
  });
  child.kill = vi.fn();
  child._stdinLines = stdinLines;
  child._emitExit = (code: number | null, signal: string | null) => {
    Object.defineProperty(child, "exitCode", {
      value: code,
      writable: true,
      configurable: true,
    });
    child.emit("exit", code, signal);
  };

  return child;
}

describe("AgentServer environment-agent control plane", () => {
  it("surfaces environment-agent status, replay, and ack through the session", async () => {
    const agentServer = new AgentServer({
      provider: createCodexProviderAdapter(),
    });
    const child = createFakeChildProcess();

    await agentServer.startSession({
      threadId: "thread-1",
      spawnProcess: () => child,
      request: {
        projectId: "project-1",
        title: "Test thread",
        input: [{ type: "text", text: "hello" }],
      },
      context: {
        projectId: "project-1",
        threadId: "thread-1",
        path: process.env.PATH ?? "",
      },
    });

    await expect(agentServer.getEnvironmentAgentStatus("thread-1")).resolves.toMatchObject({
      latestSequence: 3,
      pendingEventCount: 2,
    });

    await expect(
      agentServer.replayEnvironmentAgentEvents({
        threadId: "thread-1",
        afterSequence: 1,
      }),
    ).resolves.toMatchObject({
      fromSequenceExclusive: 1,
      toSequenceInclusive: 3,
      events: [
        expect.objectContaining({
          sequence: 2,
        }),
      ],
    });

    await expect(
      agentServer.acknowledgeEnvironmentAgent({
        threadId: "thread-1",
        sequence: 3,
      }),
    ).resolves.toMatchObject({
      acknowledgedSequence: 3,
      threadId: "thread-1",
    });

    expect(
      child._stdinLines.some((line) => line.includes('"type":"ack"') && line.includes('"sequence":1')),
    ).toBe(true);
  });
});
