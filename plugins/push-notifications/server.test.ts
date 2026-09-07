import type {
  BbPluginApi,
  PluginThreadEventPayloads,
} from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { EnvHttpProxyAgent } from "undici";
import { describe, expect, it, vi } from "vitest";
import { listPushSubscriptionsOutputSchema } from "./contract.js";
import { createPushNotificationsPlugin } from "./server.js";
import type { ExpoPushMessage, PushSenderFetch } from "./sender.js";

type ThreadResponse = PluginThreadEventPayloads["thread.idle"]["thread"];
type PendingInteraction =
  PluginThreadEventPayloads["interaction.pending"]["interaction"];

const COALESCE_MS = 10;
const EXPO_URL = "http://expo.test/push";

interface FakeExpo {
  fetch: PushSenderFetch;
  requests: ExpoPushMessage[][];
  ticketErrors: Map<string, string>;
  urls: string[];
}

function createFakeExpo(): FakeExpo {
  const requests: ExpoPushMessage[][] = [];
  const ticketErrors = new Map<string, string>();
  const urls: string[] = [];
  const fetch: PushSenderFetch = async (url, init) => {
    urls.push(url);
    expect(init.dispatcher).toBeInstanceOf(EnvHttpProxyAgent);
    const messages = JSON.parse(init.body) as ExpoPushMessage[];
    requests.push(messages);
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          data: messages.map((message) => {
            const error = ticketErrors.get(message.to);
            return error === undefined
              ? { status: "ok", id: `ticket-${message.to}` }
              : { status: "error", details: { error } };
          }),
        }),
    };
  };
  return { fetch, requests, ticketErrors, urls };
}

function pendingQuestion(threadId: string, prompt: string): PendingInteraction {
  return {
    id: `interaction-${threadId}`,
    threadId,
    status: "pending",
    statusReason: null,
    createdAt: 1,
    expiresAt: null,
    resolvedAt: null,
    turnId: `turn-${threadId}`,
    providerId: "codex",
    providerThreadId: `provider-${threadId}`,
    providerRequestId: `request-${threadId}`,
    origin: {
      kind: "provider",
      providerId: "codex",
      providerThreadId: `provider-${threadId}`,
      providerRequestId: `request-${threadId}`,
    },
    payload: {
      kind: "user_question",
      questions: [
        {
          id: "question-1",
          prompt,
          multiSelect: false,
          allowFreeText: true,
        },
      ],
    },
    resolution: null,
  };
}

interface SetupOptions {
  appUrl?: string | null;
  expo?: FakeExpo;
  fetch?: PushSenderFetch;
  now?: () => number;
}

async function setup(options: SetupOptions = {}) {
  const expo = options.expo ?? createFakeExpo();
  const threads = new Map<string, ThreadResponse>();
  const interactions = new Map<string, PendingInteraction[]>();
  let nextId = 1;
  const fake = createFakePluginHost({
    pluginId: "push-notifications",
    ...(options.appUrl === undefined ? {} : { appUrl: options.appUrl }),
    settings: { expoPushUrl: EXPO_URL },
    sdk: {
      threads: {
        get: async ({ threadId }) => {
          const thread = threads.get(threadId);
          if (!thread) throw new Error("Thread not found");
          return thread;
        },
        interactions: {
          list: async ({ threadId }) => interactions.get(threadId) ?? [],
        },
      },
    },
  });
  await createPushNotificationsPlugin({
    coalesceMs: COALESCE_MS,
    createId: () => `subscription-${nextId++}`,
    fetch: options.fetch ?? expo.fetch,
    ...(options.now === undefined ? {} : { now: options.now }),
  })(fake.bb);

  async function addSubscription(
    expoPushToken = "ExponentPushToken[phone]",
    deviceLabel = "Phone",
  ) {
    return fake.harness.behavior.callRpc("pushSubscriptions.add", {
      expoPushToken,
      platform: "ios",
      deviceLabel,
    });
  }

  function setThread(overrides: Partial<ThreadResponse> = {}) {
    const thread = makeThreadResponse({
      id: `thread-${threads.size + 1}`,
      projectId: "project-1",
      status: "idle",
      title: "Fix the flaky test",
      latestAttentionAt: 100,
      ...overrides,
    });
    threads.set(thread.id, thread);
    return thread;
  }

  const service = fake.harness.behavior.runService("push-sender");

  async function cleanup() {
    service.controller.abort();
    await service.done;
    await fake.harness.lifecycle.dispose();
  }

  return {
    ...fake,
    addSubscription,
    cleanup,
    expo,
    interactions,
    setThread,
    threads,
  };
}

async function waitForCoalesce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, COALESCE_MS * 4));
}

describe("push subscription RPC and CLI", () => {
  it("upserts by token, redacts lists, and reports stable RPC errors", async () => {
    const host = await setup();
    try {
      await expect(host.addSubscription()).resolves.toEqual({
        id: "subscription-1",
        created: true,
      });
      await expect(
        host.addSubscription("ExponentPushToken[phone]", "New phone name"),
      ).resolves.toEqual({ id: "subscription-1", created: false });

      const listed = await host.harness.behavior.callRpc(
        "pushSubscriptions.list",
        {},
      );
      expect(listed).toEqual({
        subscriptions: [
          expect.objectContaining({
            id: "subscription-1",
            deviceLabel: "New phone name",
            tokenSuffix: "phone]",
          }),
        ],
      });
      expect(JSON.stringify(listed)).not.toContain("ExponentPushToken");

      await expect(
        host.harness.behavior.callRpc("pushSubscriptions.add", {
          expoPushToken: "token",
          platform: "windows",
          deviceLabel: "PC",
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      await expect(
        host.harness.behavior.callRpc("pushSubscriptions.remove", {
          id: "missing",
        }),
      ).rejects.toMatchObject({
        code: "handler_error",
        message: "Push subscription not found: missing",
      });
      await expect(
        host.harness.behavior.callRpc("pushSubscriptions.remove", {
          id: "subscription-1",
        }),
      ).resolves.toEqual({ ok: true });
    } finally {
      await host.cleanup();
    }
  });

  it("provides list, add, remove, and status commands", async () => {
    const host = await setup();
    try {
      await expect(
        host.harness.behavior.runCli([
          "add",
          "--platform",
          "ios",
          "--label",
          "Phone",
          "--token",
          "ExponentPushToken[phone]",
        ]),
      ).resolves.toMatchObject({
        exitCode: 0,
        stdout: "Registered push device subscription-1",
      });
      const list = await host.harness.behavior.runCli(["list", "--json"]);
      expect(JSON.parse(list.stdout)).toEqual({
        subscriptions: [
          expect.objectContaining({
            id: "subscription-1",
            tokenSuffix: "phone]",
          }),
        ],
      });
      expect(list.stdout).not.toContain("ExponentPushToken");
      const status = await host.harness.behavior.runCli(["status", "--json"]);
      expect(JSON.parse(status.stdout)).toEqual({
        enabled: true,
        mobileEnabled: true,
        webEnabled: true,
        desktopEnabled: true,
        subscriptionCount: 1,
        relayUrl: EXPO_URL,
        lastSendOutcome: { status: "never" },
      });
      await expect(
        host.harness.behavior.runCli(["remove", "subscription-1"]),
      ).resolves.toMatchObject({
        exitCode: 0,
        stdout: "Removed push device subscription-1",
      });
    } finally {
      await host.cleanup();
    }
  });
});

describe("push sender", () => {
  it("sends a root idle preview to each device and reads the relay setting at flush", async () => {
    const host = await setup();
    try {
      await host.addSubscription();
      await host.addSubscription("ExponentPushToken[tablet]", "Tablet");
      const thread = host.setThread();

      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "Done: the timer race is fixed.\nMore details.",
      });
      await host.harness.behavior.setSettings({
        expoPushUrl: "http://expo.test/changed",
      });

      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(1));
      expect(host.expo.urls).toEqual(["http://expo.test/changed"]);
      expect(host.expo.requests[0]).toHaveLength(2);
      expect(host.expo.requests[0]?.[0]).toMatchObject({
        title: "Fix the flaky test",
        body: "Done: the timer race is fixed.",
        data: {
          kind: "turn-finished",
          projectId: "project-1",
          threadId: thread.id,
        },
        sound: "default",
        channelId: "default",
        priority: "high",
      });
      expect(host.expo.requests[0]?.[0]?.data).not.toHaveProperty("serverUrl");
      await vi.waitFor(async () => {
        const result = await host.harness.behavior.runCli(["status", "--json"]);
        expect(JSON.parse(result.stdout).lastSendOutcome).toMatchObject({
          status: "sent",
          sentCount: 2,
        });
      });
    } finally {
      await host.cleanup();
    }
  });

  it("includes the configured public server URL", async () => {
    const host = await setup({ appUrl: "https://bb.example.test" });
    try {
      await host.addSubscription();
      const thread = host.setThread();

      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "Done",
      });

      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(1));
      expect(host.expo.requests[0]?.[0]?.data).toEqual({
        kind: "turn-finished",
        projectId: "project-1",
        serverUrl: "https://bb.example.test",
        threadId: thread.id,
      });
    } finally {
      await host.cleanup();
    }
  });

  it("drops child, read, hidden, archived, and stale-status events", async () => {
    let now = 1_000;
    const host = await setup({ now: () => now });
    try {
      await host.addSubscription();
      const child = host.setThread({ parentThreadId: "parent-1" });
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: child,
        lastAssistantText: "Child done",
      });

      const read = host.setThread({ id: "thread-read" });
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: read,
        lastAssistantText: "Read done",
      });
      host.threads.set(read.id, {
        ...read,
        latestAttentionAt: now + 1,
        lastReadAt: now + 1,
      });

      const stale = host.setThread({ id: "thread-stale" });
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: stale,
        lastAssistantText: "Stale done",
      });
      host.threads.set(stale.id, { ...stale, status: "active" });

      const hidden = host.setThread({ id: "thread-hidden" });
      await host.harness.behavior.emitThreadEvent("thread.failed", {
        thread: hidden,
        error: "Failed",
      });
      host.threads.set(hidden.id, {
        ...hidden,
        status: "error",
        visibility: "hidden",
      });

      const archived = host.setThread({ id: "thread-archived" });
      await host.harness.behavior.emitThreadEvent("thread.failed", {
        thread: archived,
        error: "Failed",
      });
      host.threads.set(archived.id, {
        ...archived,
        status: "error",
        archivedAt: now,
      });
      now += 2;
      await waitForCoalesce();
      expect(host.expo.requests).toEqual([]);
    } finally {
      await host.cleanup();
    }
  });

  it("coalesces interaction and idle events, prefers the interaction, and checks it again", async () => {
    const host = await setup();
    try {
      await host.addSubscription();
      const thread = host.setThread({ status: "active", title: "Release" });
      const interaction = pendingQuestion(
        thread.id,
        "Ship to staging or production?",
      );
      host.interactions.set(thread.id, [interaction]);

      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: { ...thread, status: "idle" },
        lastAssistantText: "Done",
      });
      await host.harness.behavior.emitThreadEvent("interaction.pending", {
        thread,
        interaction,
      });

      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(1));
      expect(host.expo.requests[0]).toEqual([
        expect.objectContaining({
          title: "Release",
          body: "Ship to staging or production?",
          data: expect.objectContaining({ kind: "pending-interaction" }),
        }),
      ]);

      const answered = host.setThread({ id: "thread-answered" });
      const answeredInteraction = pendingQuestion(answered.id, "Continue?");
      host.interactions.set(answered.id, [answeredInteraction]);
      await host.harness.behavior.emitThreadEvent("interaction.pending", {
        thread: answered,
        interaction: answeredInteraction,
      });
      host.interactions.set(answered.id, []);
      await waitForCoalesce();
      expect(host.expo.requests).toHaveLength(1);
    } finally {
      await host.cleanup();
    }
  });

  it("batches devices and removes rows that Expo rejects as unregistered", async () => {
    const host = await setup();
    try {
      for (let index = 0; index < 101; index += 1) {
        await host.addSubscription(
          `ExponentPushToken[device-${index}]`,
          `Device ${index}`,
        );
      }
      host.expo.ticketErrors.set(
        "ExponentPushToken[device-100]",
        "DeviceNotRegistered",
      );
      const thread = host.setThread({ status: "error" });
      await host.harness.behavior.emitThreadEvent("thread.failed", {
        thread,
        error: "Provider exited with code 1\nStack",
      });

      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(2));
      expect(host.expo.requests.map((batch) => batch.length)).toEqual([100, 1]);
      await vi.waitFor(async () => {
        const listed = listPushSubscriptionsOutputSchema.parse(
          await host.harness.behavior.callRpc("pushSubscriptions.list", {}),
        );
        expect(listed.subscriptions).toHaveLength(100);
      });
      expect(JSON.stringify(host.harness.logEntries)).not.toContain(
        "ExponentPushToken",
      );
    } finally {
      await host.cleanup();
    }
  });

  it("warns once per hour for network failures and logs only row ids", async () => {
    let now = 10_000;
    const host = await setup({
      now: () => now,
      fetch: async () => {
        throw new Error("ECONNREFUSED with ExponentPushToken[secret]");
      },
    });
    try {
      await host.addSubscription();
      const trigger = async (id: string) => {
        const thread = host.setThread({ id, status: "error" });
        await host.harness.behavior.emitThreadEvent("thread.failed", {
          thread,
          error: "Provider failed",
        });
        await waitForCoalesce();
      };

      await trigger("thread-first");
      now += 3_599_999;
      await trigger("thread-second");
      now += 1;
      await trigger("thread-third");

      const warnings = host.harness.logEntries.filter(
        (entry) =>
          entry.level === "warn" &&
          entry.message.startsWith("Expo push request failed"),
      );
      expect(warnings).toHaveLength(2);
      expect(warnings[0]?.message).toContain("subscription-1");
      expect(JSON.stringify(host.harness.logEntries)).not.toContain(
        "ExponentPushToken",
      );
    } finally {
      await host.cleanup();
    }
  });
});

describe("web and desktop delivery", () => {
  it("delivers without mobile subscriptions and applies channel changes immediately", async () => {
    const host = await setup();
    try {
      const thread = host.setThread();
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "Done",
      });
      await waitForCoalesce();
      expect(host.harness.realtimeSignals).toEqual([
        {
          channel: "notification",
          payload: expect.objectContaining({
            title: thread.title,
            body: "Done",
            threadId: thread.id,
            channels: ["web", "desktop"],
          }),
        },
      ]);
      await host.addSubscription();
      await host.harness.behavior.setSettings({
        mobileEnabled: false,
        webEnabled: false,
      });
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "Desktop only",
      });
      await waitForCoalesce();
      expect(host.harness.realtimeSignals.at(-1)?.payload).toMatchObject({
        channels: ["desktop"],
      });
      expect(host.expo.requests).toHaveLength(0);
      await host.harness.behavior.setSettings({ desktopEnabled: false });
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "Disabled",
      });
      await waitForCoalesce();
      expect(host.harness.realtimeSignals).toHaveLength(2);
    } finally {
      await host.cleanup();
    }
  });

  it("does not broadcast read, archived, or resumed threads", async () => {
    const host = await setup();
    try {
      for (const overrides of [
        { lastReadAt: Date.now() + 60_000 },
        { archivedAt: 100 },
        { status: "active" as const },
      ]) {
        const thread = host.setThread(overrides);
        await host.harness.behavior.emitThreadEvent("thread.idle", {
          thread,
          lastAssistantText: "Stale",
        });
      }
      await waitForCoalesce();
      expect(host.harness.realtimeSignals).toHaveLength(0);
    } finally {
      await host.cleanup();
    }
  });

  it("routes CLI and RPC tests only to the selected enabled channel", async () => {
    const host = await setup();
    try {
      expect(await host.harness.behavior.runCli(["test", "web"])).toMatchObject(
        { exitCode: 0 },
      );
      expect(host.harness.realtimeSignals.at(-1)?.payload).toMatchObject({
        channels: ["web"],
        threadId: null,
      });
      await host.harness.behavior.callRpc("notifications.test", {
        channel: "desktop",
      });
      expect(host.harness.realtimeSignals.at(-1)?.payload).toMatchObject({
        channels: ["desktop"],
      });
      await host.harness.behavior.setSettings({ desktopEnabled: false });
      expect(
        await host.harness.behavior.runCli(["test", "desktop"]),
      ).toMatchObject({ exitCode: 1 });
      await expect(
        host.harness.behavior.callRpc("notifications.test", {
          channel: "desktop",
        }),
      ).rejects.toThrow("disabled");
      await expect(
        host.harness.behavior.callRpc("notifications.test", { channel: "ios" }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(host.harness.realtimeSignals).toHaveLength(2);
    } finally {
      await host.cleanup();
    }
  });
});
