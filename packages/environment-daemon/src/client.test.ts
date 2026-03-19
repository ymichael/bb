import { describe, expect, it, vi } from "vitest";
import {
  ENVIRONMENT_DAEMON_PROTOCOL_VERSION,
  type EnvironmentDaemonControlRequest,
  type JsonLineTransport,
  createEnvironmentDaemonClient,
} from "./index.js";

function createFakeTransport(): JsonLineTransport & {
  emittedLines: string[];
  emitStdout: (line: string) => void;
  emitStderr: (line: string) => void;
  emitClose: (reason?: Error) => void;
} {
  let handlers:
    | {
        onLine: (line: string) => void;
        onStderrLine?: (line: string) => void;
        onClose?: (reason?: Error) => void;
      }
    | undefined;
  return {
    emittedLines: [],
    setHandlers(nextHandlers) {
      handlers = nextHandlers;
    },
    send(line) {
      this.emittedLines.push(line);
    },
    close(reason) {
      handlers?.onClose?.(reason);
    },
    emitStdout(line) {
      handlers?.onLine(line);
    },
    emitStderr(line) {
      handlers?.onStderrLine?.(line);
    },
    emitClose(reason) {
      handlers?.onClose?.(reason);
    },
  };
}

describe("EnvironmentDaemonClient", () => {
  it("routes control responses away from provider transport", async () => {
    const transport = createFakeTransport();
    const client = createEnvironmentDaemonClient(transport);
    const providerLineSpy = vi.fn();
    client.providerTransport.setHandlers({
      onLine: providerLineSpy,
    });

    const statusPromise = client.status();
    const request = JSON.parse(transport.emittedLines[0] ?? "") as EnvironmentDaemonControlRequest;
    transport.emitStdout(
      JSON.stringify({
        environmentDaemonMessage: true,
        requestId: request.requestId,
        type: "status.response",
        payload: {
          protocolVersion: ENVIRONMENT_DAEMON_PROTOCOL_VERSION,
          latestSequence: 2,
          connectedToServer: true,
          pendingEventCount: 0,
          pendingCommandCount: 0,
        },
      }),
    );

    await expect(statusPromise).resolves.toMatchObject({
      latestSequence: 2,
      connectedToServer: true,
    });
    expect(providerLineSpy).not.toHaveBeenCalled();
  });

  it("sends provider ensure requests through the control plane", async () => {
    const transport = createFakeTransport();
    const client = createEnvironmentDaemonClient(transport);

    const ensurePromise = client.ensureProviderRunning({
      command: "codex",
      args: ["app-server"],
    });
    const request = JSON.parse(transport.emittedLines[0] ?? "") as EnvironmentDaemonControlRequest;
    transport.emitStdout(
      JSON.stringify({
        environmentDaemonMessage: true,
        requestId: request.requestId,
        type: "provider.ensure.response",
        payload: {
          running: true,
          launched: true,
          pid: 1234,
        },
      }),
    );

    await expect(ensurePromise).resolves.toEqual({
      running: true,
      launched: true,
      pid: 1234,
    });
  });

  it("forwards provider lines to the provider transport", () => {
    const transport = createFakeTransport();
    const client = createEnvironmentDaemonClient(transport);
    const providerLineSpy = vi.fn();
    client.providerTransport.setHandlers({
      onLine: providerLineSpy,
    });

    transport.emitStdout('{"jsonrpc":"2.0","method":"turn/started","params":{}}');

    expect(providerLineSpy).toHaveBeenCalledWith(
      '{"jsonrpc":"2.0","method":"turn/started","params":{}}',
    );
  });

});
