import type {
  BbPluginApi,
  MessageDispatchHookContext,
  PluginDispatchAttemptKind,
} from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import plugin from "./server.js";

type HostRecord = Awaited<
  ReturnType<BbPluginApi["sdk"]["hosts"]["list"]>
>[number];
type RunningThread = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["listRunning"]>
>[number];
type SdkSubscription = Parameters<BbPluginApi["sdk"]["subscribe"]>[0];
type HostChangedSubscription = Extract<
  SdkSubscription,
  { event: "host:changed" }
>;

function isHostChangedSubscription(
  subscription: SdkSubscription,
): subscription is HostChangedSubscription {
  return subscription.event === "host:changed";
}

const PLUGIN_ID = "concurrency-limit";
function hostRecord(
  id: string,
  status: HostRecord["status"] = "connected",
  name = id,
): HostRecord {
  return {
    id,
    name,
    type: "persistent",
    status,
    maxPermissionMode: "full",
    lastSeenAt: null,
    lastRejectedProtocolVersion: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function running(overrides: Partial<RunningThread> = {}): RunningThread {
  return { id: "thr_running", hostId: "host-a", ...overrides };
}

interface GateContextOverrides {
  hostId?: string | null;
  hostName?: string;
  thread?: Partial<MessageDispatchHookContext["thread"]>;
  attempt?: PluginDispatchAttemptKind;
}

function dispatchContext(overrides: GateContextOverrides = {}) {
  const hostId = overrides.hostId === undefined ? "host-a" : overrides.hostId;
  return makeMessageDispatchHookContext({
    thread: {
      id: "thr_1",
      status: "pending",
      ...overrides.thread,
    },
    attempt: overrides.attempt ?? "start-turn",
    host:
      hostId === null
        ? null
        : { id: hostId, name: overrides.hostName ?? hostId },
  });
}

interface SetupOptions {
  configuration?: {
    globalLimit: number | null;
    hostOverrides: Array<{ hostId: string; limit: number }>;
  };
  capacities?: Array<{ hostId: string; availableParallelism: number }>;
  hosts?: HostRecord[] | (() => HostRecord[]);
  running?: RunningThread[];
  detectedParallelism?: number;
  subscribe?: BbPluginApi["sdk"]["subscribe"];
}

async function setup(options: SetupOptions = {}) {
  const subscribe: BbPluginApi["sdk"]["subscribe"] = () => () => {};
  const fake = createFakePluginHost({
    pluginId: PLUGIN_ID,
    sdk: {
      subscribe: options.subscribe ?? subscribe,
      hosts: {
        list: async () =>
          typeof options.hosts === "function"
            ? options.hosts()
            : (options.hosts ?? []),
      },
      threads: { listRunning: async () => options.running ?? [] },
    },
    experimental_callHostRpc: () => ({
      availableParallelism: options.detectedParallelism ?? 8,
    }),
  });
  if (options.configuration !== undefined) {
    await fake.bb.storage.kv.set("configuration", options.configuration);
  }
  if (options.capacities !== undefined) {
    await fake.bb.storage.kv.set("host-capacities", options.capacities);
  }
  await plugin(fake.bb);
  const hook = fake.harness.registrations.hooks["message.dispatch"];
  if (hook === null) throw new Error("message.dispatch was not registered");
  return { ...fake, hook };
}

function hostChanges(): {
  emitHostConnected(hostId: string): void;
  subscribe: BbPluginApi["sdk"]["subscribe"];
} {
  let callback: HostChangedSubscription["callback"] | null = null;
  return {
    emitHostConnected(hostId) {
      callback?.({
        type: "changed",
        entity: "host",
        id: hostId,
        changes: ["host-connected"],
      });
    },
    subscribe(subscription) {
      if (isHostChangedSubscription(subscription)) {
        callback = subscription.callback;
      }
      return () => {
        if (isHostChangedSubscription(subscription)) callback = null;
      };
    },
  };
}

describe("configuration", () => {
  it("uses a custom settings section rather than generic setting descriptors", async () => {
    const { harness } = await setup();

    expect(harness.registrations.settingsDescriptors).toEqual({});
    expect(harness.registrations.rpcMethods).toEqual([
      "getConfiguration",
      "setConfiguration",
    ]);
    expect(
      harness.registrations.services.map((service) => service.name),
    ).toEqual(["capacity-detector"]);
  });

  it("returns each host's detected automatic limit and retained offline capacity", async () => {
    const { harness } = await setup({
      hosts: [
        hostRecord("host-a", "connected", "Laptop"),
        hostRecord("host-b", "disconnected", "Studio"),
      ],
      capacities: [
        { hostId: "host-a", availableParallelism: 8 },
        { hostId: "host-b", availableParallelism: 16 },
      ],
    });

    await expect(harness.behavior.callRpc("getConfiguration")).resolves.toEqual(
      {
        globalLimit: null,
        hostOverrides: [],
        hosts: [
          {
            id: "host-a",
            name: "Laptop",
            status: "connected",
            availableParallelism: 8,
            automaticLimit: 8,
            effectiveLimit: 8,
            override: null,
          },
          {
            id: "host-b",
            name: "Studio",
            status: "disconnected",
            availableParallelism: 16,
            automaticLimit: 16,
            effectiveLimit: 16,
            override: null,
          },
        ],
      },
    );
  });

  it("rejects invalid and duplicate limits at the RPC boundary", async () => {
    const { harness } = await setup();

    await expect(
      harness.behavior.callRpc("setConfiguration", {
        globalLimit: 1.5,
        hostOverrides: [],
      }),
    ).rejects.toThrow();
    await expect(
      harness.behavior.callRpc("setConfiguration", {
        globalLimit: null,
        hostOverrides: [
          { hostId: "host-a", limit: 1 },
          { hostId: "host-a", limit: 2 },
        ],
      }),
    ).rejects.toThrow(/rpc input validation failed/u);
  });

  it("persists validated configuration and rechecks waiting dispatches", async () => {
    const { bb, harness } = await setup({ hosts: [hostRecord("host-a")] });

    await harness.behavior.callRpc("setConfiguration", {
      globalLimit: 3,
      hostOverrides: [{ hostId: "host-a", limit: 0 }],
    });

    await expect(bb.storage.kv.get("configuration")).resolves.toEqual({
      globalLimit: 3,
      hostOverrides: [{ hostId: "host-a", limit: 0 }],
    });
    expect(harness.recheckCount).toBe(1);
  });

  it("detects connected host capacity in the background", async () => {
    const { bb, harness } = await setup({
      hosts: [hostRecord("host-a")],
      detectedParallelism: 12,
    });
    const service = harness.behavior.runService("capacity-detector");

    await vi.waitFor(() => {
      expect(harness.experimental_hostRpcCalls).toHaveLength(1);
    });
    await expect(bb.storage.kv.get("host-capacities")).resolves.toEqual([
      { hostId: "host-a", availableParallelism: 12 },
    ]);
    await expect(
      harness.behavior.callRpc("getConfiguration"),
    ).resolves.toMatchObject({
      hosts: [
        {
          id: "host-a",
          availableParallelism: 12,
          automaticLimit: 12,
          effectiveLimit: 12,
        },
      ],
    });

    service.controller.abort();
    await service.done;
  });

  it("detects a host when it connects after startup", async () => {
    const changes = hostChanges();
    let status: HostRecord["status"] = "disconnected";
    const { harness } = await setup({
      hosts: () => [hostRecord("host-a", status)],
      subscribe: changes.subscribe,
    });
    const service = harness.behavior.runService("capacity-detector");
    await vi.waitFor(() => {
      expect(harness.inspection.sdk.callsTo("hosts.list")).toHaveLength(1);
    });
    expect(harness.experimental_hostRpcCalls).toHaveLength(0);

    status = "connected";
    changes.emitHostConnected("host-a");
    await vi.waitFor(() => {
      expect(harness.experimental_hostRpcCalls).toHaveLength(1);
    });

    service.controller.abort();
    await service.done;
  });

  it("provides CLI parity for global and host overrides", async () => {
    const { harness } = await setup({
      hosts: [hostRecord("host-a", "connected", "Laptop")],
      capacities: [{ hostId: "host-a", availableParallelism: 8 }],
    });

    await expect(
      harness.behavior.runCli(["global", "3"]),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: "3",
    });
    await expect(
      harness.behavior.runCli(["host", "host-a", "0"]),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: "Laptop: 0 (8 processors, connected)",
    });
    await expect(
      harness.behavior.runCli(["host", "host-a", "auto"]),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: "Laptop: auto, 8 (8 processors, connected)",
    });
    await expect(
      harness.behavior.runCli(["global", "1.5"]),
    ).resolves.toMatchObject({ exitCode: 1 });
  });
});

describe("message.dispatch", () => {
  it("uses a conservative limit of one until a host is detected", async () => {
    const { hook } = await setup({ running: [running()] });

    await expect(hook(dispatchContext())).resolves.toEqual({
      action: "wait",
      reason: "1 of 1 running on host host-a",
    });
  });

  it("uses each host's detected automatic limit", async () => {
    const { hook } = await setup({
      capacities: [{ hostId: "host-a", availableParallelism: 8 }],
      running: [
        running({ id: "a" }),
        running({ id: "b" }),
        running({ id: "c" }),
        running({ id: "d" }),
        running({ id: "e" }),
        running({ id: "f" }),
        running({ id: "g" }),
        running({ id: "h" }),
      ],
    });

    await expect(hook(dispatchContext())).resolves.toEqual({
      action: "wait",
      reason: "8 of 8 running on host host-a",
    });
  });

  it("keeps host pools separate and honors explicit overrides", async () => {
    const { hook } = await setup({
      configuration: {
        globalLimit: null,
        hostOverrides: [{ hostId: "host-a", limit: 1 }],
      },
      running: [running({ hostId: "host-a" })],
    });

    await expect(hook(dispatchContext({ hostId: "host-a" }))).resolves.toEqual({
      action: "wait",
      reason: "1 of 1 running on host host-a",
    });
    await expect(hook(dispatchContext({ hostId: "host-b" }))).resolves.toEqual({
      action: "proceed",
    });
  });

  it("applies the overall limit before a host limit", async () => {
    const { hook } = await setup({
      configuration: { globalLimit: 1, hostOverrides: [] },
      running: [running()],
    });

    await expect(hook(dispatchContext())).resolves.toEqual({
      action: "wait",
      reason: "1 of 1 running on all hosts",
    });
  });

  it("treats zero as a pause rather than as unlimited", async () => {
    const global = await setup({
      configuration: { globalLimit: 0, hostOverrides: [] },
    });
    await expect(
      global.hook(dispatchContext({ hostId: null })),
    ).resolves.toEqual({
      action: "wait",
      reason: "0 of 0 running on all hosts",
    });

    const host = await setup({
      configuration: {
        globalLimit: null,
        hostOverrides: [{ hostId: "host-a", limit: 0 }],
      },
    });
    await expect(host.hook(dispatchContext())).resolves.toEqual({
      action: "wait",
      reason: "0 of 0 running on host host-a",
    });
  });

  it("skips host enforcement when no host has been selected", async () => {
    const { harness, hook } = await setup({ running: [running()] });

    await expect(hook(dispatchContext({ hostId: null }))).resolves.toEqual({
      action: "proceed",
    });
    expect(harness.inspection.sdk.callsTo("threads.listRunning")).toHaveLength(
      0,
    );
  });

  it("does not re-admit running threads or join-turn attempts", async () => {
    const { hook } = await setup({
      configuration: { globalLimit: 0, hostOverrides: [] },
    });

    await expect(
      hook(dispatchContext({ thread: { status: "active" } })),
    ).resolves.toEqual({ action: "proceed" });
    await expect(
      hook(
        dispatchContext({
          attempt: "join-turn",
          thread: { status: "idle" },
        }),
      ),
    ).resolves.toEqual({ action: "proceed" });
  });
});

describe("capacity wake events", () => {
  it("rechecks queued work when a running thread stops occupying capacity", async () => {
    const { harness } = await setup();
    const thread = makeThreadResponse({ id: "thr_freed", status: "idle" });

    await harness.behavior.emitThreadEvent("thread.idle", {
      thread,
      lastAssistantText: null,
    });
    await harness.behavior.emitThreadEvent("thread.failed", {
      thread,
      error: null,
    });
    await harness.behavior.emitThreadEvent("thread.archived", { thread });
    await harness.behavior.emitThreadEvent("thread.deleted", { thread });

    expect(harness.recheckCount).toBe(4);
  });
});
