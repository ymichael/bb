import { getStoredThreadTabs, markThreadDeleted } from "@bb/db";
import {
  desktopBrowserLeaseSchema,
  desktopBrowserResultSchemas,
  type DesktopBrowserTab,
  type HostDaemonOnlineRpcRequestMessage,
} from "@bb/host-daemon-contract";
import {
  desktopBrowserScopeSchema,
  threadTabsSchema,
} from "@bb/server-contract";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { revokeThreadDesktopBrowserControl } from "../src/services/desktop-browsers.js";
import { onDaemonSocketMessage } from "../src/ws/daemon-protocol.js";
import {
  registerHostRpcResponder,
  type HostRpcHandlerResult,
} from "./helpers/host-rpc.js";
import {
  seedHostSession,
  seedThread,
  seedThreadFixture,
} from "./helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "./helpers/test-app.js";

const leaseSchema = desktopBrowserScopeSchema
  .extend(desktopBrowserLeaseSchema.shape)
  .extend({ tabIds: z.array(z.string()) });

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(harness: TestAppHarness) {
  const seeded = seedThreadFixture(harness);
  const scope = {
    hostId: seeded.host.id,
    instanceId: "desktop-window",
    generation: "window-generation",
    threadId: seeded.thread.id,
  };
  let tabs: DesktopBrowserTab[] = [
    {
      tabId: "automation-tab",
      threadId: scope.threadId,
      url: "https://example.com",
      title: "Example",
      profile: { kind: "automation", id: "automation-profile" },
      presentation: "hidden",
      control: null,
    },
  ];
  let intercept: (
    request: HostDaemonOnlineRpcRequestMessage,
  ) => HostRpcHandlerResult | Promise<HostRpcHandlerResult> | null = () => null;
  const responder = registerHostRpcResponder(harness, {
    hostId: seeded.host.id,
    sessionId: seeded.session.id,
    handle(request) {
      const intercepted = intercept(request);
      if (intercepted !== null) return intercepted;
      const command = request.command;
      switch (command.type) {
        case "thread.stop":
          return { ok: true, result: { providerCheckpointId: null } };
        case "desktop.browser.list_instances":
          return {
            ok: true,
            result: {
              instances: [
                {
                  instanceId: scope.instanceId,
                  generation: scope.generation,
                  label: "Desktop",
                },
              ],
            },
          };
        case "desktop.browser.list_tabs":
          return { ok: true, result: { tabs } };
        case "desktop.browser.create_tab": {
          const tab: DesktopBrowserTab = {
            tabId: command.tabId,
            threadId: command.threadId,
            url: command.url,
            title: "",
            profile: command.profile,
            presentation: command.presentation,
            control: null,
          };
          return { ok: true, result: { tab } };
        }
        case "desktop.browser.acquire_control":
          return {
            ok: true,
            result: {
              lease: {
                leaseId: command.leaseId,
                controllerLabel: command.controllerLabel,
                expiresAt: command.expiresAt,
              },
            },
          };
        case "desktop.browser.open_connection":
          return {
            ok: true,
            result: {
              wsEndpoint: "ws://127.0.0.1:43123/scoped-secret",
              expiresAt: Date.now() + 300000,
            },
          };
        case "desktop.browser.release_control":
        case "desktop.browser.close_tab":
        case "desktop.browser.reveal_tab":
          return { ok: true, result: { ok: true } };
        case "desktop.browser.capture_tab":
          return {
            ok: true,
            result: {
              mimeType: "image/jpeg",
              width: 800,
              height: 600,
              base64: "aW1hZ2U=",
            },
          };
        default:
          throw new Error(`Unexpected host RPC ${command.type}`);
      }
    },
  });
  function post(
    action: string,
    body: object = scope,
    headers: Record<string, string> = {},
  ) {
    return harness.app.request(`/api/v1/desktop-browsers/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }
  function stored(threadId = scope.threadId) {
    const row = getStoredThreadTabs(harness.db, threadId);
    return row ? threadTabsSchema.parse(JSON.parse(row.tabsJson)) : [];
  }
  function change(
    overrides: Partial<typeof scope>,
    nativeTabs: DesktopBrowserTab[],
    sessionId = seeded.session.id,
  ) {
    const target = { ...scope, ...overrides };
    const socket = { close: vi.fn(), send: vi.fn() };
    onDaemonSocketMessage(harness.deps, {
      hostId: target.hostId,
      sessionId,
      socket,
      raw: JSON.stringify({
        type: "desktop-browser.changed",
        instanceId: target.instanceId,
        generation: target.generation,
        threadId: target.threadId,
        tabs: nativeTabs,
      }),
    });
    return socket;
  }
  return {
    ...seeded,
    scope,
    responder,
    post,
    stored,
    change,
    tab: () => tabs[0]!,
    setTabs(value: DesktopBrowserTab[]) {
      tabs = value;
    },
    intercept(handler: typeof intercept) {
      intercept = handler;
    },
    async acquire(extra: object = {}) {
      const response = await post("acquire", {
        ...scope,
        tabIds: [tabs[0]!.tabId],
        controllerLabel: "Test agent",
        ...extra,
      });
      expect(response.status).toBe(200);
      return leaseSchema.parse(await response.json());
    },
    leaseRequest(leaseId: string) {
      return { ...scope, leaseId };
    },
    stop() {
      return harness.app.request(`/api/v1/threads/${scope.threadId}/stop`, {
        method: "POST",
      });
    },
  };
}

async function withBrowserTest(
  run: (
    test: ReturnType<typeof fixture>,
    harness: TestAppHarness,
  ) => Promise<void>,
) {
  await withTestHarness(async (harness) => {
    const test = fixture(harness);
    try {
      await run(test, harness);
    } finally {
      await revokeThreadDesktopBrowserControl(
        harness.deps,
        test.scope.threadId,
      );
      test.responder.unregister();
    }
  });
}

describe("desktop browser public API", () => {
  it("blocks hostile origins and simple requests before any host RPC", async () => {
    await withBrowserTest(async (test) => {
      for (const action of [
        "instances",
        "tabs",
        "create",
        "acquire",
        "connection",
        "release",
        "reveal",
        "close",
        "capture",
      ]) {
        const body =
          action === "instances"
            ? { hostId: test.scope.hostId }
            : action === "acquire"
              ? {
                  ...test.scope,
                  tabIds: [test.tab().tabId],
                  controllerLabel: "Agent",
                }
              : action === "connection"
                ? test.leaseRequest("lease")
                : ["close", "reveal", "capture"].includes(action)
                  ? { ...test.scope, tabId: test.tab().tabId }
                  : test.scope;
        expect(
          (await test.post(action, body, { origin: "https://evil.example" }))
            .status,
          action,
        ).toBe(403);
        expect(
          (await test.post(action, body, { "content-type": "text/plain" }))
            .status,
          action,
        ).toBe(415);
      }
      expect(test.responder.requests).toEqual([]);
    });
  });

  it("requires real threads instead of synthetic panel IDs before issuing RPC", async () => {
    await withBrowserTest(async (test) => {
      for (const threadId of ["__global__", "panel-browser", "thr_missing"]) {
        for (const action of [
          "tabs",
          "create",
          "capture",
          "reveal",
          "close",
          "acquire",
          "connection",
        ]) {
          const body =
            action === "acquire"
              ? {
                  ...test.scope,
                  threadId,
                  tabIds: [test.tab().tabId],
                  controllerLabel: "Agent",
                }
              : action === "connection"
                ? { ...test.scope, threadId, leaseId: "lease" }
                : ["capture", "reveal", "close"].includes(action)
                  ? { ...test.scope, threadId, tabId: test.tab().tabId }
                  : { ...test.scope, threadId };
          expect(
            (await test.post(action, body)).status,
            `${action} ${threadId}`,
          ).toBe(404);
        }
        expect(
          (
            await test.post("release", {
              ...test.scope,
              threadId,
              leaseId: "missing-lease",
            })
          ).status,
        ).toBe(200);
      }
      expect(test.responder.requests).toEqual([]);
    });
  });

  it("creates an isolated automation profile by default and persists its desktop target", async () => {
    await withBrowserTest(async (test) => {
      const response = await test.post("create");
      expect(response.status).toBe(200);
      const { tab } = desktopBrowserResultSchemas[
        "desktop.browser.create_tab"
      ].parse(await response.json());
      const command = test.responder.requests[0]?.command;
      expect(command).toMatchObject({
        type: "desktop.browser.create_tab",
        instanceId: test.scope.instanceId,
        generation: test.scope.generation,
        threadId: test.scope.threadId,
        url: "about:blank",
        presentation: "hidden",
        profile: { kind: "automation", id: expect.any(String) },
      });
      expect(tab.tabId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(tab.profile).toEqual({
        kind: "automation",
        id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      });
      expect(test.stored()).toEqual([
        expect.objectContaining({
          id: tab.tabId,
          kind: "browser",
          url: "about:blank",
          desktopTarget: {
            hostId: test.scope.hostId,
            instanceId: test.scope.instanceId,
            generation: test.scope.generation,
          },
        }),
      ]);
      expect(
        (
          await test.post("create", {
            ...test.scope,
            profile: { kind: "personal" },
          })
        ).status,
      ).toBe(400);
      expect(test.responder.requests).toHaveLength(1);
      expect(
        (await test.post("close", { ...test.scope, tabId: tab.tabId })).status,
      ).toBe(200);
      expect(test.stored()).toEqual([]);
    });
  });

  it("lists explicit native tab control metadata and scopes every operation to the thread", async () => {
    await withBrowserTest(async (test) => {
      const tab = {
        ...test.tab(),
        control: {
          leaseId: "native-lease",
          controllerLabel: "Someone else",
          expiresAt: Date.now() + 1000,
        },
      };
      test.setTabs([tab]);
      const response = await test.post("tabs");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ tabs: [tab] });
      for (const action of ["reveal", "capture"]) {
        const response = await test.post(action, {
          ...test.scope,
          tabId: tab.tabId,
        });
        expect(response.status).toBe(200);
        if (action === "capture") {
          expect(response.headers.get("cache-control")).toBe("no-store");
          expect(await response.json()).toEqual({
            mimeType: "image/jpeg",
            width: 800,
            height: 600,
            base64: "aW1hZ2U=",
          });
        }
      }
      for (const { command } of test.responder.requests) {
        expect(command).toMatchObject({
          instanceId: test.scope.instanceId,
          generation: test.scope.generation,
          threadId: test.scope.threadId,
        });
      }
    });
  });

  it("never exposes a different thread's tabs returned by the native transport", async () => {
    await withBrowserTest(async (test, harness) => {
      const other = seedThread(harness.deps, {
        projectId: test.project.id,
        environmentId: test.environment.id,
      });
      test.setTabs([{ ...test.tab(), threadId: other.id }]);
      const response = await test.post("tabs");
      const body: unknown = await response.json();
      if (response.status === 200) {
        expect(
          desktopBrowserResultSchemas["desktop.browser.list_tabs"].parse(body)
            .tabs,
        ).toEqual([]);
      } else {
        expect(response.status).toBeGreaterThanOrEqual(400);
      }
      const acquire = await test.post("acquire", {
        ...test.scope,
        tabIds: [test.tab().tabId],
        controllerLabel: "Agent",
      });
      expect(acquire.status).toBeGreaterThanOrEqual(400);
      expect(
        test.responder.requests.some(
          ({ command }) => command.type === "desktop.browser.acquire_control",
        ),
      ).toBe(false);
    });
  });

  it("requires explicit personal handoff and rejects missing or foreign tabs", async () => {
    await withBrowserTest(async (test) => {
      const tab = { ...test.tab(), profile: { kind: "personal" as const } };
      test.setTabs([tab]);
      const denied = await test.post("acquire", {
        ...test.scope,
        tabIds: [tab.tabId],
        controllerLabel: "Agent",
      });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({
        code: "desktop_personal_handoff_required",
      });
      expect(
        (
          await test.post("acquire", {
            ...test.scope,
            tabIds: ["missing"],
            controllerLabel: "Agent",
            allowPersonal: true,
          })
        ).status,
      ).toBe(403);
      expect(
        test.responder.requests.every(
          ({ command }) => command.type === "desktop.browser.list_tabs",
        ),
      ).toBe(true);
      const lease = await test.acquire({ allowPersonal: true });
      expect(lease.tabIds).toEqual([tab.tabId]);
      expect(lease.controllerLabel).toBe("Test agent");
      expect(lease.expiresAt - Date.now()).toBeGreaterThan(290000);
    });
  });

  it("preserves native exclusive-control errors and does not retain a failed grant", async () => {
    await withBrowserTest(async (test) => {
      test.intercept(({ command }) =>
        command.type === "desktop.browser.acquire_control"
          ? {
              ok: false,
              errorCode: "desktop_control_conflict",
              errorMessage: "Tab is already controlled",
            }
          : null,
      );
      const response = await test.post("acquire", {
        ...test.scope,
        tabIds: [test.tab().tabId],
        controllerLabel: "Agent",
      });
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({
        code: "desktop_control_conflict",
        message: "Tab is already controlled",
      });
      const command = test.responder.requests.find(
        ({ command }) => command.type === "desktop.browser.acquire_control",
      )?.command;
      if (!command || command.type !== "desktop.browser.acquire_control")
        throw new Error("Expected acquire RPC");
      expect(
        test.responder.requests.some(
          ({ command }) => command.type === "desktop.browser.reveal_tab",
        ),
      ).toBe(false);
      const before = test.responder.requests.length;
      expect(
        (await test.post("connection", test.leaseRequest(command.leaseId)))
          .status,
      ).toBe(409);
      expect(test.responder.requests).toHaveLength(before);
    });
  });

  it("reveals the selected tab after control succeeds and releases control if reveal fails", async () => {
    await withBrowserTest(async (test) => {
      const lease = await test.acquire();
      const commands = test.responder.requests.map(({ command }) => command);
      const acquired = commands.findIndex(
        (command) => command.type === "desktop.browser.acquire_control",
      );
      const revealed = commands.findIndex(
        (command) => command.type === "desktop.browser.reveal_tab",
      );
      expect(revealed).toBeGreaterThan(acquired);
      expect(commands[revealed]).toMatchObject({
        type: "desktop.browser.reveal_tab",
        threadId: test.scope.threadId,
        tabId: test.tab().tabId,
      });
      await test.post("release", test.leaseRequest(lease.leaseId));
      test.intercept(({ command }) =>
        command.type === "desktop.browser.reveal_tab"
          ? {
              ok: false,
              errorCode: "reveal_failed",
              errorMessage: "Window closed",
            }
          : null,
      );
      const response = await test.post("acquire", {
        ...test.scope,
        tabIds: [test.tab().tabId],
        controllerLabel: "Agent",
      });
      expect(response.status).toBe(502);
      expect(test.responder.requests.at(-1)?.command.type).toBe(
        "desktop.browser.release_control",
      );
    });
  });

  it("binds open and release to host, instance, generation, thread, and granted tabs", async () => {
    await withBrowserTest(async (test, harness) => {
      const lease = await test.acquire();
      const other = seedThread(harness.deps, {
        projectId: test.project.id,
        environmentId: test.environment.id,
      });
      const otherHost = seedHostSession(harness.deps);
      for (const override of [
        { hostId: otherHost.host.id },
        { instanceId: "other-window" },
        { generation: "old" },
        { threadId: other.id },
      ]) {
        const before = test.responder.requests.length;
        expect(
          (
            await test.post("connection", {
              ...test.leaseRequest(lease.leaseId),
              ...override,
            })
          ).status,
        ).toBe(409);
        expect(
          (
            await test.post("release", {
              ...test.leaseRequest(lease.leaseId),
              ...override,
            })
          ).status,
        ).toBe(403);
        expect(test.responder.requests).toHaveLength(before);
      }
      const connection = await test.post(
        "connection",
        test.leaseRequest(lease.leaseId),
      );
      expect(connection.status).toBe(200);
      expect(connection.headers.get("cache-control")).toBe("no-store");
      expect(await connection.json()).toEqual({
        hostId: test.scope.hostId,
        wsEndpoint: "ws://127.0.0.1:43123/scoped-secret",
        expiresAt: lease.expiresAt,
      });
      expect(test.responder.requests.at(-1)?.command).toEqual({
        type: "desktop.browser.open_connection",
        instanceId: test.scope.instanceId,
        generation: test.scope.generation,
        threadId: test.scope.threadId,
        leaseId: lease.leaseId,
        tabIds: [test.tab().tabId],
      });
      expect(
        (
          await test.post("connection", {
            ...test.leaseRequest(lease.leaseId),
            tabIds: ["ungranted-tab"],
          })
        ).status,
      ).toBe(400);
      expect(
        (await test.post("release", test.leaseRequest(lease.leaseId))).status,
      ).toBe(200);
      expect(
        (await test.post("connection", test.leaseRequest(lease.leaseId)))
          .status,
      ).toBe(409);
    });
  });

  it("releases an existing native lease after its thread is deleted and keeps repeated cleanup idempotent", async () => {
    await withBrowserTest(async (test, harness) => {
      const lease = await test.acquire();
      markThreadDeleted(harness.db, harness.hub, {
        threadId: test.scope.threadId,
      });
      const before = test.responder.requests.length;
      expect(
        (await test.post("connection", test.leaseRequest(lease.leaseId)))
          .status,
      ).toBe(404);
      expect(
        (await test.post("release", test.leaseRequest(lease.leaseId))).status,
      ).toBe(200);
      expect(
        test.responder.requests.slice(before).map(({ command }) => command),
      ).toEqual([
        {
          type: "desktop.browser.release_control",
          instanceId: test.scope.instanceId,
          generation: test.scope.generation,
          threadId: test.scope.threadId,
          leaseId: lease.leaseId,
        },
      ]);
      expect(
        (await test.post("release", test.leaseRequest(lease.leaseId))).status,
      ).toBe(200);
      expect(test.responder.requests).toHaveLength(before + 1);
    });
  });

  it("revokes expired control at the native host and denies subsequent connections", async () => {
    await withBrowserTest(async (test) => {
      const lease = await test.acquire({ ttlMs: 1000 });
      await vi.waitFor(
        () => {
          expect(
            test.responder.requests.some(
              ({ command }) =>
                command.type === "desktop.browser.release_control" &&
                command.leaseId === lease.leaseId,
            ),
          ).toBe(true);
        },
        { timeout: 2500 },
      );
      expect(
        (await test.post("connection", test.leaseRequest(lease.leaseId)))
          .status,
      ).toBe(409);
      expect(
        test.responder.requests.some(
          ({ command }) => command.type === "desktop.browser.open_connection",
        ),
      ).toBe(false);
    });
  });

  it("thread stop revokes a live lease and a native acquire completing after stop", async () => {
    await withBrowserTest(async (test) => {
      const lease = await test.acquire();
      expect((await test.stop()).status).toBe(200);
      expect(
        test.responder.requests.some(
          ({ command }) =>
            command.type === "desktop.browser.release_control" &&
            command.leaseId === lease.leaseId,
        ),
      ).toBe(true);
      expect(
        (await test.post("connection", test.leaseRequest(lease.leaseId)))
          .status,
      ).toBe(409);
      const gate = deferred<HostRpcHandlerResult>();
      const started = deferred<void>();
      test.intercept(({ command }) => {
        if (command.type !== "desktop.browser.acquire_control") return null;
        started.resolve();
        return gate.promise;
      });
      const acquiring = test.post("acquire", {
        ...test.scope,
        tabIds: [test.tab().tabId],
        controllerLabel: "Delayed agent",
      });
      await started.promise;
      expect((await test.stop()).status).toBe(200);
      const command = test.responder.requests
        .filter(
          ({ command }) => command.type === "desktop.browser.acquire_control",
        )
        .at(-1)?.command;
      if (!command || command.type !== "desktop.browser.acquire_control")
        throw new Error("Expected delayed acquire");
      gate.resolve({
        ok: true,
        result: {
          lease: {
            leaseId: command.leaseId,
            controllerLabel: command.controllerLabel,
            expiresAt: command.expiresAt,
          },
        },
      });
      expect((await acquiring).status).toBe(409);
      expect(
        test.responder.requests.filter(
          ({ command: value }) =>
            value.type === "desktop.browser.release_control" &&
            value.leaseId === command.leaseId,
        ),
      ).toHaveLength(2);
    });
  });

  it("a stop during the tab lookup cancels the pending acquisition before any native grant", async () => {
    await withBrowserTest(async (test) => {
      const gate = deferred<HostRpcHandlerResult>();
      const started = deferred<void>();
      test.intercept(({ command }) => {
        if (command.type !== "desktop.browser.list_tabs") return null;
        started.resolve();
        return gate.promise;
      });
      const acquiring = test.post("acquire", {
        ...test.scope,
        tabIds: [test.tab().tabId],
        controllerLabel: "Delayed agent",
      });
      await started.promise;
      expect((await test.stop()).status).toBe(200);
      gate.resolve({ ok: true, result: { tabs: [test.tab()] } });
      expect((await acquiring).status).toBe(409);
      expect(
        test.responder.requests.some(
          ({ command }) => command.type === "desktop.browser.acquire_control",
        ),
      ).toBe(false);
    });
  });

  it("persists authenticated native snapshots without overwriting other windows or threads", async () => {
    await withBrowserTest(async (test, harness) => {
      const other = seedThread(harness.deps, {
        projectId: test.project.id,
        environmentId: test.environment.id,
      });
      const original = test.tab();
      expect(test.change({}, [original]).close).not.toHaveBeenCalled();
      expect(test.stored()).toEqual([
        expect.objectContaining({
          id: original.tabId,
          desktopTarget: {
            hostId: test.scope.hostId,
            instanceId: test.scope.instanceId,
            generation: test.scope.generation,
          },
        }),
      ]);
      test.change({ instanceId: "other-window" }, [
        { ...original, url: "https://wrong-window.example" },
      ]);
      const otherHost = seedHostSession(harness.deps);
      test.change(
        { hostId: otherHost.host.id },
        [{ ...original, url: "https://wrong-host.example" }],
        otherHost.session.id,
      );
      expect(
        test.stored().find((tab) => tab.id === original.tabId),
      ).toMatchObject({ url: original.url });
      test.change({}, [
        { ...original, tabId: "foreign-tab", threadId: other.id },
      ]);
      expect(test.stored(other.id)).toEqual([]);
      test.change({}, [original, { ...original, tabId: "second-tab" }]);
      expect(
        test.stored().find((tab) => tab.id === original.tabId),
      ).toMatchObject({ url: original.url });
      test.change({ instanceId: "other-window" }, []);
      expect(test.stored()).toHaveLength(2);
      test.change({}, [
        { ...original, title: "Navigated", url: "https://next.example" },
      ]);
      expect(test.stored()).toEqual([
        expect.objectContaining({
          id: original.tabId,
          title: "Navigated",
          url: "https://next.example",
        }),
      ]);
      test.change({}, []);
      expect(test.stored()).toEqual([]);
    });
  });
  it("revokes native control when acquisition completes after its deadline", async () => {
    await withBrowserTest(async (test) => {
      const gate = deferred<HostRpcHandlerResult>();
      const started = deferred<void>();
      test.intercept(({ command }) => {
        if (command.type !== "desktop.browser.acquire_control") return null;
        started.resolve();
        return gate.promise;
      });
      const acquiring = test.post("acquire", {
        ...test.scope,
        tabIds: [test.tab().tabId],
        controllerLabel: "Slow agent",
        ttlMs: 1000,
      });
      await started.promise;
      const command = test.responder.requests.find(
        ({ command }) => command.type === "desktop.browser.acquire_control",
      )?.command;
      if (!command || command.type !== "desktop.browser.acquire_control")
        throw new Error("Expected pending acquire");
      await vi.waitFor(
        () =>
          expect(
            test.responder.requests.some(
              ({ command: value }) =>
                value.type === "desktop.browser.release_control" &&
                value.leaseId === command.leaseId,
            ),
          ).toBe(true),
        { timeout: 2500 },
      );
      gate.resolve({
        ok: true,
        result: {
          lease: {
            leaseId: command.leaseId,
            controllerLabel: command.controllerLabel,
            expiresAt: command.expiresAt,
          },
        },
      });
      expect((await acquiring).status).toBe(409);
      expect(
        test.responder.requests.filter(
          ({ command: value }) =>
            value.type === "desktop.browser.release_control" &&
            value.leaseId === command.leaseId,
        ),
      ).toHaveLength(2);
      expect(
        (await test.post("connection", test.leaseRequest(command.leaseId)))
          .status,
      ).toBe(409);
    });
  });

  it("updates persisted targets after same-window reconnect and ignores deletion from its old generation", async () => {
    await withBrowserTest(async (test) => {
      const tab = test.tab();
      test.change({}, [tab]);
      test.change({ generation: "reconnected-generation" }, [
        { ...tab, title: "Reconnected" },
      ]);
      expect(test.stored()).toEqual([
        expect.objectContaining({
          id: tab.tabId,
          title: "Reconnected",
          desktopTarget: {
            hostId: test.scope.hostId,
            instanceId: test.scope.instanceId,
            generation: "reconnected-generation",
          },
        }),
      ]);
      test.change({}, []);
      expect(test.stored()).toHaveLength(1);
      test.change({ generation: "reconnected-generation" }, []);
      expect(test.stored()).toEqual([]);
    });
  });
});
