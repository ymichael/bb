import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { z } from "zod";
import {
  createDesktopBrowserCdpBridge,
  desktopBrowserCdpTargetId,
  type DesktopBrowserCdpAdapter,
  type DesktopBrowserCdpPage,
  type DesktopBrowserCdpScope,
} from "../src/desktop-browser-cdp.js";

const messageSchema = z.record(z.string(), z.json());
type Message = z.infer<typeof messageSchema>;
const disposers: Array<() => Promise<void>> = [];

function deferred() {
  let resolve: () => void = () => {
    throw new Error("Deferred promise is not initialized");
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

function createFixture() {
  const tabs = new Map<string, DesktopBrowserCdpPage>();
  const scopes = new Map<string, DesktopBrowserCdpScope>();
  const changes = new Set<() => void>();
  const commands: Array<{ tabId: string; method: string }> = [];
  const nativeCommands: Array<{
    tabId: string;
    method: string;
    params: Message;
    sessionId: string | undefined;
  }> = [];
  const messageListeners = new Map<
    string,
    Set<Parameters<DesktopBrowserCdpPage["onMessage"]>[0]>
  >();
  const attachments = new Set<string>();
  const scopeA = { hostWebContentsId: 1, threadId: "thread-a" };
  const scopeB = { hostWebContentsId: 1, threadId: "thread-b" };
  const scopeOtherWindow = { hostWebContentsId: 2, threadId: "thread-a" };
  function addTab(tabId: string, scope: DesktopBrowserCdpScope) {
    const listeners = new Set<
      Parameters<DesktopBrowserCdpPage["onMessage"]>[0]
    >();
    messageListeners.set(tabId, listeners);
    const page: DesktopBrowserCdpPage = {
      tabId,
      url: `https://example.com/${tabId}`,
      title: tabId,
      attach() {
        attachments.add(tabId);
      },
      detach() {
        attachments.delete(tabId);
      },
      async send(method, params, sessionId) {
        commands.push({ tabId, method });
        nativeCommands.push({ tabId, method, params, sessionId });
        return { value: tabId };
      },
      onMessage(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      onDetach() {
        return () => {};
      },
    };
    tabs.set(tabId, page);
    scopes.set(tabId, scope);
    for (const listener of changes) listener();
    return page;
  }
  addTab("a", scopeA);
  addTab("b", scopeB);
  addTab("other-window", scopeOtherWindow);
  const adapter: DesktopBrowserCdpAdapter = {
    listTabs(scope) {
      return [...tabs.values()].filter((page) => {
        const owner = scopes.get(page.tabId);
        return (
          owner?.threadId === scope.threadId &&
          owner.hostWebContentsId === scope.hostWebContentsId
        );
      });
    },
    async createTab(scope, url) {
      const page = addTab(`created-${tabs.size}`, scope);
      page.url = url;
      return page.tabId;
    },
    async closeTab(_scope, tabId) {
      tabs.delete(tabId);
      for (const listener of changes) listener();
    },
    async activateTab(_scope, tabId) {
      commands.push({ tabId, method: "activate" });
    },
    subscribe(listener) {
      changes.add(listener);
      return () => {
        changes.delete(listener);
      };
    },
  };
  function emitMessage(
    tabId: string,
    method: string,
    params: Message,
    sessionId = "",
  ) {
    const listeners = messageListeners.get(tabId);
    if (listeners === undefined) throw new Error("Missing fixture tab");
    for (const listener of listeners) listener(method, params, sessionId);
  }
  return {
    adapter,
    scopeA,
    scopeB,
    commands,
    nativeCommands,
    attachments,
    tabs,
    emitMessage,
  };
}

async function openBridge() {
  const fixture = createFixture();
  const bridge = await createDesktopBrowserCdpBridge({
    adapter: fixture.adapter,
    product: "Chrome/146.0.0.0",
  });
  disposers.push(() => bridge.close());
  return { ...fixture, bridge };
}

async function connect(endpoint: string) {
  const socket = new WebSocket(endpoint);
  await once(socket, "open");
  const messages: Message[] = [];
  socket.on("message", (data) =>
    messages.push(messageSchema.parse(JSON.parse(data.toString()))),
  );
  disposers.push(async () => {
    if (socket.readyState === WebSocket.CLOSED) return;
    const closed = once(socket, "close");
    socket.terminate();
    await closed;
  });
  let id = 0;
  async function call(
    method: string,
    params: Message = {},
    sessionId?: string,
  ) {
    const requestId = ++id;
    const result = new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out: ${method}`)),
        2000,
      );
      const onMessage = (data: Buffer) => {
        const message = messageSchema.parse(JSON.parse(data.toString()));
        if (message.id !== requestId) return;
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve(message);
      };
      socket.on("message", onMessage);
    });
    socket.send(
      JSON.stringify({
        id: requestId,
        method,
        params,
        ...(sessionId === undefined ? {} : { sessionId }),
      }),
    );
    return result;
  }
  return { socket, messages, call };
}

async function rejectedConnection(endpoint: string, origin?: string) {
  const socket = new WebSocket(
    endpoint,
    origin === undefined ? {} : { origin },
  );
  const [error] = await once(socket, "error");
  return error;
}

describe("thread-scoped browser CDP", () => {
  it("lists only the granted thread and window and rejects other target IDs", async () => {
    const { bridge, scopeA, commands } = await openBridge();
    const grant = bridge.grant(scopeA, Date.now() + 60_000);
    const client = await connect(grant.endpoint);
    const listed = await client.call("Target.getTargets");
    expect(listed.result).toMatchObject({
      targetInfos: [{ targetId: desktopBrowserCdpTargetId(scopeA, "a") }],
    });
    for (const method of [
      "Target.attachToTarget",
      "Target.closeTarget",
      "Target.activateTarget",
      "Target.getTargetInfo",
    ]) {
      expect(
        await client.call(method, { targetId: "b", flatten: true }),
      ).toHaveProperty("error");
      expect(
        await client.call(method, { targetId: "other-window", flatten: true }),
      ).toHaveProperty("error");
    }
    expect(commands).toEqual([]);
  });

  it("routes concurrent controllers to their own pages and keeps session IDs private", async () => {
    const { bridge, scopeA, scopeB, commands } = await openBridge();
    const first = await connect(
      bridge.grant(scopeA, Date.now() + 60_000).endpoint,
    );
    const second = await connect(
      bridge.grant(scopeB, Date.now() + 60_000).endpoint,
    );
    const response = await first.call("Target.attachToTarget", {
      targetId: desktopBrowserCdpTargetId(scopeA, "a"),
      flatten: true,
    });
    const result = z.object({ sessionId: z.string() }).parse(response.result);
    expect(
      await first.call(
        "Runtime.evaluate",
        { expression: "1" },
        result.sessionId,
      ),
    ).toMatchObject({ result: { value: "a" } });
    expect(
      await second.call(
        "Runtime.evaluate",
        { expression: "1" },
        result.sessionId,
      ),
    ).toHaveProperty("error");
    expect(
      await first.call("Target.getTargets", {}, result.sessionId),
    ).toHaveProperty("error");
    expect(await first.call("Browser.close")).toHaveProperty("error");
    expect(commands).toEqual([{ tabId: "a", method: "Runtime.evaluate" }]);
  });

  it("supports Puppeteer tab-to-page auto-attach and honors target filters", async () => {
    const { bridge, scopeA } = await openBridge();
    const client = await connect(
      bridge.grant(scopeA, Date.now() + 60_000).endpoint,
    );
    await client.call("Target.setDiscoverTargets", {
      discover: true,
      filter: [{ type: "page", exclude: true }, {}],
    });
    const discovered = client.messages.filter(
      (message) => message.method === "Target.targetCreated",
    );
    expect(discovered).toHaveLength(2);
    expect(JSON.stringify(discovered)).not.toContain('"targetId":"b"');
    await client.call("Target.setAutoAttach", {
      autoAttach: true,
      flatten: true,
      waitForDebuggerOnStart: true,
      filter: [{ type: "page", exclude: true }, {}],
    });
    const tab = z
      .object({
        params: z.object({
          sessionId: z.string(),
          targetInfo: z.object({ type: z.literal("tab") }),
        }),
      })
      .parse(
        client.messages.find(
          (message) => message.method === "Target.attachedToTarget",
        ),
      );
    const tabSession = tab.params.sessionId;
    await client.call(
      "Target.setAutoAttach",
      { autoAttach: true, flatten: true, waitForDebuggerOnStart: true },
      tabSession,
    );
    expect(client.messages).toContainEqual(
      expect.objectContaining({
        method: "Target.attachedToTarget",
        sessionId: tabSession,
        params: expect.objectContaining({
          targetInfo: expect.objectContaining({
            targetId: desktopBrowserCdpTargetId(scopeA, "a"),
            type: "page",
          }),
        }),
      }),
    );
  });

  it.each([false, true])(
    "releases automatic sessions on disable while preserving explicit sessions: %s",
    async (preserveExplicit) => {
      const { bridge, scopeA, attachments } = await openBridge();
      const client = await connect(
        bridge.grant(scopeA, Date.now() + 60_000).endpoint,
      );
      const targetId = desktopBrowserCdpTargetId(scopeA, "a");
      await client.call("Target.setAutoAttach", {
        autoAttach: true,
        flatten: true,
        filter: [{ type: "page" }],
      });
      const automatic = z
        .object({ params: z.object({ sessionId: z.string() }) })
        .parse(
          client.messages.find(
            (message) => message.method === "Target.attachedToTarget",
          ),
        ).params.sessionId;
      const explicit = preserveExplicit
        ? z.object({ sessionId: z.string() }).parse(
            (
              await client.call("Target.attachToTarget", {
                targetId,
                flatten: true,
              })
            ).result,
          ).sessionId
        : undefined;
      expect(attachments.has("a")).toBe(true);

      expect(
        await client.call("Target.setAutoAttach", {
          autoAttach: false,
          flatten: true,
        }),
      ).toHaveProperty("result");
      expect(client.messages).toContainEqual({
        method: "Target.detachedFromTarget",
        params: { sessionId: automatic, targetId },
      });
      expect(
        await client.call("Runtime.evaluate", { expression: "1" }, automatic),
      ).toHaveProperty("error");
      expect(attachments.has("a")).toBe(preserveExplicit);
      if (explicit !== undefined) {
        expect(
          await client.call("Runtime.evaluate", { expression: "1" }, explicit),
        ).toHaveProperty("result");
        await client.call("Target.detachFromTarget", { sessionId: explicit });
        expect(attachments.has("a")).toBe(false);
      }
    },
  );

  it.each(["browser", "page"])(
    "forwards native child detach from the %s session without detaching the page",
    async (detachFrom) => {
      const { bridge, scopeA, emitMessage, nativeCommands, attachments } =
        await openBridge();
      const client = await connect(
        bridge.grant(scopeA, Date.now() + 60_000).endpoint,
      );
      const root = z.object({ sessionId: z.string() }).parse(
        (
          await client.call("Target.attachToTarget", {
            targetId: desktopBrowserCdpTargetId(scopeA, "a"),
            flatten: true,
          })
        ).result,
      ).sessionId;
      emitMessage("a", "Target.attachedToTarget", {
        sessionId: "native-child",
        targetInfo: { targetId: "native-frame", type: "iframe" },
        waitingForDebugger: true,
      });
      await client.call("Browser.getVersion");
      const child = z
        .object({ params: z.object({ sessionId: z.string() }) })
        .parse(
          client.messages.find(
            (message) =>
              message.method === "Target.attachedToTarget" &&
              message.sessionId === root,
          ),
        ).params.sessionId;

      expect(
        await client.call(
          "Target.detachFromTarget",
          { sessionId: child },
          detachFrom === "page" ? root : undefined,
        ),
      ).toHaveProperty("result");
      expect(nativeCommands).toContainEqual({
        tabId: "a",
        method: "Target.detachFromTarget",
        params: { sessionId: "native-child" },
        sessionId: undefined,
      });
      expect(
        await client.call("Runtime.runIfWaitingForDebugger", {}, child),
      ).toHaveProperty("error");
      expect(attachments.has("a")).toBe(true);
      expect(await client.call("Runtime.enable", {}, root)).toHaveProperty(
        "result",
      );
    },
  );

  it("routes each native child detach to its own virtual parent", async () => {
    const { bridge, scopeA, emitMessage } = await openBridge();
    const client = await connect(
      bridge.grant(scopeA, Date.now() + 60_000).endpoint,
    );
    const roots: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      roots.push(
        z.object({ sessionId: z.string() }).parse(
          (
            await client.call("Target.attachToTarget", {
              targetId: desktopBrowserCdpTargetId(scopeA, "a"),
              flatten: true,
            })
          ).result,
        ).sessionId,
      );
    }
    emitMessage("a", "Target.attachedToTarget", {
      sessionId: "native-child",
      targetInfo: { targetId: "native-frame", type: "iframe" },
      waitingForDebugger: false,
    });
    await client.call("Browser.getVersion");
    const children = client.messages
      .filter(
        (message) =>
          message.method === "Target.attachedToTarget" &&
          typeof message.sessionId === "string" &&
          roots.includes(message.sessionId),
      )
      .map((message) =>
        z
          .object({
            sessionId: z.string(),
            params: z.object({ sessionId: z.string() }),
          })
          .parse(message),
      );
    expect(children).toHaveLength(2);
    emitMessage("a", "Target.detachedFromTarget", {
      sessionId: "native-child",
      targetId: "native-frame",
    });
    await client.call("Browser.getVersion");

    expect(
      client.messages.filter(
        (message) => message.method === "Target.detachedFromTarget",
      ),
    ).toEqual(
      children.map((child) => ({
        method: "Target.detachedFromTarget",
        sessionId: child.sessionId,
        params: {
          sessionId: child.params.sessionId,
          targetId: "native-frame",
        },
      })),
    );
    for (const child of children) {
      expect(
        await client.call("Runtime.enable", {}, child.params.sessionId),
      ).toHaveProperty("error");
      expect(
        await client.call("Runtime.enable", {}, child.sessionId),
      ).toHaveProperty("result");
    }
  });

  it.each(["Input.dispatchMouseEvent", "Input.dispatchTouchEvent"])(
    "cancels buffered %s for a detached child while another parent keeps the native child attached",
    async (method) => {
      const { bridge, scopeA, tabs, emitMessage, nativeCommands, attachments } =
        await openBridge();
      const page = tabs.get("a");
      if (page === undefined) throw new Error("Missing fixture page");
      const entered = deferred();
      const ready = deferred();
      const originalSend = page.send;
      page.send = async (command, params, sessionId, signal) => {
        if (command === method) {
          signal?.throwIfAborted();
          entered.resolve();
          await ready.promise;
          signal?.throwIfAborted();
        }
        return originalSend(command, params, sessionId);
      };
      const client = await connect(
        bridge.grant(scopeA, Date.now() + 60_000).endpoint,
      );
      async function attachParent() {
        return z.object({ sessionId: z.string() }).parse(
          (
            await client.call("Target.attachToTarget", {
              targetId: desktopBrowserCdpTargetId(scopeA, "a"),
              flatten: true,
            })
          ).result,
        ).sessionId;
      }
      const firstParent = await attachParent();
      const secondParent = await attachParent();
      emitMessage("a", "Target.attachedToTarget", {
        sessionId: "shared-native-child",
        targetInfo: { targetId: "native-frame", type: "iframe" },
        waitingForDebugger: false,
      });
      await client.call("Browser.getVersion");
      function childFor(parent: string) {
        return z
          .object({ params: z.object({ sessionId: z.string() }) })
          .parse(
            client.messages.find(
              (message) =>
                message.method === "Target.attachedToTarget" &&
                message.sessionId === parent,
            ),
          ).params.sessionId;
      }
      const firstChild = childFor(firstParent);
      const secondChild = childFor(secondParent);
      const params: Message =
        method === "Input.dispatchMouseEvent"
          ? { type: "mousePressed", x: 10, y: 10, button: "left" }
          : { type: "touchStart", touchPoints: [{ x: 10, y: 10 }] };
      const pending = client.call(method, params, firstChild);
      await entered.promise;

      expect(
        await client.call(
          "Target.detachFromTarget",
          { sessionId: firstChild },
          firstParent,
        ),
      ).toHaveProperty("result");
      expect(attachments.has("a")).toBe(true);
      expect(nativeCommands).toEqual([]);
      ready.resolve();
      expect(await pending).toHaveProperty("error");
      expect(nativeCommands).toEqual([]);
      expect(
        await client.call("Runtime.enable", {}, firstChild),
      ).toHaveProperty("error");

      expect(await client.call(method, params, secondChild)).toHaveProperty(
        "result",
      );
      expect(nativeCommands).toEqual([
        {
          tabId: "a",
          method,
          params,
          sessionId: "shared-native-child",
        },
      ]);
      expect(attachments.has("a")).toBe(true);
    },
  );

  it.each(["create", "close", "activate"])(
    "aborts delayed %s callbacks before they mutate tabs after lease replacement",
    async (operation) => {
      const { bridge, adapter, scopeA, tabs } = await openBridge();
      const entered = deferred();
      const release = deferred();
      const finished = deferred();
      let mutations = 0;
      let aborted = false;
      async function beforeMutation(signal: AbortSignal) {
        entered.resolve();
        await release.promise;
        try {
          aborted = signal.aborted;
          signal.throwIfAborted();
          mutations += 1;
        } finally {
          finished.resolve();
        }
      }
      adapter.createTab = async (_scope, _url, signal) => {
        await beforeMutation(signal);
        return "a";
      };
      adapter.closeTab = async (_scope, _tabId, signal) => {
        await beforeMutation(signal);
      };
      adapter.activateTab = async (_scope, _tabId, signal) => {
        await beforeMutation(signal);
      };
      const grant = bridge.grant(scopeA, Date.now() + 60_000);
      const client = await connect(grant.endpoint);
      client.socket.send(
        JSON.stringify({
          id: 100,
          method: `Target.${operation}Target`,
          params:
            operation === "create"
              ? { url: "about:blank" }
              : { targetId: desktopBrowserCdpTargetId(scopeA, "a") },
        }),
      );
      await entered.promise;
      const closed = once(client.socket, "close");
      grant.revoke();
      await closed;
      const replacement = await connect(
        bridge.grant(scopeA, Date.now() + 60_000).endpoint,
      );
      release.resolve();
      await finished.promise;

      expect(aborted).toBe(true);
      expect(mutations).toBe(0);
      expect(tabs.has("a")).toBe(true);
      expect(await replacement.call("Target.getTargets")).toMatchObject({
        result: {
          targetInfos: [{ targetId: desktopBrowserCdpTargetId(scopeA, "a") }],
        },
      });
    },
  );

  it("creates and closes real scoped targets with lifecycle events", async () => {
    const { bridge, scopeA, tabs } = await openBridge();
    const client = await connect(
      bridge.grant(scopeA, Date.now() + 60_000).endpoint,
    );
    await client.call("Target.setDiscoverTargets", { discover: true });
    const created = await client.call("Target.createTarget", {
      url: "https://example.org",
    });
    const { targetId } = z
      .object({ targetId: z.string() })
      .parse(created.result);
    expect(
      [...tabs.values()].find(
        (tab) => desktopBrowserCdpTargetId(scopeA, tab.tabId) === targetId,
      )?.url,
    ).toBe("https://example.org");
    expect(await client.call("Target.closeTarget", { targetId })).toMatchObject(
      { result: { success: true } },
    );
    expect(client.messages).toContainEqual({
      method: "Target.targetDestroyed",
      params: { targetId },
    });
    expect(tabs.has("b")).toBe(true);
  });

  it("revokes existing sockets and credentials without closing user tabs", async () => {
    const { bridge, scopeA, tabs, attachments } = await openBridge();
    const grant = bridge.grant(scopeA, Date.now() + 60_000);
    const client = await connect(grant.endpoint);
    await client.call("Target.attachToTarget", {
      targetId: desktopBrowserCdpTargetId(scopeA, "a"),
      flatten: true,
    });
    expect(attachments.has("a")).toBe(true);
    const closed = once(client.socket, "close");
    grant.revoke();
    await closed;
    expect(attachments.size).toBe(0);
    expect(tabs.has("a")).toBe(true);
    expect(await rejectedConnection(grant.endpoint)).toBeInstanceOf(Error);
  });

  it("rejects browser-origin connections and concurrent control grants", async () => {
    const { bridge, scopeA } = await openBridge();
    const grant = bridge.grant(scopeA, Date.now() + 60_000);
    expect(() => bridge.grant(scopeA, Date.now() + 60_000)).toThrow(
      "already has",
    );
    expect(
      await rejectedConnection(grant.endpoint, "https://untrusted.example"),
    ).toBeInstanceOf(Error);
    await connect(grant.endpoint);
    expect(await rejectedConnection(grant.endpoint)).toBeInstanceOf(Error);
  });

  it("expires grants and rejects stale or excessive lease durations", async () => {
    const { bridge, scopeA } = await openBridge();
    expect(() => bridge.grant(scopeA, Date.now() - 1)).toThrow("expire");
    expect(() => bridge.grant(scopeA, Date.now() + 3_700_000)).toThrow(
      "expire",
    );
    const client = await connect(
      bridge.grant(scopeA, Date.now() + 150).endpoint,
    );
    await once(client.socket, "close");
  });
});
