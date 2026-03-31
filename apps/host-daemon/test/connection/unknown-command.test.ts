import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostDaemonLogger } from "../../src/logger.js";
import { createServerClient } from "../../src/server-client.js";
import {
  createTestServer,
  type TestServer,
} from "../helpers/test-server.js";

function createLogger(): HostDaemonLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("fetchCommands with unknown command types", () => {
  let testServer: TestServer | null = null;

  afterEach(async () => {
    await testServer?.close();
    testServer = null;
  });

  it("filters out unknown command types and reports errors for them", async () => {
    testServer = await createTestServer();
    const logger = createLogger();
    const sessionState = { value: "" };
    const serverClient = createServerClient({
      serverUrl: testServer.baseUrl,
      authToken: "secret",
      logger,
      getSessionId: () => sessionState.value,
    });

    // Open session first
    const session = await serverClient.openSession({
      hostId: "host-1",
      hostName: "Host One",
      hostType: "persistent",
      dataDir: "/tmp/daemon-data",
      instanceId: "instance-1",
      activeThreads: [],
    });
    sessionState.value = session.sessionId;

    // Queue a known command
    testServer.queueCommand({
      type: "thread.stop",
      environmentId: "env-1",
      threadId: "thread-1",
    });

    // Queue an unknown command type as raw JSON
    testServer.queueRawCommand({
      id: "command-unknown-1",
      cursor: 99,
      command: {
        type: "thread.quantum_teleport",
        environmentId: "env-1",
        threadId: "thread-2",
      },
    });

    const commands = await serverClient.fetchCommands({
      afterCursor: 0,
    });

    // Only the known command should be returned
    expect(commands).toHaveLength(1);
    expect(commands[0]!.command.type).toBe("thread.stop");

    // A warning should have been logged for the unknown command
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.quantum_teleport" }),
      "unknown command type in batch, reporting error to server",
    );

    // The unknown command should have been reported back as an error
    // (reports are now awaited before fetchCommands returns)
    const errorReport = testServer.commandResultReports.find(
      (r: any) => r.commandId === "command-unknown-1",
    );
    expect(errorReport).toBeDefined();
    expect((errorReport as any).ok).toBe(false);
    expect((errorReport as any).errorCode).toBe("unknown_command");
  });

  it("handles a batch with only unknown commands", async () => {
    testServer = await createTestServer();
    const logger = createLogger();
    const sessionState = { value: "" };
    const serverClient = createServerClient({
      serverUrl: testServer.baseUrl,
      authToken: "secret",
      logger,
      getSessionId: () => sessionState.value,
    });

    const session = await serverClient.openSession({
      hostId: "host-1",
      hostName: "Host One",
      hostType: "persistent",
      dataDir: "/tmp/daemon-data",
      instanceId: "instance-1",
      activeThreads: [],
    });
    sessionState.value = session.sessionId;

    testServer.queueRawCommand({
      id: "cmd-unk-1",
      cursor: 50,
      command: { type: "future.command" },
    });

    const commands = await serverClient.fetchCommands({ afterCursor: 0 });

    expect(commands).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalled();

    // Reports are now awaited before fetchCommands returns
    const errorReport = testServer.commandResultReports.find(
      (r: any) => r.commandId === "cmd-unk-1",
    );
    expect(errorReport).toBeDefined();
    expect((errorReport as any).ok).toBe(false);
    expect((errorReport as any).errorCode).toBe("unknown_command");
  });

  it("reports error for commands missing id", async () => {
    testServer = await createTestServer();
    const logger = createLogger();
    const sessionState = { value: "" };
    const serverClient = createServerClient({
      serverUrl: testServer.baseUrl,
      authToken: "secret",
      logger,
      getSessionId: () => sessionState.value,
    });

    const session = await serverClient.openSession({
      hostId: "host-1",
      hostName: "Host One",
      hostType: "persistent",
      dataDir: "/tmp/daemon-data",
      instanceId: "instance-1",
      activeThreads: [],
    });
    sessionState.value = session.sessionId;

    // Queue a raw command without id
    testServer.queueRawCommand({
      cursor: 77,
      command: { type: "future.missing_fields" },
    });

    const commands = await serverClient.fetchCommands({ afterCursor: 0 });

    expect(commands).toHaveLength(0);

    // Should warn about the unknown type AND about missing id
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const missingFieldsWarning = warnCalls.find(
      ([, msg]: any) => msg === "cannot report unknown command: missing id",
    );
    expect(missingFieldsWarning).toBeDefined();
  });
});
