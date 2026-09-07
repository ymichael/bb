import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";

const objectSchema = z.record(z.string(), z.json());
type CdpObject = z.infer<typeof objectSchema>;
const commandSchema = z
  .object({
    id: z.number().int().nonnegative(),
    method: z.string().min(1).max(256),
    params: objectSchema.default({}),
    sessionId: z.string().min(1).max(256).optional(),
  })
  .strict();
type CdpCommand = z.infer<typeof commandSchema>;

export interface DesktopBrowserCdpScope {
  hostWebContentsId: number;
  threadId: string;
}

export interface DesktopBrowserCdpPage {
  tabId: string;
  url: string;
  title: string;
  attach(): void;
  detach(): void;
  send(
    method: string,
    params: CdpObject,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<CdpObject>;
  onMessage(
    listener: (method: string, params: CdpObject, sessionId: string) => void,
  ): () => void;
  onDetach(listener: () => void): () => void;
}

export interface DesktopBrowserCdpAdapter {
  listTabs(scope: DesktopBrowserCdpScope): DesktopBrowserCdpPage[];
  createTab(
    scope: DesktopBrowserCdpScope,
    url: string,
    signal: AbortSignal,
  ): Promise<string>;
  closeTab(
    scope: DesktopBrowserCdpScope,
    tabId: string,
    signal: AbortSignal,
  ): Promise<void>;
  activateTab(
    scope: DesktopBrowserCdpScope,
    tabId: string,
    signal: AbortSignal,
  ): Promise<void>;
  subscribe(listener: () => void): () => void;
}

interface CdpSession {
  controller: AbortController;
  kind: "browser" | "tab" | "page";
  targetId: string;
  autoAttached: boolean;
  tabId: string;
  nativeSessionId: string;
  parentSessionId: string | undefined;
}

const filterSchema = z.array(
  z.object({
    type: z.string().optional(),
    exclude: z.boolean().default(false),
  }),
);
type TargetFilter = z.infer<typeof filterSchema>;

function matchesFilter(type: string, filter: TargetFilter): boolean {
  return !(
    filter.find((entry) => entry.type === undefined || entry.type === type)
      ?.exclude ?? true
  );
}

interface AttachedPage {
  page: DesktopBrowserCdpPage;
  dispose(): void;
}

const forwardedDomains = new Set([
  "Accessibility",
  "Audits",
  "CSS",
  "DOM",
  "DOMSnapshot",
  "Emulation",
  "Fetch",
  "Input",
  "Inspector",
  "Log",
  "Network",
  "Page",
  "Performance",
  "Runtime",
]);

export function desktopBrowserCdpTargetId(
  scope: DesktopBrowserCdpScope,
  tabId: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([scope.hostWebContentsId, scope.threadId, tabId]))
    .digest("hex")
    .slice(0, 32)
    .toUpperCase();
}

function buildTargetInfo(
  page: DesktopBrowserCdpPage,
  scope: DesktopBrowserCdpScope,
  type: "page" | "tab",
): CdpObject {
  const targetId = desktopBrowserCdpTargetId(scope, page.tabId);
  return {
    targetId: type === "tab" ? `tab:${targetId}` : targetId,
    type,
    title: page.title,
    url: page.url,
    attached: false,
    canAccessOpener: false,
    browserContextId: "",
  };
}

function readString(params: CdpObject, key: string): string {
  return z.string().min(1).parse(params[key]);
}

function createConnection(
  socket: WebSocket,
  adapter: DesktopBrowserCdpAdapter,
  scope: DesktopBrowserCdpScope,
  product: string,
) {
  const sessions = new Map<string, CdpSession>();
  const attached = new Map<string, AttachedPage>();
  const knownTargets = new Map<string, string>();
  const pending = new Set<number>();
  const controller = new AbortController();
  const deadlines = new Set<ReturnType<typeof setTimeout>>();
  let discover = false;
  let discoveryFilter: TargetFilter = [{ exclude: false }];
  const autoAttachments = new Map<string | undefined, TargetFilter>();
  let disposed = false;
  const browserTargetId = randomUUID();
  const browserInfo: CdpObject = {
    targetId: browserTargetId,
    type: "browser",
    title: "BB",
    url: "",
    attached: true,
    canAccessOpener: false,
  };

  function targetInfo(
    page: DesktopBrowserCdpPage,
    type: "page" | "tab" = "page",
  ) {
    return {
      ...buildTargetInfo(page, scope, type),
      attached: [...sessions.values()].some(
        (session) => session.tabId === page.tabId && session.kind === type,
      ),
    };
  }

  function targetIdFor(tabId: string) {
    return desktopBrowserCdpTargetId(scope, tabId);
  }

  function send(message: CdpObject) {
    if (disposed || socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 8 * 1024 * 1024) {
      socket.terminate();
      return;
    }
    const serialized = JSON.stringify(message);
    if (Buffer.byteLength(serialized) > 8 * 1024 * 1024) {
      socket.terminate();
      return;
    }
    socket.send(serialized);
  }

  function event(method: string, params: CdpObject, sessionId?: string) {
    send({ method, params, ...(sessionId === undefined ? {} : { sessionId }) });
  }

  function getPage(tabId: string) {
    const page = adapter
      .listTabs(scope)
      .find((candidate) => candidate.tabId === tabId);
    if (!page) throw new Error("Target is not available to this connection");
    return page;
  }

  function getTarget(targetId: string) {
    const page = adapter
      .listTabs(scope)
      .find((candidate) => targetIdFor(candidate.tabId) === targetId);
    if (!page) throw new Error("Target is not available to this connection");
    return page;
  }

  function removePage(tabId: string) {
    for (const [sessionId, session] of sessions) {
      if (session.tabId !== tabId) continue;
      session.controller.abort();
      sessions.delete(sessionId);
      autoAttachments.delete(sessionId);
      event(
        "Target.detachedFromTarget",
        {
          sessionId,
          targetId: session.targetId,
        },
        session.parentSessionId,
      );
    }
    const attachment = attached.get(tabId);
    attached.delete(tabId);
    attachment?.dispose();
  }

  function forgetSession(sessionId: string) {
    const session = sessions.get(sessionId);
    if (!session) return;
    for (const [childId, child] of sessions) {
      if (child.parentSessionId === sessionId) forgetSession(childId);
    }
    session.controller.abort();
    sessions.delete(sessionId);
    autoAttachments.delete(sessionId);
    event(
      "Target.detachedFromTarget",
      { sessionId, targetId: session.targetId },
      session.parentSessionId,
    );
    if (
      session.kind === "page" &&
      ![...sessions.values()].some(
        (candidate) =>
          candidate.kind === "page" && candidate.tabId === session.tabId,
      )
    ) {
      const attachment = attached.get(session.tabId);
      attached.delete(session.tabId);
      attachment?.dispose();
    }
  }

  async function detachSession(sessionId: string) {
    const session = sessions.get(sessionId);
    if (!session)
      throw new Error("Session is not available to this connection");
    session.controller.abort();
    for (const [childId, child] of [...sessions]) {
      if (child.parentSessionId === sessionId) await detachSession(childId);
    }
    if (
      session.nativeSessionId !== "" &&
      ![...sessions].some(
        ([id, other]) =>
          id !== sessionId &&
          other.tabId === session.tabId &&
          other.nativeSessionId === session.nativeSessionId,
      )
    ) {
      const parent =
        session.parentSessionId === undefined
          ? undefined
          : sessions.get(session.parentSessionId);
      await getPage(session.tabId).send(
        "Target.detachFromTarget",
        { sessionId: session.nativeSessionId },
        parent?.nativeSessionId || undefined,
      );
    }
    forgetSession(sessionId);
  }

  function attachPage(
    page: DesktopBrowserCdpPage,
    parentSessionId: string | undefined,
    autoAttached: boolean,
  ): string {
    if (!attached.has(page.tabId)) {
      page.attach();
      const offMessage = page.onMessage((method, params, nativeSessionId) => {
        if (!adapter.listTabs(scope).some((tab) => tab.tabId === page.tabId))
          return;
        const recipients = [...sessions].filter(
          ([, session]) =>
            session.kind === "page" &&
            session.tabId === page.tabId &&
            session.nativeSessionId === nativeSessionId,
        );
        for (const [sessionId] of recipients) {
          if (method === "Target.attachedToTarget") {
            const childNativeId = z.string().safeParse(params.sessionId);
            const childInfo = z
              .object({ targetId: z.string().min(1) })
              .safeParse(params.targetInfo);
            if (!childNativeId.success || !childInfo.success) continue;
            const childId = randomUUID();
            sessions.set(childId, {
              controller: new AbortController(),
              kind: "page",
              targetId: childInfo.data.targetId,
              autoAttached: true,
              tabId: page.tabId,
              nativeSessionId: childNativeId.data,
              parentSessionId: sessionId,
            });
            event(method, { ...params, sessionId: childId }, sessionId);
          } else if (method === "Target.detachedFromTarget") {
            for (const [childId, child] of sessions) {
              if (
                child.tabId === page.tabId &&
                child.nativeSessionId === params.sessionId &&
                child.parentSessionId === sessionId
              ) {
                forgetSession(childId);
              }
            }
          } else {
            event(method, params, sessionId);
          }
        }
      });
      const offDetach = page.onDetach(() => removePage(page.tabId));
      attached.set(page.tabId, {
        page,
        dispose() {
          offMessage();
          offDetach();
          page.detach();
        },
      });
    }
    const sessionId = randomUUID();
    sessions.set(sessionId, {
      controller: new AbortController(),
      kind: "page",
      targetId: targetIdFor(page.tabId),
      autoAttached,
      tabId: page.tabId,
      nativeSessionId: "",
      parentSessionId,
    });
    return sessionId;
  }

  function attachTarget(
    targetId: string,
    parentSessionId: string | undefined,
    autoAttached: boolean,
  ) {
    let info: CdpObject;
    let sessionId: string;
    if (targetId === browserTargetId) {
      sessionId = randomUUID();
      sessions.set(sessionId, {
        controller: new AbortController(),
        kind: "browser",
        targetId,
        autoAttached,
        tabId: "",
        nativeSessionId: "",
        parentSessionId,
      });
      info = browserInfo;
    } else if (targetId.startsWith("tab:")) {
      const page = getTarget(targetId.slice(4));
      sessionId = randomUUID();
      sessions.set(sessionId, {
        controller: new AbortController(),
        kind: "tab",
        targetId,
        autoAttached,
        tabId: page.tabId,
        nativeSessionId: "",
        parentSessionId,
      });
      info = targetInfo(page, "tab");
    } else {
      const page = getTarget(targetId);
      sessionId = attachPage(page, parentSessionId, autoAttached);
      info = targetInfo(page);
    }
    event(
      "Target.attachedToTarget",
      { sessionId, targetInfo: info, waitingForDebugger: false },
      parentSessionId,
    );
    return sessionId;
  }

  function announceTargets() {
    if (disposed) return;
    const pages = adapter.listTabs(scope);
    const infos = [
      browserInfo,
      ...pages.flatMap((page) => [targetInfo(page, "tab"), targetInfo(page)]),
    ];
    const liveIds = new Set(infos.map((info) => readString(info, "targetId")));
    for (const session of [...sessions.values()]) {
      if (
        session.kind !== "browser" &&
        !pages.some((page) => page.tabId === session.tabId)
      )
        removePage(session.tabId);
    }
    for (const tabId of knownTargets.keys()) {
      if (liveIds.has(tabId)) continue;
      knownTargets.delete(tabId);
      for (const attachedId of attached.keys()) {
        if (targetIdFor(attachedId) === tabId) removePage(attachedId);
      }
      if (discover) event("Target.targetDestroyed", { targetId: tabId });
    }
    for (const info of infos) {
      if (!matchesFilter(readString(info, "type"), discoveryFilter)) continue;
      const id = readString(info, "targetId");
      const previous = knownTargets.get(id);
      const serialized = JSON.stringify(info);
      knownTargets.set(id, serialized);
      if (
        discover &&
        matchesFilter(readString(info, "type"), discoveryFilter) &&
        previous !== serialized
      ) {
        event(
          previous === undefined
            ? "Target.targetCreated"
            : "Target.targetInfoChanged",
          { targetInfo: info },
        );
      }
    }
    for (const [parentId, filter] of autoAttachments) {
      const parent =
        parentId === undefined ? undefined : sessions.get(parentId);
      for (const page of pages) {
        if (parent?.kind === "tab" && parent.tabId !== page.tabId) continue;
        const kinds: Array<"tab" | "page"> =
          parent?.kind === "tab" ? ["page"] : ["tab", "page"];
        for (const kind of kinds) {
          if (!matchesFilter(kind, filter)) continue;
          if (
            [...sessions.values()].some(
              (session) =>
                session.kind === kind &&
                session.tabId === page.tabId &&
                session.parentSessionId === parentId,
            )
          )
            continue;
          attachTarget(
            kind === "tab"
              ? `tab:${targetIdFor(page.tabId)}`
              : targetIdFor(page.tabId),
            parentId,
            true,
          );
        }
      }
    }
  }

  async function dispatch(command: CdpCommand): Promise<CdpObject> {
    controller.signal.throwIfAborted();
    const { method, params } = command;
    const session =
      command.sessionId === undefined
        ? undefined
        : sessions.get(command.sessionId);
    if (command.sessionId !== undefined) {
      if (!session)
        throw new Error("Session is not available to this connection");
    }
    if (session?.kind === "page") {
      const page = getPage(session.tabId);
      if (method === "Target.detachFromTarget") {
        const childId = readString(params, "sessionId");
        if (sessions.get(childId)?.parentSessionId !== command.sessionId)
          throw new Error("Child session is not attached to this parent");
        await detachSession(childId);
        return {};
      }
      if (method === "Target.setAutoAttach") {
        return page.send(
          method,
          params,
          session.nativeSessionId || undefined,
          session.controller.signal,
        );
      }
      if (!forwardedDomains.has(method.split(".")[0])) {
        throw new Error("CDP method is not supported for scoped page sessions");
      }
      return page.send(
        method,
        params,
        session.nativeSessionId || undefined,
        session.controller.signal,
      );
    }
    if (session?.kind === "tab") {
      getPage(session.tabId);
      if (method === "Runtime.runIfWaitingForDebugger") return {};
      if (
        method !== "Target.setAutoAttach" &&
        method !== "Target.detachFromTarget"
      ) {
        throw new Error("CDP method is not supported for virtual tab sessions");
      }
    }
    switch (method) {
      case "Browser.getVersion":
        return {
          protocolVersion: "1.3",
          product,
          revision: "",
          userAgent: product,
          jsVersion: process.versions.v8,
        };
      case "Target.getBrowserContexts":
        return { browserContextIds: [] };
      case "Target.getTargets":
        return {
          targetInfos:
            params.filter === undefined
              ? adapter.listTabs(scope).map((page) => targetInfo(page))
              : [
                  browserInfo,
                  ...adapter
                    .listTabs(scope)
                    .flatMap((page) => [
                      targetInfo(page, "tab"),
                      targetInfo(page),
                    ]),
                ].filter((info) =>
                  matchesFilter(
                    readString(info, "type"),
                    filterSchema.parse(params.filter),
                  ),
                ),
        };
      case "Target.getTargetInfo": {
        if (
          params.targetId === undefined ||
          params.targetId === browserTargetId
        )
          return { targetInfo: browserInfo };
        const targetId = readString(params, "targetId");
        return {
          targetInfo: targetId.startsWith("tab:")
            ? targetInfo(getTarget(targetId.slice(4)), "tab")
            : targetInfo(getTarget(targetId)),
        };
      }
      case "Target.setDiscoverTargets":
        discover = z.boolean().parse(params.discover);
        discoveryFilter =
          params.filter === undefined
            ? [{ exclude: false }]
            : filterSchema.parse(params.filter);
        knownTargets.clear();
        announceTargets();
        return {};
      case "Target.setAutoAttach":
        if (params.flatten !== true)
          throw new Error("Flattened CDP sessions are required");
        if (z.boolean().parse(params.autoAttach)) {
          autoAttachments.set(
            command.sessionId,
            params.filter === undefined
              ? [{ exclude: false }]
              : filterSchema.parse(params.filter),
          );
        } else {
          autoAttachments.delete(command.sessionId);
          for (const [id, child] of [...sessions]) {
            if (
              child.autoAttached &&
              child.parentSessionId === command.sessionId &&
              sessions.has(id)
            )
              await detachSession(id);
          }
        }
        announceTargets();
        return {};
      case "Target.attachToTarget": {
        if (params.flatten !== true)
          throw new Error("Flattened CDP sessions are required");
        const sessionId = attachTarget(
          readString(params, "targetId"),
          command.sessionId,
          false,
        );
        return { sessionId };
      }
      case "Target.detachFromTarget": {
        const sessionId = readString(params, "sessionId");
        await detachSession(sessionId);
        return {};
      }
      case "Target.createTarget": {
        if (
          params.browserContextId !== undefined &&
          params.browserContextId !== ""
        ) {
          throw new Error(
            "Browser contexts cannot be selected through this connection",
          );
        }
        const url = z.string().max(4096).parse(params.url);
        if (
          url !== "about:blank" &&
          !["http:", "https:"].includes(new URL(url).protocol)
        ) {
          throw new Error(
            "Only HTTP, HTTPS, and about:blank targets are supported",
          );
        }
        const tabId = await adapter.createTab(scope, url, controller.signal);
        if (disposed) throw new Error("Connection closed");
        getPage(tabId);
        announceTargets();
        return { targetId: targetIdFor(tabId) };
      }
      case "Target.closeTarget": {
        const page = getTarget(readString(params, "targetId"));
        await adapter.closeTab(scope, page.tabId, controller.signal);
        controller.signal.throwIfAborted();
        announceTargets();
        return { success: true };
      }
      case "Target.activateTarget": {
        const page = getTarget(readString(params, "targetId"));
        await adapter.activateTab(scope, page.tabId, controller.signal);
        controller.signal.throwIfAborted();
        return {};
      }
      default:
        throw new Error(
          "CDP method is not supported by the scoped browser bridge",
        );
    }
  }

  const unsubscribe = adapter.subscribe(() => {
    try {
      announceTargets();
    } catch {
      socket.terminate();
    }
  });
  socket.on("message", async (data, binary) => {
    let command: CdpCommand;
    try {
      if (binary) throw new Error("Text CDP messages required");
      command = commandSchema.parse(JSON.parse(data.toString()));
    } catch {
      socket.close(1008, "Invalid CDP command");
      return;
    }
    if (pending.has(command.id) || pending.size >= 64) {
      socket.close(1008, "CDP request limit exceeded");
      return;
    }
    pending.add(command.id);
    const envelope = {
      id: command.id,
      ...(command.sessionId === undefined
        ? {}
        : { sessionId: command.sessionId }),
    };
    const timeout = setTimeout(() => socket.terminate(), 30_000);
    deadlines.add(timeout);
    try {
      send({ ...envelope, result: await dispatch(command) });
    } catch (error) {
      send({
        ...envelope,
        error: {
          code: -32000,
          message:
            error instanceof Error ? error.message : "CDP command failed",
        },
      });
    } finally {
      clearTimeout(timeout);
      deadlines.delete(timeout);
      pending.delete(command.id);
    }
  });

  function dispose() {
    if (disposed) return;
    disposed = true;
    controller.abort();
    unsubscribe();
    for (const timeout of deadlines) clearTimeout(timeout);
    deadlines.clear();
    for (const tabId of attached.keys()) removePage(tabId);
    for (const session of sessions.values()) session.controller.abort();
    sessions.clear();
  }

  socket.on("close", dispose);
  socket.on("error", dispose);
  return () => {
    dispose();
    socket.terminate();
  };
}

export async function createDesktopBrowserCdpBridge(args: {
  adapter: DesktopBrowserCdpAdapter;
  product: string;
}) {
  const grants = new Map<
    string,
    {
      scope: DesktopBrowserCdpScope;
      expiresAt: number;
      disconnect: (() => void) | null;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
  });
  let closed = false;

  function revoke(token: string) {
    const grant = grants.get(token);
    if (!grant) return;
    grants.delete(token);
    clearTimeout(grant.timer);
    grant.disconnect?.();
  }

  server.on("upgrade", (request, socket, head) => {
    const token = request.url?.match(/^\/cdp\/([a-f0-9]{64})$/)?.[1];
    const grant = token === undefined ? undefined : grants.get(token);
    if (
      closed ||
      request.headers.origin !== undefined ||
      !grant ||
      grant.expiresAt <= Date.now() ||
      grant.disconnect !== null
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      grant.disconnect = createConnection(
        websocket,
        args.adapter,
        grant.scope,
        args.product,
      );
      websocket.on("close", () => {
        grant.disconnect = null;
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("CDP listener did not bind");
  const port = address.port;

  return {
    grant(scope: DesktopBrowserCdpScope, expiresAt: number) {
      if (closed) throw new Error("CDP bridge is closed");
      if (
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= Date.now() ||
        expiresAt - Date.now() > 3_600_000
      ) {
        throw new Error("CDP grant must expire within one hour");
      }
      if (
        [...grants.values()].some(
          (grant) =>
            grant.scope.threadId === scope.threadId &&
            grant.scope.hostWebContentsId === scope.hostWebContentsId,
        )
      ) {
        throw new Error("Thread already has a browser controller");
      }
      const token = randomBytes(32).toString("hex");
      const timer = setTimeout(() => revoke(token), expiresAt - Date.now());
      timer.unref();
      grants.set(token, {
        scope: { ...scope },
        expiresAt,
        disconnect: null,
        timer,
      });
      return {
        endpoint: `ws://127.0.0.1:${port}/cdp/${token}`,
        expiresAt,
        revoke: () => revoke(token),
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const token of grants.keys()) revoke(token);
      websocketServer.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
