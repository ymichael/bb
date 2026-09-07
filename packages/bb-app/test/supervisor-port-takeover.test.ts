import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  superviseFullStackProcesses,
  terminateManagedFullStackProcesses,
} from "../src/launcher.js";
import type {
  BbAppStartContext,
  DelayMillisecondsArgs,
  FullStackSupervisionResult,
  ManagedFullStackProcesses,
  ManagedProcessName,
  ManagedProcessRun,
  NamedProcessExitResult,
  ProcessExitResult,
} from "../src/launcher.js";

type ResolveExit = (result: NamedProcessExitResult) => void;

class FakeManagedProcessRun implements ManagedProcessRun {
  readonly exit: Promise<NamedProcessExitResult>;
  readonly terminationSignals: NodeJS.Signals[] = [];
  private resolveExit: ResolveExit = () => undefined;

  constructor(readonly processName: ManagedProcessName) {
    this.exit = new Promise<NamedProcessExitResult>((resolvePromise) => {
      this.resolveExit = resolvePromise;
    });
  }

  exitWith(result: ProcessExitResult): void {
    this.resolveExit({ processName: this.processName, result });
  }

  async terminate(signal: NodeJS.Signals): Promise<void> {
    this.terminationSignals.push(signal);
    this.exitWith({ code: null, signal });
  }
}

function delay(ms: number): Promise<"timeout"> {
  return new Promise((resolvePromise) => {
    setTimeout(() => resolvePromise("timeout"), ms);
  });
}

describe("full-stack supervisor port takeover", () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      });
    }
  });

  it("stops its daemon when another healthy server owns the URL", async () => {
    const server = createServer(
      (_request: IncomingMessage, response: ServerResponse) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      },
    );
    servers.push(server);
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected the test server to have a TCP address");
    }

    const serverRun = new FakeManagedProcessRun("server");
    const daemonRun = new FakeManagedProcessRun("daemon");
    const processes: ManagedFullStackProcesses = { daemonRun, serverRun };
    let shutdownRequested = false;
    let restartAttempts = 0;
    let delayCalls = 0;
    let releaseRetry = (): void => undefined;
    const context: BbAppStartContext = {
      appDistDir: "/tmp/bb-app-test/app/dist",
      appVersion: "0.0.0-test",
      configFile: "/tmp/bb-app-test/config.json",
      daemonBundleDir: "/tmp/bb-app-test/host-daemon/dist",
      daemonEntry: "/tmp/bb-app-test/host-daemon/dist/daemon-bundle.mjs",
      daemonLockDir: "/tmp/bb-app-test/daemon.lock.lock",
      daemonLockFile: "/tmp/bb-app-test/daemon.lock",
      daemonPort: address.port + 1,
      dataDir: "/tmp/bb-app-test",
      dbPath: "/tmp/bb-app-test/bb.db",
      envFile: "/tmp/bb-app-test/env.json",
      logDir: "/tmp/bb-app-test/logs",
      packageRoot: "/tmp/bb-app-test/package",
      serverEntry: "/tmp/bb-app-test/server/dist/index.js",
      serverPort: address.port,
      serverUrl: `http://127.0.0.1:${String(address.port)}`,
    };
    const supervision = superviseFullStackProcesses({
      context,
      delayMilliseconds: async (_args: DelayMillisecondsArgs) => {
        delayCalls += 1;
        if (delayCalls === 1) return;
        await new Promise<void>((resolvePromise) => {
          releaseRetry = resolvePromise;
        });
      },
      isShutdownRequested: () => shutdownRequested,
      processes,
      startDaemon: async () => daemonRun,
      startServer: async () => {
        restartAttempts += 1;
        throw new Error("The server port is occupied");
      },
    });

    serverRun.exitWith({ code: 1, signal: null });
    const outcome = await Promise.race<FullStackSupervisionResult | "timeout">([
      supervision,
      delay(250),
    ]);
    const observedRestartAttempts = restartAttempts;
    const observedDaemonSignals = [...daemonRun.terminationSignals];

    shutdownRequested = true;
    releaseRetry();
    await terminateManagedFullStackProcesses({ processes, signal: "SIGTERM" });
    await supervision;

    expect(outcome).toBe("stopped");
    expect(observedRestartAttempts).toBe(0);
    expect(observedDaemonSignals).toEqual(["SIGTERM"]);
  });
});
