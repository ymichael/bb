import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostDaemonOnlineRpcCommand } from "@bb/host-daemon-contract";
import type { WatchPathRootArgs } from "@bb/host-watcher";
import { sanitizeInheritedChildProcessEnv } from "@bb/process-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginHostManager } from "./plugin-host-manager.js";

type PluginCall = Extract<
  HostDaemonOnlineRpcCommand,
  { type: "plugin.host.call" }
>;

const artifactSource = Buffer.from(`
const anySchema = { "~standard": { validate(value) { return { value }; } } };
const stringSchema = { "~standard": { validate(value) { return typeof value === "string" ? { value } : { issues: [{ message: "expected string" }] }; } } };
let lastPaths;
let retainedLease;
let hangOnDispose = false;
export default {
  experimental_apiVersion: 1,
  contract: {
    echo: { input: anySchema, output: anySchema },
    wait: { input: anySchema, output: anySchema },
    crash: { input: anySchema, output: anySchema },
    stringEcho: { input: stringSchema, output: stringSchema },
    invalidOutput: { input: anySchema, output: stringSchema },
    large: { input: anySchema, output: anySchema },
    pathsAndSignal: { input: anySchema, output: anySchema },
    watch: { input: anySchema, output: anySchema },
    retain: { input: anySchema, output: anySchema },
    hangDispose: { input: anySchema, output: anySchema },
  },
  experimental_signals: { changed: { payload: anySchema } },
  handlers: {
    echo(input) { return { input, pid: process.pid }; },
    wait(_input, context) {
      return new Promise((resolve) => {
        context.signal.addEventListener("abort", () => resolve({ aborted: true }), { once: true });
      });
    },
    crash() { process.exit(17); },
    stringEcho(input) { return input; },
    invalidOutput() { return { nope: true }; },
    large() { return "x".repeat(8 * 1024 * 1024); },
    async pathsAndSignal(_input, context) {
      lastPaths = context.experimental_paths;
      await context.experimental_emitSignal("changed", { reason: "test" });
      return context.experimental_paths;
    },
    async watch(input, context) {
      await context.experimental_watch(
        {
          rootPath: input.rootPath,
          ignoredPaths: [],
          debounceMs: 10,
          maxWaitMs: 100,
        },
        async (event) => {
          await context.experimental_emitSignal("changed", event);
          if (input.listenerDelayMs) {
            await new Promise((resolve) => setTimeout(resolve, input.listenerDelayMs));
          }
        },
      );
      return { watching: true };
    },
    async retain(input, context) {
      if (input.enabled) {
        retainedLease ??= context.experimental_retainWorker();
      } else {
        await retainedLease?.dispose();
        retainedLease = undefined;
      }
      return { retained: retainedLease !== undefined, pid: process.pid };
    },
    hangDispose() {
      hangOnDispose = true;
      return { enabled: true };
    },
  },
  async dispose() {
    if (hangOnDispose) await new Promise(() => {});
    await retainedLease?.dispose();
    retainedLease = undefined;
    if (lastPaths) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(lastPaths.dataDir + "/disposed", "yes");
    }
  },
};
`);

function callCommand(overrides: Partial<PluginCall> = {}): PluginCall {
  return {
    type: "plugin.host.call",
    pluginId: "fixture",
    generation: "generation-1",
    artifact: {
      digest: createHash("sha256").update(artifactSource).digest("hex"),
      byteLength: artifactSource.byteLength,
    },
    callId: randomUUID(),
    method: "echo",
    input: { value: "hello" },
    timeoutMs: 10_000,
    ...overrides,
  };
}

describe("PluginHostManager", () => {
  const tempDirs: string[] = [];
  const managers: PluginHostManager[] = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function createManager(
    overrides: Partial<ConstructorParameters<typeof PluginHostManager>[0]> = {},
  ): Promise<PluginHostManager> {
    return (await createManagerFixture(overrides)).manager;
  }

  async function createManagerFixture(
    overrides: Partial<ConstructorParameters<typeof PluginHostManager>[0]> = {},
  ): Promise<{ dataDir: string; manager: PluginHostManager }> {
    const dataDir = await mkdtemp(join(tmpdir(), "bb-plugin-host-test-"));
    tempDirs.push(dataDir);
    const manager = new PluginHostManager({
      dataDir,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      fetchArtifact: vi.fn(async () => artifactSource),
      ...overrides,
    });
    managers.push(manager);
    return { dataDir, manager };
  }

  it("verifies, caches, and reuses one worker for an artifact generation", async () => {
    const fetchArtifact = vi.fn(async () => artifactSource);
    const manager = await createManager({ fetchArtifact });

    const [first, second] = await Promise.all([
      manager.call(callCommand()),
      manager.call(callCommand()),
    ]);

    expect(first.output).toMatchObject({ input: { value: "hello" } });
    expect(Reflect.get(Object(first.output), "pid")).toBe(
      Reflect.get(Object(second.output), "pid"),
    );
    expect(fetchArtifact).toHaveBeenCalledOnce();
  });

  it("migrates a verified legacy host.js cache entry without downloading", async () => {
    const fetchArtifact = vi.fn(async () => artifactSource);
    const { dataDir, manager } = await createManagerFixture({ fetchArtifact });
    const command = callCommand();
    const digestDirectory = join(
      dataDir,
      "plugin-host-artifacts",
      command.pluginId,
      command.artifact.digest,
    );
    await mkdir(digestDirectory, { recursive: true });
    await writeFile(join(digestDirectory, "host.js"), artifactSource);

    const result = await manager.call(command);

    expect(result.output).toMatchObject({ input: { value: "hello" } });
    expect(fetchArtifact).not.toHaveBeenCalled();
    await expect(readdir(digestDirectory)).resolves.toEqual(["host.mjs"]);
    await expect(readFile(join(digestDirectory, "host.mjs"))).resolves.toEqual(
      artifactSource,
    );
  });

  it("logs artifact and worker lifecycle transitions", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const { dataDir, manager } = await createManagerFixture({ logger });
    await writeFile(join(dataDir, "package.json"), '{"private":true}\n');
    const command = callCommand();

    await manager.call(command);

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ digest: expect.any(String) }),
      "Downloading host artifact",
    );
    expect(logger.info).toHaveBeenCalledWith(
      {
        pluginId: "fixture",
        startupDurationMs: expect.any(Number),
      },
      "Host plugin worker ready",
    );

    await manager.dispose({
      type: "plugin.host.dispose",
      pluginId: command.pluginId,
      generation: command.generation,
    });

    expect(logger.info).toHaveBeenCalledWith(
      {
        pluginId: "fixture",
        reason: "plugin disposed",
        uptimeMs: expect.any(Number),
        exitCode: 0,
        signal: null,
        forceKilled: false,
      },
      "Host plugin worker stopped",
    );
    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("bounds call count and input bytes while worker startup is pending", async () => {
    let resolveCountFetch!: (bytes: Uint8Array) => void;
    const countFetch = vi.fn(
      () =>
        new Promise<Uint8Array>((resolve) => {
          resolveCountFetch = resolve;
        }),
    );
    const countManager = await createManager({
      fetchArtifact: countFetch,
      maxActiveCallsPerPlugin: 1,
    });
    const firstCountCall = countManager.call(callCommand({ timeoutMs: 20 }));
    const firstDeadline = expect(firstCountCall).rejects.toThrow(
      /deadline before dispatch/u,
    );
    await vi.waitFor(() => expect(countFetch).toHaveBeenCalledOnce());
    await firstDeadline;
    await expect(countManager.call(callCommand())).rejects.toThrow(
      /too many active calls/u,
    );
    resolveCountFetch(artifactSource);

    const input = { value: "1234567890" };
    const inputByteLength = Buffer.byteLength(JSON.stringify(input));
    let resolveByteFetch!: (bytes: Uint8Array) => void;
    const byteFetch = vi.fn(
      () =>
        new Promise<Uint8Array>((resolve) => {
          resolveByteFetch = resolve;
        }),
    );
    const byteManager = await createManager({
      fetchArtifact: byteFetch,
      maxActiveCallsPerPlugin: 2,
      maxActiveCallInputBytesPerPlugin: inputByteLength * 2 - 1,
    });
    const firstByteCall = byteManager.call(callCommand({ input }));
    await vi.waitFor(() => expect(byteFetch).toHaveBeenCalledOnce());
    await expect(byteManager.call(callCommand({ input }))).rejects.toThrow(
      /active call inputs exceed/u,
    );
    resolveByteFetch(artifactSource);
    await firstByteCall;
  });

  it("keeps only the active artifact digest in each plugin cache", async () => {
    const versionedArtifact = (index: number): Buffer =>
      Buffer.concat([artifactSource, Buffer.from(`\n// version ${index}\n`)]);
    const sources = [
      versionedArtifact(1),
      versionedArtifact(2),
      versionedArtifact(3),
    ] satisfies [Buffer, Buffer, Buffer];
    const sourceByDigest = new Map(
      sources.map((source) => [
        createHash("sha256").update(source).digest("hex"),
        source,
      ]),
    );
    const { dataDir, manager } = await createManagerFixture({
      fetchArtifact: vi.fn(async ({ digest }) => {
        const source = sourceByDigest.get(digest);
        if (source === undefined) throw new Error("unexpected artifact digest");
        return source;
      }),
    });

    for (const [index, source] of sources.entries()) {
      await manager.call(
        callCommand({
          generation: `generation-${index + 1}`,
          artifact: {
            digest: createHash("sha256").update(source).digest("hex"),
            byteLength: source.byteLength,
          },
        }),
      );
    }

    const latestDigest = createHash("sha256").update(sources[2]).digest("hex");
    await expect(
      readdir(join(dataDir, "plugin-host-artifacts", "fixture")),
    ).resolves.toEqual([latestDigest]);
  });

  it("evicts an idle worker and starts it again without reporting a crash", async () => {
    const onWorkerExit = vi.fn();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const manager = await createManager({
      logger,
      onWorkerExit,
      workerIdleTimeoutMs: 20,
    });
    const first = await manager.call(callCommand());
    const firstPid = Reflect.get(Object(first.output), "pid");

    await new Promise((resolve) => setTimeout(resolve, 100));
    const restarted = await manager.call(callCommand());

    expect(Reflect.get(Object(restarted.output), "pid")).not.toBe(firstPid);
    expect(onWorkerExit).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ digest: expect.any(String) }),
      "Using cached host artifact",
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "fixture",
        reason: "host plugin worker became idle",
        forceKilled: false,
      }),
      "Host plugin worker stopped",
    );
  });

  it("retains a worker with a lease until the lease is released", async () => {
    const manager = await createManager({ workerIdleTimeoutMs: 20 });
    const retained = await manager.call(
      callCommand({ method: "retain", input: { enabled: true } }),
    );
    const retainedPid = Reflect.get(Object(retained.output), "pid");

    await new Promise((resolve) => setTimeout(resolve, 100));
    const whileRetained = await manager.call(callCommand());
    expect(Reflect.get(Object(whileRetained.output), "pid")).toBe(retainedPid);

    await manager.call(
      callCommand({ method: "retain", input: { enabled: false } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const restarted = await manager.call(callCommand());
    expect(Reflect.get(Object(restarted.output), "pid")).not.toBe(retainedPid);
  });

  it("rejects unverified or invalid artifacts", async () => {
    const tampered = await createManager({
      fetchArtifact: async () => Buffer.from("tampered"),
    });
    await expect(tampered.call(callCommand())).rejects.toThrow(
      /failed verification after retry/u,
    );

    const invalidArtifact = Buffer.from("export default {};\n");
    const invalid = await createManager({
      fetchArtifact: async () => invalidArtifact,
    });
    await expect(
      invalid.call(
        callCommand({
          artifact: {
            digest: createHash("sha256").update(invalidArtifact).digest("hex"),
            byteLength: invalidArtifact.byteLength,
          },
        }),
      ),
    ).rejects.toThrow(/valid host entry/u);
  });

  it("enforces worker-side input, output, and result limits", async () => {
    const manager = await createManager();

    await expect(
      manager.call(callCommand({ method: "stringEcho", input: 42 })),
    ).rejects.toThrow(/expected string/u);
    await expect(
      manager.call(callCommand({ method: "invalidOutput" })),
    ).rejects.toThrow(/expected string/u);
    await expect(
      manager.call(callCommand({ method: "large" })),
    ).rejects.toThrow(/exceeds 8388608 bytes/u);
  });

  it("cancels running calls and enforces deadlines", async () => {
    const manager = await createManager();
    await manager.call(callCommand());
    const command = callCommand({ method: "wait" });
    const result = manager.call(command);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(
      manager.cancel({
        type: "plugin.host.cancel",
        pluginId: command.pluginId,
        generation: command.generation,
        callId: command.callId,
      }),
    ).toEqual({ cancelled: true });
    await expect(result).rejects.toMatchObject({ name: "AbortError" });

    await expect(
      manager.call(callCommand({ method: "wait", timeoutMs: 20 })),
    ).rejects.toThrow(/exceeded its deadline/u);
  });

  it.each([-4_000_000_000_000, 4_000_000_000_000])(
    "enforces relative timeouts with a wall-clock offset of %s",
    async (wallClockMs) => {
      const manager = await createManager();
      await manager.call(callCommand());
      const dateNow = vi.spyOn(Date, "now").mockReturnValue(wallClockMs);
      try {
        await expect(
          manager.call(callCommand({ method: "wait", timeoutMs: 20 })),
        ).rejects.toThrow(/exceeded its deadline/u);
      } finally {
        dateNow.mockRestore();
      }
    },
  );

  it("disposes deliberately without reporting a crash", async () => {
    const onWorkerExit = vi.fn();
    const manager = await createManager({ onWorkerExit });
    const command = callCommand();
    await manager.call(command);

    await expect(
      manager.dispose({
        type: "plugin.host.dispose",
        pluginId: command.pluginId,
        generation: command.generation,
      }),
    ).resolves.toEqual({ disposed: true });
    expect(onWorkerExit).not.toHaveBeenCalled();
  });

  it("logs when graceful disposal requires a forced kill", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const manager = await createManager({
      logger,
      workerStopGraceMs: 20,
    });
    const command = callCommand({ method: "hangDispose" });
    await manager.call(command);

    await manager.dispose({
      type: "plugin.host.dispose",
      pluginId: command.pluginId,
      generation: command.generation,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "fixture",
        reason: "plugin disposed",
      }),
      "Force-killing unresponsive host plugin worker",
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "fixture",
        forceKilled: true,
      }),
      "Host plugin worker stopped",
    );
  });

  it("forwards typed signals and owns persistent and generation-temp paths", async () => {
    const onSignal = vi.fn();
    const manager = await createManager({ onSignal });
    const command = callCommand({ method: "pathsAndSignal" });
    const result = await manager.call(command);
    const paths = result.output as { dataDir: string; tempDir: string };

    await vi.waitFor(() => expect(onSignal).toHaveBeenCalledOnce());
    expect(onSignal).toHaveBeenCalledWith({
      pluginId: "fixture",
      generation: "generation-1",
      signal: "changed",
      payload: { reason: "test" },
    });
    await manager.dispose({
      type: "plugin.host.dispose",
      pluginId: command.pluginId,
      generation: command.generation,
    });
    await expect(
      readFile(join(paths.dataDir, "disposed"), "utf8"),
    ).resolves.toBe("yes");
    await expect(stat(paths.tempDir)).rejects.toThrow();
  });

  it("backpressures native watch delivery and disposes watches with the worker", async () => {
    const onSignal = vi.fn();
    const stop = vi.fn(async () => undefined);
    let watcher: WatchPathRootArgs | undefined;
    const manager = await createManager({
      onSignal,
      workerIdleTimeoutMs: 20,
      hostWatcher: {
        watchPathRoot(args) {
          watcher = args;
          return stop;
        },
      },
    });
    const command = callCommand({
      method: "watch",
      input: { rootPath: "/tmp/workspace", listenerDelayMs: 100 },
    });
    const call = manager.call(command);
    await vi.waitFor(() => expect(watcher).toBeDefined(), { timeout: 5_000 });
    watcher?.onReady();
    await expect(call).resolves.toEqual({ output: { watching: true } });
    await new Promise((resolve) => setTimeout(resolve, 100));

    watcher?.onChange([{ path: "/tmp/workspace/a", type: "update" }]);
    await vi.waitFor(() => expect(onSignal).toHaveBeenCalledTimes(1));
    watcher?.onChange([
      { path: "/tmp/workspace/b", type: "create" },
      { path: "/tmp/workspace/c", type: "delete" },
    ]);
    await vi.waitFor(() => expect(onSignal).toHaveBeenCalledTimes(2));
    expect(onSignal.mock.calls[1]?.[0]).toMatchObject({
      payload: {
        kind: "changed",
        changes: [
          { path: "/tmp/workspace/b", type: "create" },
          { path: "/tmp/workspace/c", type: "delete" },
        ],
      },
    });

    await manager.dispose({
      type: "plugin.host.dispose",
      pluginId: command.pluginId,
      generation: command.generation,
    });
    expect(stop).toHaveBeenCalledOnce();
  });

  it("recovers after a crash and retires stale generations", async () => {
    const onWorkerExit = vi.fn();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const manager = await createManager({ logger, onWorkerExit });
    const first = await manager.call(callCommand());
    const firstPid = Reflect.get(Object(first.output), "pid");

    await expect(
      manager.call(callCommand({ method: "crash" })),
    ).rejects.toThrow(/worker exited/u);
    expect(onWorkerExit).toHaveBeenCalledWith({
      pluginId: "fixture",
      generation: "generation-1",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "fixture",
        generation: "generation-1",
        ready: true,
        exitCode: 17,
        reason: expect.stringContaining("worker exited"),
      }),
      "Host plugin worker exited unexpectedly",
    );
    const restarted = await manager.call(callCommand());
    expect(Reflect.get(Object(restarted.output), "pid")).not.toBe(firstPid);

    await manager.reconcileGenerations([]);
    await expect(manager.call(callCommand())).rejects.toThrow(/is retired/u);
    await expect(
      manager.call(callCommand({ generation: "generation-2" })),
    ).resolves.toMatchObject({ output: { input: { value: "hello" } } });
  });

  it("rejects a changed digest within one generation", async () => {
    const manager = await createManager();
    await manager.call(callCommand());

    await expect(
      manager.call(
        callCommand({
          artifact: { digest: "a".repeat(64), byteLength: 123 },
        }),
      ),
    ).rejects.toThrow(/changed artifact digest/u);
  });
});

describe("host plugin worker env", () => {
  it("uses the login-shell PATH without forwarding daemon BB variables", () => {
    expect(
      sanitizeInheritedChildProcessEnv({
        env: {
          HOME: "/Users/test",
          PATH: "/usr/bin",
          GH_TOKEN: "user-token",
          BB_CONNECT_MACHINE_CREDENTIAL: "daemon-secret",
          BB_SERVER_URL: "http://daemon.internal",
        },
        shellPath: "/Users/test/bin:/usr/bin",
      }),
    ).toEqual({
      HOME: "/Users/test",
      PATH: "/Users/test/bin:/usr/bin",
      GH_TOKEN: "user-token",
    });
  });
});
