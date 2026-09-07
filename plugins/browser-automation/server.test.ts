import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import plugin from "./server.js";
import { rpcContract } from "./contracts.js";

async function setup() {
  const worker = vi.fn(
    async ({ method }: { method: string }): Promise<unknown> =>
      method === "run"
        ? { text: "done", images: [], exitCode: 0 }
        : method === "prepare"
          ? { status: "ready", version: "1.0.0-test", source: "release" }
          : null,
  );
  const host = createFakePluginHost({
    pluginId: "browser-automation",
    agentSkillIds: ["browser-automation"],
    experimental_callHostRpc: worker,
  });
  host.harness.sdk.stub("threads.get", async () =>
    makeThreadResponse({ id: "thread-test" }),
  );
  host.harness.sdk.stub(
    "experimental_desktopBrowsers.listInstances",
    async () => ({
      instances: [
        {
          hostId: "desktop-host",
          instanceId: "desktop",
          generation: "generation",
          label: "Desktop",
        },
      ],
    }),
  );
  host.harness.sdk.stub("experimental_desktopBrowsers.createTab", async () => ({
    tab: {
      tabId: "created",
      threadId: "thread-test",
      url: "about:blank",
      title: "",
      control: null,
      profile: { kind: "automation", id: "profile" },
      presentation: "hidden",
    },
  }));
  host.harness.sdk.stub(
    "experimental_desktopBrowsers.acquireControl",
    async () => ({ leaseId: "lease", expiresAt: Date.now() + 60_000 }),
  );
  host.harness.sdk.stub(
    "experimental_desktopBrowsers.openConnection",
    async () => ({
      hostId: "desktop-host",
      expiresAt: Date.now() + 60_000,
      wsEndpoint: "ws://127.0.0.1:9999/cdp?token=secret",
    }),
  );
  host.harness.sdk.stub(
    "experimental_desktopBrowsers.releaseControl",
    async (input) => {
      expect(Object.keys(input).sort()).toEqual([
        "generation",
        "hostId",
        "instanceId",
        "leaseId",
        "threadId",
      ]);
      return { ok: true };
    },
  );
  host.harness.sdk.stub(
    "experimental_desktopBrowsers.closeTab",
    async (input) => {
      expect(Object.keys(input).sort()).toEqual([
        "generation",
        "hostId",
        "instanceId",
        "tabId",
        "threadId",
      ]);
      return { ok: true };
    },
  );
  host.harness.sdk.stub("experimental_desktopBrowsers.subscribe", () => ({
    dispose() {},
  }));
  host.harness.sdk.stub("experimental_desktopBrowsers.listTabs", async () => ({
    tabs: [
      { tabId: "created", profile: { kind: "automation", id: "profile" } },
    ],
  }));
  await plugin(host.bb);
  async function open(tabId?: string) {
    const result = await host.harness.behavior.callRpc("open", {
      threadId: "thread-test",
      selection: {
        backend: "desktop",
        hostId: "desktop-host",
        instanceId: "desktop",
        ...(tabId ? { tabId } : {}),
      },
    });
    return rpcContract.open.output.parse(result);
  }
  return { ...host, worker, open };
}

describe("server session ownership", () => {
  it("returns browser-host image paths through the CLI without registering tools", async () => {
    const h = await setup();
    try {
      const session = await h.open();
      const images = [
        {
          path: "/tmp/browser-session/tmp/capture.jpg",
          mimeType: "image/jpeg",
          width: 640,
          height: 400,
        },
      ];
      h.worker.mockResolvedValueOnce({ text: "captured", images, exitCode: 0 });
      const result = await h.harness.behavior.runCli(
        ["screenshot", session.id, "--json"],
        { threadId: "thread-test" },
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        text: "captured",
        images,
        exitCode: 0,
        hostId: "desktop-host",
      });
      expect(h.harness.registrations.agentTools).toEqual([]);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
  it("routes to the desktop host without exposing the connection and preserves a handed-off tab", async () => {
    const h = await setup();
    try {
      const session = await h.open("personal");
      expect(JSON.stringify(session)).not.toContain("secret");
      expect(h.worker).toHaveBeenCalledWith(
        expect.objectContaining({
          hostId: "desktop-host",
          method: "open",
          input: expect.objectContaining({
            connectionUrl: "ws://127.0.0.1:9999/cdp?token=secret",
          }),
        }),
      );
      await h.harness.behavior.callRpc("close", {
        threadId: "thread-test",
        sessionId: session.id,
      });
      expect(
        h.harness.sdk.callsTo("experimental_desktopBrowsers.closeTab"),
      ).toHaveLength(0);
      expect(
        h.harness.sdk.callsTo("experimental_desktopBrowsers.releaseControl"),
      ).toHaveLength(1);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
  it("denies cross-thread RPC and CLI access before calling the worker", async () => {
    const h = await setup();
    try {
      const session = await h.open();
      await expect(
        h.harness.behavior.callRpc("run", {
          threadId: "other",
          sessionId: session.id,
          script: "1",
        }),
      ).rejects.toThrow();
      const denied = await h.harness.behavior.runCli(
        ["run", session.id, "--thread", "thread-test", "--script", "1"],
        { threadId: "other" },
      );
      expect(denied.exitCode).toBe(1);
      expect(denied.stderr).toContain("another thread");
      expect(
        h.worker.mock.calls.filter(([call]) => call.method === "run"),
      ).toHaveLength(0);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
  it.each(["thread.archived", "thread.deleted", "thread.failed"] as const)(
    "%s closes only the owning thread's sessions",
    async (event) => {
      const h = await setup();
      try {
        const session = await h.open("personal");
        const other = rpcContract.open.output.parse(
          await h.harness.behavior.callRpc("open", {
            threadId: "other",
            selection: { backend: "local", hostId: "local-host" },
          }),
        );
        await h.harness.behavior.emitThreadEvent("thread.idle", {
          thread: makeThreadResponse({ id: "thread-test" }),
          lastAssistantText: null,
        });
        expect(
          h.worker.mock.calls.filter(([call]) => call.method === "close"),
        ).toHaveLength(0);
        await h.harness.behavior.emitThreadEvent(event, {
          thread: makeThreadResponse({ id: "thread-test" }),
          error: null,
        });
        const own = rpcContract.list.output.parse(
          await h.harness.behavior.callRpc("list", { threadId: "thread-test" }),
        );
        const remaining = rpcContract.list.output.parse(
          await h.harness.behavior.callRpc("list", { threadId: "other" }),
        );
        expect(own.find((entry) => entry.id === session.id)?.state).toBe(
          "closed",
        );
        expect(remaining.find((entry) => entry.id === other.id)?.state).toBe(
          "ready",
        );
        expect(
          h.harness.sdk.callsTo("experimental_desktopBrowsers.closeTab"),
        ).toHaveLength(0);
      } finally {
        await h.harness.lifecycle.dispose();
      }
    },
  );
  it("concurrent stop and close leave the session closed", async () => {
    const h = await setup();
    try {
      const session = await h.open();
      const input = { threadId: "thread-test", sessionId: session.id };
      await Promise.all([
        h.harness.behavior.callRpc("stop", input),
        h.harness.behavior.callRpc("close", input),
      ]);
      const sessions = rpcContract.list.output.parse(
        await h.harness.behavior.callRpc("list", { threadId: "thread-test" }),
      );
      expect(sessions.find((entry) => entry.id === session.id)?.state).toBe(
        "closed",
      );
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
  it("waits for the browser host to finish installing the runtime before opening", async () => {
    const h = await setup();
    try {
      let polls = 0;
      h.worker.mockImplementation(async ({ method }) => {
        if (method === "prepare")
          return ++polls < 3
            ? { status: "installing", detail: `step ${polls}` }
            : { status: "ready", version: "1.0.0-test", source: "release" };
        return null;
      });
      await h.open();
      const methods = h.worker.mock.calls.map(([call]) => call.method);
      expect(methods.filter((method) => method === "prepare")).toHaveLength(3);
      expect(methods.indexOf("open")).toBeGreaterThan(
        methods.lastIndexOf("prepare"),
      );
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
  it("cleans up a newly created tab when worker launch fails", async () => {
    const h = await setup();
    try {
      h.worker.mockImplementation(async ({ method }) => {
        if (method === "open") throw new Error("failed startup");
        if (method === "prepare")
          return { status: "ready", version: "1.0.0-test", source: "release" };
        return null;
      });
      await expect(h.open()).rejects.toThrow("failed startup");
      expect(
        h.harness.sdk.callsTo("experimental_desktopBrowsers.closeTab"),
      ).toHaveLength(1);
      expect(
        h.harness.sdk.callsTo("experimental_desktopBrowsers.releaseControl"),
      ).toHaveLength(1);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
});
