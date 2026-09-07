import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadEvent } from "@bb/domain";
import { createAgentRuntime } from "./runtime.js";
import { createProviderForId } from "./provider-registry.js";
import { RuntimeProviderProcessManager } from "./runtime-provider-process.js";
import { RuntimeThreadIdentityRegistry } from "./runtime-thread-identity.js";
import type { BridgeProtocolAdapter } from "./bridge-protocol-adapter.js";
import {
  parseJsonRpcLine,
  settleJsonRpcResponse,
} from "@bb/provider-bridge-protocol/bridge-kit";
import {
  createScriptedEchoLaunch,
  createScriptedEchoProcessLog,
  createScriptedEchoRequestRecord,
  createScriptedEchoRuntime,
  fullRuntimeOptions,
  scriptedEchoProcessEnv,
  waitForRuntimeState,
  waitForThreadAgentMessageText,
  waitForThreadTurnStarted,
  withBridgeLaunch,
  type ScriptedEchoLaunchScript,
} from "./test/runtime-test-harness.js";
import { promptTextInput } from "./test/prompt-input.js";
import type { AgentRuntimeBridgeLaunch, AgentRuntimeOptions } from "./types.js";

interface CreateProviderProcessManagerArgs {
  adapterProcessEnv?: Record<string, string>;
  createAdapter?: () => BridgeProtocolAdapter;
  env?: Record<string, string>;
  handleStdoutLine?: (line: string, childPid: number | undefined) => void;
  onStderr?: NonNullable<AgentRuntimeOptions["onStderr"]>;
  onProcessExit: NonNullable<AgentRuntimeOptions["onProcessExit"]>;
  rawScriptPath?: string;
  workspacePath: string;
}

const CODEX_SCRIPT: ScriptedEchoLaunchScript = {
  identifyProcess: true,
  sessionRestorable: true,
};

const MANAGER_BRIDGE_LAUNCH = createScriptedEchoLaunch();
const MANAGER_PROVIDER = {
  bridgeLaunch: MANAGER_BRIDGE_LAUNCH,
  processKey: "fake",
  providerId: "fake",
};

describe("createAgentRuntime process lifecycle", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bb-runtime-test-"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createManagerAdapter(
    args: Pick<
      CreateProviderProcessManagerArgs,
      "adapterProcessEnv" | "rawScriptPath"
    >,
  ): BridgeProtocolAdapter {
    const adapter = createProviderForId("fake", {
      additionalWorkspaceWriteRoots: [],
      bridgeLaunch: createScriptedEchoLaunch(),
    });
    const process =
      args.rawScriptPath === undefined
        ? adapter.process
        : { command: adapter.process.command, args: [args.rawScriptPath] };
    return {
      ...adapter,
      process: {
        ...process,
        ...(args.adapterProcessEnv !== undefined
          ? { env: args.adapterProcessEnv }
          : {}),
      },
    };
  }

  function createProviderProcessManager(
    args: CreateProviderProcessManagerArgs,
  ): RuntimeProviderProcessManager {
    const identityRegistry = new RuntimeThreadIdentityRegistry();
    let nextRequestId = 1;
    const adapter = createManagerAdapter(args);
    return new RuntimeProviderProcessManager({
      additionalWorkspaceWriteRoots: [],
      createAdapter: args.createAdapter ?? (() => adapter),
      bridgeBundleDir: undefined,
      bridgeNodeExecutablePath: process.execPath,
      captureThreadExitState: (threadId) => ({
        activeTurnId: null,
        pendingTurnStart: false,
        providerThreadId:
          identityRegistry.getProviderThreadId(threadId) ?? null,
        threadId,
      }),
      createProviderIdentityState: (providerId) =>
        identityRegistry.createProviderState({ providerId }),
      env: args.env,
      getNextRequestId: () => nextRequestId++,
      handleStdoutLine: ({ line, providerProcess }) => {
        args.handleStdoutLine?.(line, providerProcess.child.pid);
        const parsed = parseJsonRpcLine(line);
        if (parsed.kind === "response") {
          settleJsonRpcResponse({
            id: parsed.parsedId,
            pending: providerProcess.pending,
            response: parsed.parsed,
          });
        }
      },
      onProcessExit: args.onProcessExit,
      onProviderThreadDetached: (threadId) =>
        identityRegistry.clearThread(threadId),
      onStderr: args.onStderr,
      skillRoots: [],
      workspacePath: args.workspacePath,
    });
  }

  async function ensureCrashingProvider(
    manager: RuntimeProviderProcessManager,
  ): Promise<void> {
    await expect(
      manager.ensureProvider({
        bridgeLaunch: MANAGER_BRIDGE_LAUNCH,
        processKey: "fake",
        providerId: "fake",
      }),
    ).rejects.toThrow(/exited during startup|exited/i);
  }

  function startedPids(startsLog: string): number[] {
    return readLogLines(startsLog).map((line) => Number(line));
  }

  it("handles JSON-RPC error responses from provider", async () => {
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath: tmpDir,
        onEvent: () => {},
      },
      launch: { scripted: { unsupportedMethods: ["turn/start"] } },
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await expect(
      runtime.runTurn({
        clientRequestId: "creq_222222224w",
        threadId: "t1",
        input: [promptTextInput({ text: "hi" })],
        options: fullRuntimeOptions,
      }),
    ).rejects.toThrow("Method not found");
    await runtime.shutdown();
  });

  it("fires onProcessExit when provider crashes", async () => {
    const exitInfo = vi.fn();
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath: tmpDir,
        env: scriptedEchoProcessEnv({ exitAfter: "initialize" }),
        onEvent: () => {},
        onProcessExit: exitInfo,
      },
    });

    await runtime.ensureProvider({ providerId: "fake" });
    await waitForRuntimeState({
      label: "provider process exit callback",
      predicate: () => exitInfo.mock.calls.length === 1,
    });

    expect(exitInfo).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "fake", code: 0, expected: false }),
    );
    await runtime.shutdown();
  });

  it("retires a threadless bridge process superseded by a new artifact hash", async () => {
    const manager = createProviderProcessManager({
      onProcessExit: vi.fn(),
      workspacePath: tmpDir,
    });

    const staleKey = "fake#bridge:aaaaaaaaaaaaaaaa";
    const freshKey = "fake#bridge:bbbbbbbbbbbbbbbb";
    await manager.ensureProvider({
      bridgeLaunch: MANAGER_BRIDGE_LAUNCH,
      processKey: staleKey,
      providerId: "fake",
    });
    const staleProcess = manager.requireProviderProcess({
      processKey: staleKey,
      providerId: "fake",
    });

    await manager.ensureProvider({
      bridgeLaunch: MANAGER_BRIDGE_LAUNCH,
      processKey: freshKey,
      providerId: "fake",
    });

    expect(staleProcess.child.killed).toBe(true);
    expect(() =>
      manager.requireProviderProcess({
        processKey: staleKey,
        providerId: "fake",
      }),
    ).toThrow();
    expect(
      manager.requireProviderProcess({
        processKey: freshKey,
        providerId: "fake",
      }).child.killed,
    ).toBe(false);

    await manager.shutdown();
  });

  it("keeps an old-hash bridge process that still owns a thread", async () => {
    const manager = createProviderProcessManager({
      onProcessExit: vi.fn(),
      workspacePath: tmpDir,
    });

    const staleKey = "fake#bridge:aaaaaaaaaaaaaaaa";
    await manager.ensureProvider({
      bridgeLaunch: MANAGER_BRIDGE_LAUNCH,
      processKey: staleKey,
      providerId: "fake",
    });
    const staleProcess = manager.requireProviderProcess({
      processKey: staleKey,
      providerId: "fake",
    });
    staleProcess.identity.threadIds.add("thread-live");

    await manager.ensureProvider({
      bridgeLaunch: MANAGER_BRIDGE_LAUNCH,
      processKey: "fake#bridge:bbbbbbbbbbbbbbbb",
      providerId: "fake",
    });

    expect(staleProcess.child.killed).toBe(false);
    expect(
      manager.requireProviderProcess({
        processKey: staleKey,
        providerId: "fake",
      }),
    ).toBe(staleProcess);

    await manager.shutdown();
  });

  it("waits for provider retirement before starting a same-key replacement", async () => {
    const manager = createProviderProcessManager({
      onProcessExit: vi.fn(),
      workspacePath: tmpDir,
    });
    await manager.ensureProvider(MANAGER_PROVIDER);
    const retiringProcess = manager.requireProviderProcess(MANAGER_PROVIDER);
    await Promise.all([
      manager.shutdownProvider(MANAGER_PROVIDER),
      manager.ensureProvider(MANAGER_PROVIDER),
    ]);

    expect(manager.requireProviderProcess(MANAGER_PROVIDER)).not.toBe(
      retiringProcess,
    );
    await manager.shutdown();
  });

  it("does not wait for stalled replacement initialization during full shutdown", async () => {
    const stalledBridge = join(tmpDir, "stalled-provider.cjs");
    const stalledBridgeStarted = join(tmpDir, "stalled-provider-started");
    writeFileSync(
      stalledBridge,
      `require("readline").createInterface({input:process.stdin}).once("line",line=>{require("fs").writeFileSync(${JSON.stringify(stalledBridgeStarted)},"");setTimeout(()=>console.log(JSON.stringify({jsonrpc:"2.0",id:JSON.parse(line).id,result:{protocolVersion:2,capabilities:{grammarVersions:[3,3]}}})),3000)});`,
    );
    let starts = 0;
    const manager = createProviderProcessManager({
      createAdapter: () =>
        createManagerAdapter(
          starts++ === 0 ? {} : { rawScriptPath: stalledBridge },
        ),
      onProcessExit: vi.fn(),
      workspacePath: tmpDir,
    });
    await manager.ensureProvider(MANAGER_PROVIDER);
    const retirement = manager.shutdownProvider(MANAGER_PROVIDER);
    const replacementStart = manager.ensureProvider(MANAGER_PROVIDER);
    await waitForRuntimeState({
      label: "the replacement bridge to begin initialization",
      predicate: () => existsSync(stalledBridgeStarted),
      timeoutMs: 1_000,
    });
    expect(starts).toBe(2);
    const replacementProcess = manager.requireProviderProcess(MANAGER_PROVIDER);
    const fullShutdown = manager.shutdown();
    const operations = Promise.all([
      retirement,
      replacementStart,
      fullShutdown,
    ]);
    let completionTimer: ReturnType<typeof setTimeout> | undefined;
    const completedPromptly = await Promise.race([
      operations.then(() => true),
      new Promise<false>((resolve) => {
        completionTimer = setTimeout(() => resolve(false), 1_000);
        completionTimer.unref();
      }),
    ]);
    if (completionTimer !== undefined) clearTimeout(completionTimer);
    await expect(operations).resolves.toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(completedPromptly).toBe(true);
    expect(replacementProcess.child.killed).toBe(true);
    await manager.ensureProvider(MANAGER_PROVIDER);
    expect(manager.listRunningProviders()).toEqual([]);
  });

  it("bounds provider stderr while data arrives without a newline", async () => {
    const exitInfo = vi.fn<NonNullable<AgentRuntimeOptions["onProcessExit"]>>();
    const stderrLines: string[] = [];
    const crashScript = join(tmpDir, "large-stderr-provider.cjs");
    writeFileSync(
      crashScript,
      `process.exitCode = 42;
      process.stderr.write("a".repeat(100_000) + "stderr-tail");`,
    );
    const manager = createProviderProcessManager({
      onProcessExit: exitInfo,
      onStderr: (line) => stderrLines.push(line),
      rawScriptPath: crashScript,
      workspacePath: tmpDir,
    });

    await ensureCrashingProvider(manager);
    await waitForRuntimeState({
      label: "bounded provider stderr exit callback",
      predicate: () => exitInfo.mock.calls.length === 1,
    });

    const stderr = exitInfo.mock.calls[0]?.[0].stderr;
    expect(Buffer.byteLength(stderr ?? "", "utf8")).toBeLessThanOrEqual(4_000);
    expect(stderr?.endsWith("stderr-tail")).toBe(true);
    expect(stderrLines).toHaveLength(1);
    expect(Buffer.byteLength(stderrLines[0] ?? "", "utf8")).toBeLessThanOrEqual(
      4_000,
    );
    await manager.shutdown();
  });

  it("drains provider stderr before reporting process exit", async () => {
    const exitInfo = vi.fn<NonNullable<AgentRuntimeOptions["onProcessExit"]>>();
    const crashScript = join(tmpDir, "delayed-stderr-provider.cjs");
    const delayedWriter =
      'setTimeout(() => process.stderr.write("stderr-after-exit"), 50);';
    writeFileSync(
      crashScript,
      `const { spawn } = require("node:child_process");
      const writer = spawn(process.execPath, ["-e", ${JSON.stringify(delayedWriter)}], {
        stdio: ["ignore", "ignore", "inherit"],
      });
      writer.unref();
      process.exit(42);`,
    );
    const manager = createProviderProcessManager({
      onProcessExit: exitInfo,
      rawScriptPath: crashScript,
      workspacePath: tmpDir,
    });

    await ensureCrashingProvider(manager);
    await waitForRuntimeState({
      label: "drained provider stderr exit callback",
      predicate: () => exitInfo.mock.calls.length === 1,
    });

    expect(exitInfo.mock.calls[0]?.[0].stderr).toBe("stderr-after-exit");
    await manager.shutdown();
  });

  it("does not wait for an already-exited provider during shutdown", async () => {
    const crashScript = join(tmpDir, "open-stderr-provider.cjs");
    const delayedWriter = "setTimeout(() => {}, 400);";
    writeFileSync(
      crashScript,
      `const { spawn } = require("node:child_process");
      const writer = spawn(process.execPath, ["-e", ${JSON.stringify(delayedWriter)}], {
        stdio: ["ignore", "ignore", "inherit"],
      });
      writer.unref();
      setTimeout(() => process.exit(42), 100);`,
    );
    const exitInfo = vi.fn<NonNullable<AgentRuntimeOptions["onProcessExit"]>>();
    const manager = createProviderProcessManager({
      onProcessExit: exitInfo,
      rawScriptPath: crashScript,
      workspacePath: tmpDir,
    });

    await ensureCrashingProvider(manager);
    await waitForRuntimeState({
      label: "exited provider reported",
      predicate: () => exitInfo.mock.calls.length === 1,
    });

    const startedAt = Date.now();
    await manager.shutdown();

    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  function writeCrashOnceScript(args: {
    scriptPath: string;
    startMarker: string;
    startsLog: string;
    firstStartBody: string;
  }): void {
    writeFileSync(
      args.scriptPath,
      `const { existsSync, writeFileSync, appendFileSync } = require("node:fs");
      const { spawn } = require("node:child_process");
      const startMarker = ${JSON.stringify(args.startMarker)};
      appendFileSync(${JSON.stringify(args.startsLog)}, process.pid + "\\n");
      if (!existsSync(startMarker)) {
        writeFileSync(startMarker, "started");
        ${args.firstStartBody}
      } else {
        const rl = require("node:readline").createInterface({ input: process.stdin });
        rl.on("line", (line) => {
          const msg = JSON.parse(line);
          if (msg.method === "initialize") {
            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { protocolVersion: 2, capabilities: { grammarVersions: [3, 3] } },
            }) + "\\n");
          }
        });
        setInterval(() => {}, 1_000);
      }`,
    );
  }

  it("waits for an exited provider to finalize before replacing it", async () => {
    const crashScript = join(tmpDir, "replace-after-stderr-provider.cjs");
    const startMarker = join(tmpDir, "replace-after-stderr.started");
    const startsLog = join(tmpDir, "replace-after-stderr.starts");
    const delayedWriter = "setTimeout(() => {}, 400);";
    writeCrashOnceScript({
      scriptPath: crashScript,
      startMarker,
      startsLog,
      firstStartBody: `const writer = spawn(process.execPath, ["-e", ${JSON.stringify(delayedWriter)}], {
          stdio: ["ignore", "ignore", "inherit"],
        });
        writer.unref();
        setTimeout(() => process.exit(42), 100);`,
    });
    const exitInfo = vi.fn<NonNullable<AgentRuntimeOptions["onProcessExit"]>>();
    const manager = createProviderProcessManager({
      onProcessExit: exitInfo,
      rawScriptPath: crashScript,
      workspacePath: tmpDir,
    });

    await ensureCrashingProvider(manager);
    await waitForRuntimeState({
      label: "exited provider reported",
      predicate: () => exitInfo.mock.calls.length === 1,
    });
    const [exitedPid] = startedPids(startsLog);

    await manager.ensureProvider({
      bridgeLaunch: MANAGER_BRIDGE_LAUNCH,
      processKey: "fake",
      providerId: "fake",
    });
    const replacementProvider = manager.requireProviderProcess({
      processKey: "fake",
      providerId: "fake",
    });
    expect(exitedPid).toBeDefined();
    expect(replacementProvider.child.pid).not.toBe(exitedPid);
    await manager.shutdown();
  });

  it("starts a single replacement for concurrent callers after an exit", async () => {
    const crashScript = join(tmpDir, "concurrent-replace-provider.cjs");
    const startsLog = join(tmpDir, "concurrent-replace.starts");
    const startMarker = join(tmpDir, "concurrent-replace.started");
    const delayedWriter = "setTimeout(() => {}, 400);";
    writeCrashOnceScript({
      scriptPath: crashScript,
      startMarker,
      startsLog,
      firstStartBody: `const writer = spawn(process.execPath, ["-e", ${JSON.stringify(delayedWriter)}], {
          stdio: ["ignore", "ignore", "inherit"],
        });
        writer.unref();
        setTimeout(() => process.exit(42), 100);`,
    });
    const exitInfo = vi.fn<NonNullable<AgentRuntimeOptions["onProcessExit"]>>();
    const manager = createProviderProcessManager({
      onProcessExit: exitInfo,
      rawScriptPath: crashScript,
      workspacePath: tmpDir,
    });

    await ensureCrashingProvider(manager);
    await waitForRuntimeState({
      label: "exited provider reported",
      predicate: () => exitInfo.mock.calls.length === 1,
    });
    const [exitedPid] = startedPids(startsLog);

    await Promise.all([
      manager.ensureProvider({
        bridgeLaunch: MANAGER_BRIDGE_LAUNCH,
        processKey: "fake",
        providerId: "fake",
      }),
      manager.ensureProvider({
        bridgeLaunch: MANAGER_BRIDGE_LAUNCH,
        processKey: "fake",
        providerId: "fake",
      }),
      manager.ensureProvider({
        bridgeLaunch: MANAGER_BRIDGE_LAUNCH,
        processKey: "fake",
        providerId: "fake",
      }),
    ]);

    const replacementProvider = manager.requireProviderProcess({
      processKey: "fake",
      providerId: "fake",
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(exitedPid).toBeDefined();
    expect(replacementProvider.child.pid).not.toBe(exitedPid);
    expect(startedPids(startsLog)).toHaveLength(2);
    expect(manager.listRunningProviders()).toEqual(["fake"]);
    await manager.shutdown();
  });

  it("cuts off inherited provider output before starting a replacement", async () => {
    const crashScript = join(tmpDir, "stale-descendant-output-provider.cjs");
    const startMarker = join(tmpDir, "stale-descendant-output.started");
    const startsLog = join(tmpDir, "stale-descendant-output.starts");
    const writeMarker = join(tmpDir, "stale-descendant-output.wrote");
    const delayedWriter = `const fs = require("node:fs");
      const writeMarker = ${JSON.stringify(writeMarker)};
      process.on("SIGTERM", () => {});
      setTimeout(() => {
        fs.writeFileSync(writeMarker, "wrote");
        process.stdout.write("stale-from-old-provider\\n");
      }, 1_200);
      setTimeout(() => process.exit(0), 5_000);`;
    writeCrashOnceScript({
      scriptPath: crashScript,
      startMarker,
      startsLog,
      firstStartBody: `const writer = spawn(process.execPath, ["-e", ${JSON.stringify(delayedWriter)}], {
          stdio: ["ignore", "inherit", "inherit"],
        });
        writer.unref();
        setTimeout(() => process.exit(42), 50);`,
    });
    const lines: Array<{ childPid: number | undefined; line: string }> = [];
    const exitInfo = vi.fn<NonNullable<AgentRuntimeOptions["onProcessExit"]>>();
    const manager = createProviderProcessManager({
      handleStdoutLine: (line, childPid) => lines.push({ childPid, line }),
      onProcessExit: exitInfo,
      rawScriptPath: crashScript,
      workspacePath: tmpDir,
    });

    await ensureCrashingProvider(manager);
    await waitForRuntimeState({
      label: "exited provider reported",
      predicate: () => exitInfo.mock.calls.length === 1,
    });
    const [exitedPid] = startedPids(startsLog);

    await manager.ensureProvider({
      bridgeLaunch: MANAGER_BRIDGE_LAUNCH,
      processKey: "fake",
      providerId: "fake",
    });
    const replacementProvider = manager.requireProviderProcess({
      processKey: "fake",
      providerId: "fake",
    });
    await waitForRuntimeState({
      label: "old provider descendant attempted delayed output",
      predicate: () => existsSync(writeMarker),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(exitedPid).toBeDefined();
    expect(replacementProvider.child.pid).not.toBe(exitedPid);
    expect(lines).not.toContainEqual({
      childPid: exitedPid,
      line: "stale-from-old-provider",
    });
    await manager.shutdown();
  });

  it("treats shutdown process errors as expected without carrying state to replacement processes", async () => {
    const exitInfo = vi.fn<NonNullable<AgentRuntimeOptions["onProcessExit"]>>();
    const manager = createProviderProcessManager({
      onProcessExit: exitInfo,
      workspacePath: tmpDir,
    });

    await manager.ensureProvider({
      bridgeLaunch: MANAGER_BRIDGE_LAUNCH,
      processKey: "fake",
      providerId: "fake",
    });
    const shuttingDownProcess = manager.requireProviderProcess({
      processKey: "fake",
      providerId: "fake",
    });
    const shutdown = manager.shutdownProvider({
      processKey: "fake",
      providerId: "fake",
      timeoutMs: 50,
    });
    shuttingDownProcess.child.emit(
      "error",
      new Error("simulated shutdown process error"),
    );

    expect(exitInfo).toHaveBeenCalledTimes(1);
    expect(exitInfo).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        code: null,
        expected: true,
        providerId: "fake",
      }),
    );
    await shutdown;

    await manager.ensureProvider({
      bridgeLaunch: MANAGER_BRIDGE_LAUNCH,
      processKey: "fake",
      providerId: "fake",
    });
    const replacementProcess = manager.requireProviderProcess({
      processKey: "fake",
      providerId: "fake",
    });
    replacementProcess.child.emit("exit", 64, null);
    replacementProcess.child.emit("close", 64, null);

    await waitForRuntimeState({
      label: "unexpected replacement process exit",
      predicate: () => exitInfo.mock.calls.length === 2,
    });
    expect(exitInfo).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        code: 64,
        expected: false,
        providerId: "fake",
      }),
    );
    replacementProcess.child.kill("SIGTERM");
    await manager.shutdown();
  });

  function createCodexRuntime(args: {
    events: ThreadEvent[];
    scripted?: ScriptedEchoLaunchScript;
    env?: Record<string, string>;
  }) {
    const processLog = createScriptedEchoProcessLog();
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath: tmpDir,
        env: { ...processLog.env, ...args.env },
        onEvent: (event) => args.events.push(event),
      },
      launch: {
        pluginId: "provider-codex",
        scripted: { ...CODEX_SCRIPT, ...args.scripted },
      },
    });
    return { processLog, runtime };
  }

  it("runs every codex thread on one provider process", async () => {
    const events: ThreadEvent[] = [];
    const { processLog, runtime } = createCodexRuntime({ events });
    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "codex",
      options: fullRuntimeOptions,
    });
    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t2",
      projectId: "p1",
      providerId: "codex",
      options: fullRuntimeOptions,
    });
    expect(
      processLog.read().filter((line) => line.startsWith("spawn:")),
    ).toHaveLength(1);
    const firstSession = runtime.getProviderSession("t1");
    const secondSession = runtime.getProviderSession("t2");
    if (!firstSession || !secondSession) {
      throw new Error("Expected both codex threads to have provider sessions");
    }
    expect(firstSession.providerThreadId).not.toBe(
      secondSession.providerThreadId,
    );
    await Promise.all([
      runtime.runTurn({
        clientRequestId: "creq_222222225a",
        threadId: "t1",
        input: [promptTextInput({ text: "first" })],
        options: fullRuntimeOptions,
      }),
      runtime.runTurn({
        clientRequestId: "creq_222222225b",
        threadId: "t2",
        input: [promptTextInput({ text: "second" })],
        options: fullRuntimeOptions,
      }),
    ]);
    await waitForThreadAgentMessageText({
      events,
      providerId: "codex",
      runtime,
      text: "first",
      threadId: "t1",
    });
    await waitForThreadAgentMessageText({
      events,
      providerId: "codex",
      runtime,
      text: "second",
      threadId: "t2",
    });
    const pidOf = (threadId: string): string | undefined =>
      events
        .filter(
          (event): event is Extract<ThreadEvent, { type: "item/completed" }> =>
            event.type === "item/completed" && event.threadId === threadId,
        )
        .map((event) =>
          event.item.type === "agentMessage"
            ? event.item.text.split(":")[1]
            : undefined,
        )
        .find((pid) => pid !== undefined);
    expect(pidOf("t1")).toBeDefined();
    expect(pidOf("t1")).toBe(pidOf("t2"));

    await runtime.stopThread({ threadId: "t1" });
    expect(runtime.hasThread("t1")).toBe(false);
    expect(runtime.listRunningProviders()).toEqual(["codex"]);
    await runtime.runTurn({
      clientRequestId: "creq_2222222252",
      threadId: "t2",
      input: [promptTextInput({ text: "still alive" })],
      options: fullRuntimeOptions,
    });
    await waitForThreadAgentMessageText({
      events,
      providerId: "codex",
      runtime,
      text: "still alive",
      threadId: "t2",
    });
    expect(
      processLog.read().filter((line) => line.startsWith("exit:")),
    ).toHaveLength(0);
    await runtime.shutdown();
  });

  it("retires the provider process when session construction fails", async () => {
    const events: ThreadEvent[] = [];
    const { processLog, runtime } = createCodexRuntime({
      events,
      scripted: {
        failMethods: [
          { method: "thread/start", message: "no rollout found for t1" },
        ],
      },
    });
    await expect(
      runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "codex",
        options: fullRuntimeOptions,
      }),
    ).rejects.toThrow("no rollout found");
    expect(runtime.getProviderSession("t1")).toBeNull();
    expect(runtime.listRunningProviders()).toEqual([]);
    expect(
      processLog.read().filter((line) => line.startsWith("exit:")),
    ).toHaveLength(1);
    await runtime.shutdown();
  });

  it("gives a changed declaration its own bridge process at the same artifact hash", async () => {
    const record = createScriptedEchoRequestRecord();
    const bridgeLaunch: AgentRuntimeBridgeLaunch = createScriptedEchoLaunch({
      pluginId: "provider-declared",
      digest: "d".repeat(64),
    });
    const runtime = createAgentRuntime({
      workspacePath: tmpDir,
      env: record.env,
      onEvent: () => {},
      onToolCall: async () => ({ contentItems: [], success: true }),
    });
    const initializeCount = (): number =>
      record.read().filter((r) => r.method === "initialize").length;
    try {
      await runtime.startThread({
        bridgeLaunch,
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "declared",
        options: fullRuntimeOptions,
      });
      await runtime.startThread({
        bridgeLaunch,
        environmentId: "env-1",
        threadId: "t2",
        projectId: "p1",
        providerId: "declared",
        options: fullRuntimeOptions,
      });
      expect(initializeCount()).toBe(1);

      const updatedDeclaration: AgentRuntimeBridgeLaunch = {
        ...bridgeLaunch,
        capabilities: {
          ...bridgeLaunch.capabilities,
          supportsThreadRename: !bridgeLaunch.capabilities.supportsThreadRename,
        },
      };
      await runtime.startThread({
        bridgeLaunch: updatedDeclaration,
        environmentId: "env-1",
        threadId: "t3",
        projectId: "p1",
        providerId: "declared",
        options: fullRuntimeOptions,
      });
      expect(initializeCount()).toBe(2);
    } finally {
      await runtime.shutdown();
    }
  });

  it("reaps a codex session after a terminal provider error before turn start", async () => {
    const events: ThreadEvent[] = [];
    const { processLog, runtime } = createCodexRuntime({ events });
    try {
      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "codex",
        options: fullRuntimeOptions,
      });
      const initialSession = runtime.getProviderSession("t1");
      if (!initialSession) {
        throw new Error("Expected a codex session");
      }
      await runtime.runTurn({
        clientRequestId: "creq_2222222257",
        threadId: "t1",
        input: [promptTextInput({ text: "prestart_fail:401_Unauthorized" })],
        options: fullRuntimeOptions,
      });
      await waitForRuntimeState({
        events,
        label: "pre-start provider error",
        predicate: () =>
          events.some(
            (event) =>
              event.type === "provider/error" && event.threadId === "t1",
          ),
        providerId: "codex",
        runtime,
      });
      expect(runtime.getActiveTurnId("t1")).toBeNull();

      const result = await runtime.reapIdleProviderSessions({
        idleForMs: 0,
        nowMs: Date.now() + 60 * 60 * 1000,
      });
      expect(result.reapedSessions).toEqual([
        expect.objectContaining({
          providerId: "codex",
          providerThreadId: initialSession.providerThreadId,
          threadId: "t1",
        }),
      ]);
      expect(runtime.getProviderSession("t1")).toBeNull();
      expect(runtime.listRunningProviders()).toEqual([]);
      expect(
        processLog.read().filter((line) => line.startsWith("exit:")),
      ).toHaveLength(1);
    } finally {
      await runtime.shutdown();
    }
  });

  it("reaps an idle codex session and resumes it on a new process", async () => {
    const events: ThreadEvent[] = [];
    const { processLog, runtime } = createCodexRuntime({ events });
    try {
      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "codex",
        options: fullRuntimeOptions,
      });
      const initialSession = runtime.getProviderSession("t1");
      if (!initialSession) {
        throw new Error("Expected a codex session");
      }
      await runtime.runTurn({
        clientRequestId: "creq_2222222258",
        threadId: "t1",
        input: [promptTextInput({ text: "before reap" })],
        options: fullRuntimeOptions,
      });
      await waitForThreadAgentMessageText({
        events,
        providerId: "codex",
        runtime,
        text: "before reap",
        threadId: "t1",
      });

      const belowThresholdResult = await runtime.reapIdleProviderSessions({
        idleForMs: 30 * 60 * 1000,
        nowMs: Date.now() + 29 * 60 * 1000,
      });
      expect(belowThresholdResult.reapedSessions).toEqual([]);
      expect(runtime.hasThread("t1")).toBe(true);
      expect(
        processLog.read().filter((line) => line.startsWith("exit:")),
      ).toHaveLength(0);

      const result = await runtime.reapIdleProviderSessions({
        idleForMs: 30 * 60 * 1000,
        nowMs: Date.now() + 31 * 60 * 1000,
      });
      const reapedSession = result.reapedSessions[0];
      if (!reapedSession) {
        throw new Error("Expected the idle codex session to be reaped");
      }
      expect(result.reapedSessions).toHaveLength(1);
      expect(reapedSession).toMatchObject({
        providerId: "codex",
        providerThreadId: initialSession.providerThreadId,
        threadId: "t1",
      });
      expect(reapedSession.idleForMs).toBeGreaterThanOrEqual(30 * 60 * 1000);
      expect(runtime.hasThread("t1")).toBe(false);
      expect(runtime.getProviderSession("t1")).toBeNull();
      expect(runtime.listRunningProviders()).toEqual([]);

      await runtime.resumeThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "codex",
        providerThreadId: initialSession.providerThreadId,
        options: fullRuntimeOptions,
      });
      await runtime.runTurn({
        clientRequestId: "creq_2222222259",
        threadId: "t1",
        input: [promptTextInput({ text: "after reap" })],
        options: fullRuntimeOptions,
      });
      await waitForThreadAgentMessageText({
        events,
        providerId: "codex",
        runtime,
        text: "after reap",
        threadId: "t1",
      });
      const logLines = processLog.read();
      expect(logLines.filter((line) => line.startsWith("spawn:"))).toHaveLength(
        2,
      );
      expect(logLines.filter((line) => line.startsWith("exit:"))).toHaveLength(
        1,
      );
      expect(
        logLines.some(
          (line) =>
            line.startsWith("thread/resume:") &&
            line.endsWith(`:t1:${initialSession.providerThreadId}`),
        ),
      ).toBe(true);
    } finally {
      await runtime.shutdown();
    }
  });

  it("does not reap a codex thread process while a turn is active", async () => {
    const events: ThreadEvent[] = [];
    const { processLog, runtime } = createCodexRuntime({ events });
    try {
      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "codex",
        options: fullRuntimeOptions,
      });
      await runtime.runTurn({
        clientRequestId: "creq_222222226a",
        threadId: "t1",
        input: [promptTextInput({ text: "hold_turn" })],
        options: fullRuntimeOptions,
      });
      const { turnId } = await waitForThreadTurnStarted({
        events,
        providerId: "codex",
        runtime,
        threadId: "t1",
      });
      expect(runtime.getActiveTurnId("t1")).toBe(turnId);
      const firstResult = await runtime.reapIdleProviderSessions({
        idleForMs: 0,
        nowMs: Date.now() + 60 * 60 * 1000,
      });
      const secondResult = await runtime.reapIdleProviderSessions({
        idleForMs: 0,
        nowMs: Date.now() + 60 * 60 * 1000,
      });
      expect(firstResult.reapedSessions).toEqual([]);
      expect(secondResult.reapedSessions).toEqual([]);
      expect(runtime.hasThread("t1")).toBe(true);
      expect(
        processLog.read().filter((line) => line.startsWith("exit:")),
      ).toHaveLength(0);
    } finally {
      await runtime.shutdown();
    }
  });

  it("reaps a restorable non-Codex session", async () => {
    const events: ThreadEvent[] = [];
    const processLog = createScriptedEchoProcessLog();
    const runtime = createScriptedEchoRuntime({
      runtime: {
        env: processLog.env,
        workspacePath: tmpDir,
        onEvent: (event) => events.push(event),
      },
      launch: {
        pluginId: "provider-claude-code",
        scripted: { sessionRestorable: true },
      },
    });
    try {
      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "claude-code",
        options: fullRuntimeOptions,
      });
      const result = await runtime.reapIdleProviderSessions({
        idleForMs: 0,
        nowMs: Date.now(),
      });
      expect(result.reapedSessions).toEqual([
        expect.objectContaining({
          providerId: "claude-code",
          threadId: "t1",
        }),
      ]);
      expect(runtime.hasThread("t1")).toBe(false);
      expect(runtime.listRunningProviders()).toEqual([]);
      expect(
        processLog.read().filter((line) => line.startsWith("exit:")),
      ).toHaveLength(1);
    } finally {
      await runtime.shutdown();
    }
  });

  it("marks a cold-resumed session restorable from the bridge's resume result", async () => {
    const runtime = createScriptedEchoRuntime({
      runtime: { workspacePath: tmpDir, onEvent: () => {} },
      launch: {
        pluginId: "provider-claude-code",
        scripted: { sessionRestorable: true },
      },
    });
    try {
      await runtime.resumeThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerThreadId: "old-prov-1",
        providerId: "claude-code",
        options: fullRuntimeOptions,
      });
      expect(runtime.hasThread("t1")).toBe(true);
      const result = await runtime.reapIdleProviderSessions({
        idleForMs: 0,
        nowMs: Date.now(),
      });
      expect(result.reapedSessions).toEqual([
        expect.objectContaining({ providerId: "claude-code", threadId: "t1" }),
      ]);
      expect(runtime.hasThread("t1")).toBe(false);
    } finally {
      await runtime.shutdown();
    }
  });

  it("keeps a cold-resumed session when the bridge's resume result is not restorable", async () => {
    const runtime = createScriptedEchoRuntime({
      runtime: { workspacePath: tmpDir, onEvent: () => {} },
      launch: {
        pluginId: "provider-claude-code",
        scripted: { sessionRestorable: false },
      },
    });
    try {
      await runtime.resumeThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerThreadId: "old-prov-1",
        providerId: "claude-code",
        options: fullRuntimeOptions,
      });
      await expect(
        runtime.reapIdleProviderSessions({
          idleForMs: 0,
          nowMs: Date.now(),
        }),
      ).resolves.toEqual({ reapedSessions: [] });
      expect(runtime.hasThread("t1")).toBe(true);
    } finally {
      await runtime.shutdown();
    }
  });

  it("keeps releasing later sessions after one release fails", async () => {
    const events: ThreadEvent[] = [];
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath: tmpDir,
        onEvent: (event) => events.push(event),
      },
      launch: {
        pluginId: "provider-claude-code",
        scripted: {
          sessionRestorable: true,
          failStopForThreadIds: ["t-stopfail-1"],
        },
      },
    });
    try {
      for (const threadId of ["t-stopfail-1", "t2"]) {
        await runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "p1",
          providerId: "claude-code",
          options: fullRuntimeOptions,
        });
      }
      const result = await runtime.reapIdleProviderSessions({
        idleForMs: 0,
        nowMs: Date.now(),
      });
      expect(result.reapedSessions).toEqual([
        expect.objectContaining({ threadId: "t2" }),
      ]);
      expect(runtime.hasThread("t-stopfail-1")).toBe(true);
      expect(runtime.hasThread("t2")).toBe(false);
    } finally {
      await runtime.shutdown();
    }
  });

  it("scrubs inherited bb runtime env vars before spawning provider processes", async () => {
    vi.stubEnv("BB_DATA_DIR", "/tmp/leaked-bb-data");
    vi.stubEnv("BB_SERVER_PORT", "38886");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("OPENAI_API_KEY", "external-secret");
    const envScript = join(tmpDir, "env-provider.cjs");
    writeFileSync(
      envScript,
      `const values = [
        process.env.BB_DATA_DIR ?? "missing",
        process.env.BB_SERVER_PORT ?? "missing",
        process.env.NODE_ENV ?? "missing",
        process.env.OPENAI_API_KEY ?? "missing",
        process.env.BB_THREAD_ID ?? "missing"
      ];
      process.stderr.write(values.join("|") + "\\n");
      setInterval(() => {}, 1000);`,
    );
    const stderrLines: string[] = [];
    const manager = createProviderProcessManager({
      env: {
        BB_THREAD_ID: "thr_explicit",
      },
      onProcessExit: vi.fn(),
      onStderr: (line) => {
        stderrLines.push(line);
      },
      rawScriptPath: envScript,
      workspacePath: tmpDir,
    });

    try {
      const ensure = manager
        .ensureProvider({
          bridgeLaunch: MANAGER_BRIDGE_LAUNCH,
          processKey: "fake",
          providerId: "fake",
        })
        .catch(() => undefined);
      await waitForRuntimeState({
        label: "provider env stderr",
        predicate: () => stderrLines.length > 0,
      });
      expect(stderrLines[0]).toBe(
        "missing|missing|missing|external-secret|thr_explicit",
      );
      await manager.shutdown();
      await ensure;
    } finally {
      await manager.shutdown();
    }
  });

  it("launches runtime-managed node bridges with the current executable when node is absent from PATH", async () => {
    vi.stubEnv("PATH", "");
    const record = createScriptedEchoRequestRecord();
    const runtime = createScriptedEchoRuntime({
      runtime: { workspacePath: tmpDir, env: record.env, onEvent: () => {} },
    });
    try {
      await runtime.ensureProvider({ providerId: "fake" });
      expect(record.last("initialize")).toBeDefined();
    } finally {
      await runtime.shutdown();
    }
  });

  it("overlays adapter process env after inherited and runtime env", async () => {
    vi.stubEnv("ELECTRON_RUN_AS_NODE", "0");
    const envScript = join(tmpDir, "bridge-env-provider.cjs");
    writeFileSync(
      envScript,
      `const values = [
        process.env.ELECTRON_RUN_AS_NODE ?? "missing",
        process.env.BRIDGE_ONLY ?? "missing",
        process.env.BB_THREAD_ID ?? "missing"
      ];
      process.stderr.write(values.join("|") + "\\n");
      setInterval(() => {}, 1000);`,
    );
    const stderrLines: string[] = [];
    const manager = createProviderProcessManager({
      adapterProcessEnv: {
        BRIDGE_ONLY: "bridge",
        ELECTRON_RUN_AS_NODE: "1",
      },
      env: {
        BB_THREAD_ID: "thr_explicit",
        ELECTRON_RUN_AS_NODE: "runtime",
      },
      onProcessExit: vi.fn(),
      onStderr: (line) => {
        stderrLines.push(line);
      },
      rawScriptPath: envScript,
      workspacePath: tmpDir,
    });

    try {
      const ensure = manager
        .ensureProvider({
          bridgeLaunch: MANAGER_BRIDGE_LAUNCH,
          processKey: "fake",
          providerId: "fake",
        })
        .catch(() => undefined);
      await waitForRuntimeState({
        label: "bridge env stderr",
        predicate: () => stderrLines.length > 0,
      });
      expect(stderrLines[0]).toBe("1|bridge|thr_explicit");
      await manager.shutdown();
      await ensure;
    } finally {
      await manager.shutdown();
    }
  });

  it("ignores provider stdout emitted after shutdown starts", async () => {
    const events: ThreadEvent[] = [];
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath: tmpDir,
        env: scriptedEchoProcessEnv({ emitIdentityOnSigterm: true }),
        onEvent: (event) => events.push(event),
      },
    });
    const { providerThreadId } = await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await waitForRuntimeState({
      label: "initial provider identity event",
      predicate: () =>
        events.some(
          (event) =>
            event.type === "thread/identity" &&
            event.providerThreadId === providerThreadId,
        ),
    });
    events.splice(0, events.length);
    await runtime.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(events).toEqual([]);
  });

  it("fails fast when the bridge artifact does not exist", async () => {
    const runtime = createAgentRuntime({
      workspacePath: tmpDir,
      onEvent: () => {},
      onToolCall: async () => ({ contentItems: [], success: true }),
    });
    await expect(
      withBridgeLaunch(
        runtime,
        createScriptedEchoLaunch({
          modulePath: join(tmpDir, "nonexistent-bridge.mjs"),
        }),
      ).ensureProvider({ providerId: "fake" }),
    ).rejects.toThrow(/exited unexpectedly[\s\S]*Cannot find module/);
    await runtime.shutdown();
  });

  it("fails fast when provider crashes during initialize", async () => {
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath: tmpDir,
        env: scriptedEchoProcessEnv({ crashOn: "initialize" }),
        onEvent: () => {},
      },
    });
    await expect(
      runtime.ensureProvider({ providerId: "fake" }),
    ).rejects.toThrow(/exited during startup|exited/i);
    await runtime.shutdown();
  });

  it("removes the cached provider and retries when startup skill configuration fails", async () => {
    const record = createScriptedEchoRequestRecord();
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath: tmpDir,
        env: {
          ...record.env,
          ...scriptedEchoProcessEnv({
            failMethods: [
              { method: "skills/configure", message: "configure failed" },
            ],
          }),
        },
        skillRoots: [{ id: "skill-root", path: tmpDir, skills: [] }],
        onEvent: () => {},
      },
      launch: { pluginId: "provider-codex" },
    });
    try {
      await expect(
        runtime.startThread({
          environmentId: "env-1",
          threadId: "t1",
          projectId: "p1",
          providerId: "codex",
          options: fullRuntimeOptions,
        }),
      ).rejects.toThrow("configure failed");
      expect(runtime.listRunningProviders()).not.toContain("codex");
      const requestsBefore = record.read();
      expect(requestsBefore.map((request) => request.method)).toEqual([
        "initialize",
        "skills/configure",
      ]);
      expect(requestsBefore.some((r) => r.method === "thread/start")).toBe(
        false,
      );
    } finally {
      await runtime.shutdown();
    }
    const retryRecord = createScriptedEchoRequestRecord();
    const retryRuntime = createScriptedEchoRuntime({
      runtime: {
        workspacePath: tmpDir,
        env: retryRecord.env,
        skillRoots: [{ id: "skill-root", path: tmpDir, skills: [] }],
        onEvent: () => {},
      },
      launch: { pluginId: "provider-codex" },
    });
    try {
      await retryRuntime.startThread({
        environmentId: "env-1",
        threadId: "t2",
        projectId: "p1",
        providerId: "codex",
        options: fullRuntimeOptions,
      });
      expect(retryRuntime.listRunningProviders()).toContain("codex");
      expect(retryRecord.read().map((request) => request.method)).toEqual([
        "initialize",
        "skills/configure",
        "thread/start",
      ]);
    } finally {
      await retryRuntime.shutdown();
    }
  });

  it("waits for startup skill configuration before starting a codex thread", async () => {
    const record = createScriptedEchoRequestRecord();
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath: tmpDir,
        env: record.env,
        skillRoots: [{ id: "skill-root", path: tmpDir, skills: [] }],
        onEvent: () => {},
      },
      launch: { pluginId: "provider-codex", scripted: { startDelayMs: 50 } },
    });
    try {
      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "codex",
        options: fullRuntimeOptions,
      });
      expect(record.read().map((request) => request.method)).toEqual([
        "initialize",
        "skills/configure",
        "thread/start",
      ]);
    } finally {
      await runtime.shutdown();
    }
  });

  it("fails fast on runTurn after provider has crashed", async () => {
    const exitInfo = vi.fn();
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath: tmpDir,
        onEvent: () => {},
        onProcessExit: exitInfo,
      },
      launch: { scripted: { exitAfter: "thread/start" } },
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await waitForRuntimeState({
      label: "provider process exit callback",
      predicate: () => exitInfo.mock.calls.length === 1,
    });
    await expect(
      runtime.runTurn({
        clientRequestId: "creq_222222226b",
        threadId: "t1",
        input: [promptTextInput({ text: "after crash" })],
        options: fullRuntimeOptions,
      }),
    ).rejects.toThrow(/exited|not running|no provider associated/i);
    await runtime.shutdown();
  });

  it("reports a pending turn when the provider exits after acknowledging turn/start", async () => {
    const exitInfo = vi.fn<NonNullable<AgentRuntimeOptions["onProcessExit"]>>();
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath: tmpDir,
        onEvent: () => {},
        onProcessExit: exitInfo,
      },
      launch: { scripted: { swallowTurnStart: true, exitAfter: "turn/start" } },
    });

    const { providerThreadId } = await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await runtime.runTurn({
      clientRequestId: "creq_2222222262",
      threadId: "t1",
      input: [promptTextInput({ text: "never starts" })],
      options: fullRuntimeOptions,
    });
    await waitForRuntimeState({
      label: "provider process exit callback",
      predicate: () => exitInfo.mock.calls.length === 1,
    });
    expect(exitInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "fake",
        threads: [
          expect.objectContaining({
            threadId: "t1",
            providerThreadId,
            activeTurnId: null,
            pendingTurnStart: true,
          }),
        ],
      }),
    );
    await runtime.shutdown();
  });

  it("concurrent ensureProvider calls do not spawn duplicate processes", async () => {
    const record = createScriptedEchoRequestRecord();
    const runtime = createScriptedEchoRuntime({
      runtime: { workspacePath: tmpDir, env: record.env, onEvent: () => {} },
    });

    await Promise.all([
      runtime.ensureProvider({ providerId: "fake" }),
      runtime.ensureProvider({ providerId: "fake" }),
      runtime.ensureProvider({ providerId: "fake" }),
    ]);
    expect(
      record.read().filter((request) => request.method === "initialize"),
    ).toHaveLength(1);
    expect(runtime.listRunningProviders()).toEqual(["fake"]);
    await runtime.shutdown();
  });
});

function readLogLines(logPath: string): string[] {
  if (!existsSync(logPath)) {
    return [];
  }
  const content = readFileSync(logPath, "utf8").trim();
  return content.length > 0 ? content.split("\n") : [];
}
