import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BbAppStartContext,
  ManagedFullStackProcesses,
} from "../src/launcher.js";
import {
  startFullStackServerProcess,
  waitForProcessExit,
  waitForServerHealth,
} from "../src/launcher.js";

interface ListeningServer {
  close(): Promise<void>;
  port: number;
}

type RequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void;

async function listen(handler: RequestHandler): Promise<ListeningServer> {
  const server = createServer(handler);
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected the test server to have a TCP address");
  }
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      }),
  };
}

async function reserveFreePort(): Promise<number> {
  const server = await listen(() => {});
  await server.close();
  return server.port;
}

function answerHealth(response: ServerResponse, body: object): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const FAKE_SERVER_ENTRY_SOURCE = `
import { createServer } from "node:http";
const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true, launchId: process.env.BB_SERVER_LAUNCH_ID }));
});
server.on("error", () => process.exit(1));
setTimeout(() => {
  server.listen(Number(process.env.BB_SERVER_PORT), "127.0.0.1");
}, 300);
`;

function createStartContext(args: {
  serverEntry: string;
  serverPort: number;
}): BbAppStartContext {
  const dataDir = "/tmp/bb-app-health-test";
  return {
    appDistDir: `${dataDir}/app/dist`,
    appVersion: "0.0.0-test",
    configFile: `${dataDir}/config.json`,
    daemonBundleDir: `${dataDir}/host-daemon/dist`,
    daemonEntry: `${dataDir}/host-daemon/dist/daemon-bundle.mjs`,
    daemonLockDir: `${dataDir}/daemon.lock.lock`,
    daemonLockFile: `${dataDir}/daemon.lock`,
    daemonPort: args.serverPort + 1,
    dataDir,
    dbPath: `${dataDir}/bb.db`,
    envFile: `${dataDir}/env.json`,
    logDir: `${dataDir}/logs`,
    packageRoot: `${dataDir}/package`,
    serverEntry: args.serverEntry,
    serverPort: args.serverPort,
    serverUrl: `http://127.0.0.1:${args.serverPort}`,
  };
}

const silentOutputBuffer = {
  flush(): void {},
  handler(): void {},
};

describe("waitForServerHealth", () => {
  it("does not accept another server's /health while the child is still booting", async () => {
    let healthRequests = 0;
    const foreign = await listen((_request, response) => {
      healthRequests += 1;
      answerHealth(response, { ok: true });
    });
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => process.exit(1), 400)"],
      { stdio: "ignore" },
    );

    try {
      const outcome = await waitForServerHealth({
        childProcess: child,
        expectedLaunchId: "launch-expected",
        timeoutMs: 5_000,
        url: `http://127.0.0.1:${foreign.port}/health`,
      }).then(
        () => "healthy" as const,
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      );
      await waitForProcessExit(child);

      expect(child.exitCode).toBe(1);
      expect(healthRequests).toBeGreaterThan(0);
      expect(outcome).toBe(
        `Process exited before becoming healthy: another server is already answering at http://127.0.0.1:${foreign.port}/health`,
      );
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await foreign.close();
    }
  });

  it("keeps polling past foreign answers until the child echoes its launch id", async () => {
    let healthRequests = 0;
    const server = await listen((_request, response) => {
      healthRequests += 1;
      answerHealth(
        response,
        healthRequests < 3
          ? { ok: true }
          : { ok: true, launchId: "launch-expected" },
      );
    });

    try {
      await waitForServerHealth({
        childProcess: null,
        expectedLaunchId: "launch-expected",
        timeoutMs: 5_000,
        url: `http://127.0.0.1:${server.port}/health`,
      });
      expect(healthRequests).toBe(3);
    } finally {
      await server.close();
    }
  });

  it("times out when the responder never echoes the launch id", async () => {
    const server = await listen((_request, response) => {
      answerHealth(response, { ok: true, launchId: "launch-other" });
    });

    try {
      await expect(
        waitForServerHealth({
          childProcess: null,
          expectedLaunchId: "launch-expected",
          timeoutMs: 250,
          url: `http://127.0.0.1:${server.port}/health`,
        }),
      ).rejects.toThrow(
        `Timed out waiting for health at http://127.0.0.1:${server.port}/health: another server is already answering`,
      );
    } finally {
      await server.close();
    }
  });
});

describe("startFullStackServerProcess", () => {
  const scratchDirs: string[] = [];

  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  function writeFakeServerEntry(): string {
    const dir = mkdtempSync(join(tmpdir(), "bb-app-health-"));
    scratchDirs.push(dir);
    const entry = join(dir, "fake-server.mjs");
    writeFileSync(entry, FAKE_SERVER_ENTRY_SOURCE);
    return entry;
  }

  it("hands the child a launch id and accepts its /health once it listens", async () => {
    const serverPort = await reserveFreePort();
    const context = createStartContext({
      serverEntry: writeFakeServerEntry(),
      serverPort,
    });
    const processes: ManagedFullStackProcesses = {
      daemonRun: null,
      serverRun: null,
    };

    const serverRun = await startFullStackServerProcess({
      context,
      env: {
        BB_SERVER_PORT: String(context.serverPort),
        PATH: process.env.PATH,
      },
      outputBuffer: silentOutputBuffer,
      processes,
    });
    try {
      expect(processes.serverRun).toBe(serverRun);
      const health = await fetch(`${context.serverUrl}/health`).then(
        (response) => response.json(),
      );
      expect(health).toEqual({
        ok: true,
        launchId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      });
    } finally {
      await serverRun.terminate("SIGTERM");
    }
  });

  it("runs the server preflight before it starts a child", async () => {
    const serverPort = await reserveFreePort();
    const context = createStartContext({
      serverEntry: writeFakeServerEntry(),
      serverPort,
    });
    const processes: ManagedFullStackProcesses = {
      daemonRun: null,
      serverRun: null,
    };
    const preflightError = new Error("native module ABI mismatch");

    await expect(
      startFullStackServerProcess({
        beforeStart: () => {
          throw preflightError;
        },
        context,
        env: {
          BB_SERVER_PORT: String(context.serverPort),
          PATH: process.env.PATH,
        },
        outputBuffer: silentOutputBuffer,
        processes,
      }),
    ).rejects.toBe(preflightError);
    expect(processes.serverRun).toBeNull();
  });

  it("fails startup instead of adopting a server that already owns the port", async () => {
    const foreign = await listen((_request, response) => {
      answerHealth(response, { ok: true });
    });
    const context = createStartContext({
      serverEntry: writeFakeServerEntry(),
      serverPort: foreign.port,
    });
    const processes: ManagedFullStackProcesses = {
      daemonRun: null,
      serverRun: null,
    };

    try {
      await expect(
        startFullStackServerProcess({
          context,
          env: {
            BB_SERVER_PORT: String(context.serverPort),
            PATH: process.env.PATH,
          },
          outputBuffer: silentOutputBuffer,
          processes,
        }),
      ).rejects.toThrow(
        `Server failed to become healthy: Process exited before becoming healthy: another server is already answering at ${context.serverUrl}/health`,
      );
      expect(processes.serverRun).toBeNull();
    } finally {
      await foreign.close();
    }
  });
});
