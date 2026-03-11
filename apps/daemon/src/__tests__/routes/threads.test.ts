import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type {
  Thread,
  ThreadEvent,
  ThreadOrchestrator,
  ThreadWorkStatus,
} from "@beanbag/agent-core";
import { ENVIRONMENT_AGENT_PROTOCOL_VERSION } from "@beanbag/environment-agent";
import { createThreadRoutes } from "../../routes/threads.js";
import { inactiveSessionError, threadArchivedError } from "../../domain-errors.js";
import type { EnvironmentAgentSessionService } from "../../environment-agent-session-service.js";

type LegacyThreadRouteMock = ThreadOrchestrator & {
  getRawById: ReturnType<typeof vi.fn>;
  getById: ReturnType<typeof vi.fn>;
  isPrimaryCheckoutActive: ReturnType<typeof vi.fn>;
  getHydratedByIdAsync: ReturnType<typeof vi.fn>;
  getWorkStatus: ReturnType<typeof vi.fn>;
  getWorkStatusAsync: ReturnType<typeof vi.fn>;
  getMergeBaseBranchesAsync: ReturnType<typeof vi.fn>;
  getEnvironmentAgentStatus: ReturnType<typeof vi.fn>;
  listAsync: ReturnType<typeof vi.fn>;
  getGitDiff: ReturnType<typeof vi.fn>;
  getGitDiffAsync: ReturnType<typeof vi.fn>;
  getProjectWorkspaceStatusAsync: ReturnType<typeof vi.fn>;
};

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    projectId: "proj-1",
    status: "active",
    queuedMessages: [],
    archivedAt: undefined,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

type ThreadEventOverrides = Partial<Omit<ThreadEvent, "type" | "data">> & {
  type?: string;
  data?: unknown;
};

function makeEvent(overrides: ThreadEventOverrides = {}): ThreadEvent {
  return {
    id: "evt-1",
    threadId: "thread-1",
    seq: 1,
    type: "item/completed",
    data: { content: "result" },
    createdAt: 1000,
    ...overrides,
  } as ThreadEvent;
}

function makeWorkStatus(): ThreadWorkStatus {
  return {
    state: "clean",
    changedFiles: 0,
    insertions: 0,
    deletions: 0,
    workspaceChangedFiles: 0,
    workspaceInsertions: 0,
    workspaceDeletions: 0,
    hasUncommittedChanges: false,
    hasCommittedUnmergedChanges: false,
    aheadCount: 0,
    behindCount: 0,
    mergeBaseBranches: ["main"],
    mergeBaseBranch: "main",
    defaultBranch: "main",
  };
}

function mockOrchestrator(): LegacyThreadRouteMock {
  const orchestrator = {
    spawn: vi.fn(),
    tell: vi.fn(),
    enqueueFollowUp: vi.fn(),
    removeQueuedFollowUp: vi.fn(),
    sendQueuedFollowUp: vi.fn(),
    stop: vi.fn(),
    archive: vi.fn(),
    unarchive: vi.fn(),
    requiresForceArchive: vi.fn(),
    promoteThread: vi.fn(),
    demotePrimaryCheckout: vi.fn(),
    requestThreadOperation: vi.fn(),
    markRead: vi.fn(),
    getRawById: vi.fn(),
    getById: vi.fn(),
    isPrimaryCheckoutActive: vi.fn(),
    getHydratedByIdAsync: vi.fn(),
    getWorkStatus: vi.fn(),
    getWorkStatusAsync: vi.fn(),
    getMergeBaseBranchesAsync: vi.fn(),
    getPrimaryCheckoutStatus: vi.fn(),
    getDefaultExecutionOptions: vi.fn(),
    getEnvironmentAgentStatus: vi.fn(),
    list: vi.fn(),
    listAsync: vi.fn(),
    getTimeline: vi.fn(),
    getToolGroupMessages: vi.fn(),
    getGitDiff: vi.fn(),
    getGitDiffAsync: vi.fn(),
    getProjectWorkspaceStatusAsync: vi.fn(),
    resolveThreadOpenPath: vi.fn(),
    getEvents: vi.fn(),
    getOutput: vi.fn(),
    isActive: vi.fn(),
    getActiveCount: vi.fn(),
    stopAll: vi.fn(),
  } as unknown as LegacyThreadRouteMock;
  orchestrator.getRawById.mockImplementation(
    (threadId: string) => (orchestrator.getById as unknown as (threadId: string) => Thread | undefined)(threadId),
  );
  orchestrator.getHydratedByIdAsync.mockImplementation(
    async (threadId: string) =>
      (orchestrator.getById as unknown as (threadId: string) => Thread | undefined)(threadId),
  );
  orchestrator.isPrimaryCheckoutActive.mockReturnValue(false);
  orchestrator.getWorkStatusAsync.mockImplementation(
    async (threadId: string, mergeBaseBranch?: string) =>
      (
        orchestrator.getWorkStatus as unknown as (
          threadId: string,
          mergeBaseBranch?: string,
        ) => ThreadWorkStatus | undefined
      )(threadId, mergeBaseBranch),
  );
  orchestrator.getMergeBaseBranchesAsync.mockResolvedValue([]);
  orchestrator.listAsync.mockImplementation(async (filters) => orchestrator.list(filters));
  orchestrator.getGitDiffAsync.mockImplementation(
    async (threadId: string, selection, mergeBaseBranch?: string) =>
      (
        orchestrator.getGitDiff as unknown as (
          threadId: string,
          selection?: unknown,
          mergeBaseBranch?: string,
        ) => unknown
      )(threadId, selection, mergeBaseBranch),
  );
  return orchestrator;
}

function mockEnvironmentAgentSessionService(): EnvironmentAgentSessionService {
  return {
    openSession: vi.fn(),
    recordHeartbeat: vi.fn(),
    applyEventBatch: vi.fn(),
    listCommands: vi.fn(),
    recordCommandAck: vi.fn(),
    recordCommandResult: vi.fn(),
    closeSession: vi.fn(),
  } as unknown as EnvironmentAgentSessionService;
}

describe("Thread routes", () => {
  let threadManager: ReturnType<typeof mockOrchestrator>;
  let app: Hono;

  beforeEach(() => {
    threadManager = mockOrchestrator();
    const routes = createThreadRoutes(threadManager);
    app = new Hono().route("/threads", routes);
  });

  describe("POST /threads", () => {
    it("spawns a thread and returns 201", async () => {
      const thread = makeThread({ id: "new-thread" });
      (threadManager.spawn as ReturnType<typeof vi.fn>).mockResolvedValue(
        thread,
      );

      const res = await app.request("/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "proj-1",
          input: [{ type: "text", text: "Do work" }],
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe("new-thread");
      expect(threadManager.spawn).toHaveBeenCalledWith({
        projectId: "proj-1",
        input: [{ type: "text", text: "Do work" }],
      });
    });

    it("spawns a thread with multimodal input", async () => {
      const thread = makeThread({ id: "new-thread" });
      (threadManager.spawn as ReturnType<typeof vi.fn>).mockResolvedValue(
        thread,
      );

      const res = await app.request("/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "proj-1",
          input: [
            { type: "text", text: "Review these assets." },
            { type: "image", url: "https://example.com/mock.png" },
            { type: "localImage", path: "/tmp/mock.png" },
            {
              type: "localFile",
              path: "/tmp/spec.md",
              name: "spec.md",
              sizeBytes: 42,
              mimeType: "text/markdown",
            },
          ],
        }),
      });

      expect(res.status).toBe(201);
      expect(threadManager.spawn).toHaveBeenCalledWith({
        projectId: "proj-1",
        input: [
          { type: "text", text: "Review these assets." },
          { type: "image", url: "https://example.com/mock.png" },
          { type: "localImage", path: "/tmp/mock.png" },
          {
            type: "localFile",
            path: "/tmp/spec.md",
            name: "spec.md",
            sizeBytes: 42,
            mimeType: "text/markdown",
          },
        ],
      });
    });

    it("forwards environment id when provided", async () => {
      const thread = makeThread({ id: "new-thread" });
      (threadManager.spawn as ReturnType<typeof vi.fn>).mockResolvedValue(
        thread,
      );

      const res = await app.request("/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "proj-1",
          input: [{ type: "text", text: "Do work" }],
          environmentId: "worktree",
        }),
      });

      expect(res.status).toBe(201);
      expect(threadManager.spawn).toHaveBeenCalledWith({
        projectId: "proj-1",
        input: [{ type: "text", text: "Do work" }],
        environmentId: "worktree",
      });
    });

    it("forwards sandbox mode when provided", async () => {
      const thread = makeThread({ id: "new-thread" });
      (threadManager.spawn as ReturnType<typeof vi.fn>).mockResolvedValue(
        thread,
      );

      const res = await app.request("/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "proj-1",
          input: [{ type: "text", text: "Do work" }],
          sandboxMode: "read-only",
        }),
      });

      expect(res.status).toBe(201);
      expect(threadManager.spawn).toHaveBeenCalledWith({
        projectId: "proj-1",
        input: [{ type: "text", text: "Do work" }],
        sandboxMode: "read-only",
      });
    });

    it("forwards service tier when provided", async () => {
      const thread = makeThread({ id: "new-thread" });
      (threadManager.spawn as ReturnType<typeof vi.fn>).mockResolvedValue(thread);

      const res = await app.request("/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "proj-1",
          input: [{ type: "text", text: "Do work" }],
          serviceTier: "fast",
        }),
      });

      expect(res.status).toBe(201);
      expect(threadManager.spawn).toHaveBeenCalledWith({
        projectId: "proj-1",
        input: [{ type: "text", text: "Do work" }],
        serviceTier: "fast",
      });
    });

    it("returns 400 for invalid body", async () => {
      const res = await app.request("/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      expect(threadManager.spawn).not.toHaveBeenCalled();
    });

    it("returns 400 for relative local attachment paths", async () => {
      const res = await app.request("/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "proj-1",
          input: [{ type: "localFile", path: "relative/path.txt" }],
        }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        code: "invalid_request",
        error: "Attachment path must be absolute",
        message: "Attachment path must be absolute",
      });
      expect(threadManager.spawn).not.toHaveBeenCalled();
    });

    it("returns 500 when spawn fails", async () => {
      (threadManager.spawn as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Project not found"),
      );

      const res = await app.request("/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "bad-proj" }),
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("Project not found");
    });

  });

  describe("GET /threads/:id/environment-agent/status", () => {
    it("returns thread-scoped environment-agent status", async () => {
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(makeThread());
      (threadManager.getEnvironmentAgentStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        threadId: "thread-1",
        latestSequence: 4,
        connectedToDaemon: true,
        pendingEventCount: 1,
        pendingCommandCount: 0,
        deliveryState: "healthy",
        retryAttemptCount: 0,
      });

      const res = await app.request("/threads/thread-1/environment-agent/status");

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        threadId: "thread-1",
        latestSequence: 4,
      });
      expect(threadManager.getEnvironmentAgentStatus).toHaveBeenCalledWith("thread-1");
    });

    it("returns 409 when the environment-agent session is inactive", async () => {
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(makeThread());
      (threadManager.getEnvironmentAgentStatus as ReturnType<typeof vi.fn>).mockRejectedValue(
        inactiveSessionError("provider session is inactive"),
      );

      const res = await app.request("/threads/thread-1/environment-agent/status");

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({
        code: "inactive_session",
      });
    });
  });

  describe("POST /threads/:id/environment-agent/session/open", () => {
    it("opens a session and returns a welcome payload", async () => {
      const sessionService = mockEnvironmentAgentSessionService();
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread(),
      );
      (sessionService.openSession as ReturnType<typeof vi.fn>).mockReturnValue({
        session: {
          id: "sess-1",
        },
        welcome: {
          protocol: "beanbag.env-agent.v1",
          type: "session_welcome",
          messageId: "msg-1",
          sessionId: "sess-1",
          sentAt: 1_000,
          payload: {
            leaseTtlMs: 30_000,
            heartbeatIntervalMs: 10_000,
            selectedTransport: "websocket",
            protocolVersion: 1,
            channels: [
              {
                channelId: "thread-1",
                applyFrom: {
                  generation: 1,
                  sequenceExclusive: 0,
                },
                deliverCommandsAfter: 0,
              },
            ],
          },
        },
      });
      app = new Hono().route(
        "/threads",
        createThreadRoutes(threadManager, {
          environmentAgentSessionService: sessionService,
        }),
      );

      const res = await app.request("/threads/thread-1/environment-agent/session/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: "agent-1",
          agentInstanceId: "instance-1",
          supportedProtocolVersions: [1],
          supportedTransports: ["websocket"],
          channels: [
            {
              channelId: "thread-1",
              generation: 1,
            },
          ],
        }),
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({
        type: "session_welcome",
        sessionId: "sess-1",
      });
      expect(sessionService.openSession).toHaveBeenCalledWith({
        threadId: "thread-1",
        payload: {
          agentId: "agent-1",
          agentInstanceId: "instance-1",
          supportedProtocolVersions: [1],
          supportedTransports: ["websocket"],
          channels: [
            {
              channelId: "thread-1",
              generation: 1,
            },
          ],
        },
      });
    });
  });

  describe("POST /threads/:id/environment-agent/session/heartbeat", () => {
    it("accepts session heartbeats", async () => {
      const sessionService = mockEnvironmentAgentSessionService();
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread(),
      );
      (sessionService.recordHeartbeat as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "sess-1",
        threadId: "thread-1",
        status: "active",
      });
      app = new Hono().route(
        "/threads",
        createThreadRoutes(threadManager, {
          environmentAgentSessionService: sessionService,
        }),
      );

      const res = await app.request(
        "/threads/thread-1/environment-agent/session/heartbeat",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: "sess-1",
            agentObservedAt: 1_000,
            outboxDepth: 2,
            channels: [
              {
                channelId: "thread-1",
                lastSent: {
                  generation: 1,
                  sequence: 2,
                },
                lastAcked: {
                  generation: 1,
                  sequence: 1,
                },
              },
            ],
          }),
        },
      );

      expect(res.status).toBe(204);
      expect(sessionService.recordHeartbeat).toHaveBeenCalledWith({
        threadId: "thread-1",
        sessionId: "sess-1",
        payload: {
          sessionId: "sess-1",
          agentObservedAt: 1_000,
          outboxDepth: 2,
          channels: [
            {
              channelId: "thread-1",
              lastSent: {
                generation: 1,
                sequence: 2,
              },
              lastAcked: {
                generation: 1,
                sequence: 1,
              },
            },
          ],
        },
      });
    });
  });

  describe("POST /threads/:id/environment-agent/session/events", () => {
    it("applies session event batches and returns an event ack", async () => {
      const sessionService = mockEnvironmentAgentSessionService();
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(makeThread());
      (sessionService.applyEventBatch as ReturnType<typeof vi.fn>).mockResolvedValue({
        protocol: "beanbag.env-agent.v1",
        type: "event_ack",
        messageId: "msg-evt-1",
        sessionId: "sess-1",
        sentAt: 1_000,
        payload: {
          channels: [
            {
              channelId: "thread-1",
              ackedThrough: { generation: 2, sequence: 4 },
            },
          ],
        },
      });
      app = new Hono().route(
        "/threads",
        createThreadRoutes(threadManager, {
          environmentAgentSessionService: sessionService,
        }),
      );

      const res = await app.request(
        "/threads/thread-1/environment-agent/session/events",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: "sess-1",
            batches: [
              {
                channelId: "thread-1",
                generation: 2,
                events: [
                  {
                    sequence: 4,
                    eventId: "evt-4",
                    emittedAt: 999,
                    event: {
                      type: "provider.stderr",
                      threadId: "thread-1",
                      line: "stderr line",
                    },
                  },
                ],
              },
            ],
          }),
        },
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        type: "event_ack",
        sessionId: "sess-1",
      });
      expect(sessionService.applyEventBatch).toHaveBeenCalledWith({
        threadId: "thread-1",
        sessionId: "sess-1",
        payload: {
          batches: [
            {
              channelId: "thread-1",
              generation: 2,
              events: [
                {
                  sequence: 4,
                  eventId: "evt-4",
                  emittedAt: 999,
                  event: {
                    type: "provider.stderr",
                    threadId: "thread-1",
                    line: "stderr line",
                  },
                },
              ],
            },
          ],
        },
      });
    });
  });

  describe("POST /threads/:id/environment-agent/session/commands/ack", () => {
    it("records command acknowledgements", async () => {
      const sessionService = mockEnvironmentAgentSessionService();
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(makeThread());
      app = new Hono().route(
        "/threads",
        createThreadRoutes(threadManager, {
          environmentAgentSessionService: sessionService,
        }),
      );

      const res = await app.request(
        "/threads/thread-1/environment-agent/session/commands/ack",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: "sess-1",
            commands: [
              {
                commandId: "cmd-1",
                channelId: "thread-1",
                state: "received",
              },
            ],
            deliveredThrough: 3,
          }),
        },
      );

      expect(res.status).toBe(204);
      expect(sessionService.recordCommandAck).toHaveBeenCalledWith({
        threadId: "thread-1",
        sessionId: "sess-1",
        payload: {
          commands: [
            {
              commandId: "cmd-1",
              channelId: "thread-1",
              state: "received",
            },
          ],
          deliveredThrough: 3,
        },
      });
    });
  });

  describe("POST /threads/:id/environment-agent/session/commands/result", () => {
    it("records command lifecycle results", async () => {
      const sessionService = mockEnvironmentAgentSessionService();
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(makeThread());
      app = new Hono().route(
        "/threads",
        createThreadRoutes(threadManager, {
          environmentAgentSessionService: sessionService,
        }),
      );

      const res = await app.request(
        "/threads/thread-1/environment-agent/session/commands/result",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: "sess-1",
            commandId: "cmd-1",
            channelId: "thread-1",
            state: "failed",
            errorCode: "provider_error",
            errorMessage: "runtime down",
          }),
        },
      );

      expect(res.status).toBe(204);
      expect(sessionService.recordCommandResult).toHaveBeenCalledWith({
        threadId: "thread-1",
        sessionId: "sess-1",
        payload: {
          commandId: "cmd-1",
          channelId: "thread-1",
          state: "failed",
          errorCode: "provider_error",
          errorMessage: "runtime down",
        },
      });
    });
  });

  describe("POST /threads/:id/environment-agent/session/close", () => {
    it("closes an active session", async () => {
      const sessionService = mockEnvironmentAgentSessionService();
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(makeThread());
      app = new Hono().route(
        "/threads",
        createThreadRoutes(threadManager, {
          environmentAgentSessionService: sessionService,
        }),
      );

      const res = await app.request(
        "/threads/thread-1/environment-agent/session/close",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: "sess-1",
            reason: "agent_shutdown",
          }),
        },
      );

      expect(res.status).toBe(204);
      expect(sessionService.closeSession).toHaveBeenCalledWith({
        threadId: "thread-1",
        sessionId: "sess-1",
        reason: "agent_shutdown",
      });
    });
  });

  describe("GET /threads/:id/environment-agent/session/commands", () => {
    it("returns command batches for the active session", async () => {
      const sessionService = mockEnvironmentAgentSessionService();
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread(),
      );
      (sessionService.listCommands as ReturnType<typeof vi.fn>).mockReturnValue({
        protocol: "beanbag.env-agent.v1",
        type: "command_batch",
        messageId: "msg-1",
        sessionId: "sess-1",
        sentAt: 1_000,
        payload: {
          commands: [
            {
              channelId: "thread-1",
              commandCursor: 2,
              commandId: "cmd-1",
              createdAt: 900,
              command: {
                type: "workspace.status",
                threadId: "thread-1",
              },
            },
          ],
        },
      });
      app = new Hono().route(
        "/threads",
        createThreadRoutes(threadManager, {
          environmentAgentSessionService: sessionService,
        }),
      );

      const res = await app.request(
        "/threads/thread-1/environment-agent/session/commands?sessionId=sess-1&afterCursor=1&limit=10",
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        type: "command_batch",
        sessionId: "sess-1",
      });
      expect(sessionService.listCommands).toHaveBeenCalledWith({
        threadId: "thread-1",
        sessionId: "sess-1",
        afterCursor: 1,
        limit: 10,
      });
    });
  });

  describe("GET /threads", () => {
    it("lists threads", async () => {
      const threads = [makeThread(), makeThread({ id: "thread-2" })];
      (threadManager.list as ReturnType<typeof vi.fn>).mockReturnValue(
        threads,
      );

      const res = await app.request("/threads");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(2);
    });

    it("uses async listing when work status is requested", async () => {
      const threads = [makeThread({ workStatus: makeWorkStatus() })];
      (threadManager.listAsync as ReturnType<typeof vi.fn>).mockResolvedValue(
        threads,
      );

      const res = await app.request("/threads?includeWorkStatus=true");

      expect(res.status).toBe(200);
      expect(threadManager.listAsync).toHaveBeenCalledWith({
        includeWorkStatus: true,
      });
      expect(threadManager.list).not.toHaveBeenCalled();
    });

    it("lists threads with project filter", async () => {
      (threadManager.list as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const res = await app.request(
        "/threads?projectId=proj-1",
      );

      expect(res.status).toBe(200);
      expect(threadManager.list).toHaveBeenCalledWith({
        projectId: "proj-1",
      });
    });

  });

  describe("GET /threads/:id", () => {
    it("returns a thread by id", async () => {
      const thread = makeThread();
      (threadManager.getHydratedByIdAsync as ReturnType<typeof vi.fn>).mockResolvedValue(
        thread,
      );

      const res = await app.request("/threads/thread-1");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("thread-1");
      expect(body.status).toBe("active");
    });

    it("returns 404 for nonexistent thread", async () => {
      (threadManager.getHydratedByIdAsync as ReturnType<typeof vi.fn>).mockResolvedValue(
        undefined,
      );

      const res = await app.request("/threads/nonexistent");

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("Thread nonexistent not found");
      expect(body.code).toBe("thread_not_found");
    });
  });

  describe("GET /threads/:id/default-execution-options", () => {
    it("returns defaults when present", async () => {
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread(),
      );
      (threadManager.getDefaultExecutionOptions as ReturnType<typeof vi.fn>).mockReturnValue({
        model: "gpt-5-codex",
        serviceTier: "fast",
        reasoningLevel: "high",
        sandboxMode: "workspace-write",
        source: "client/turn/start",
        seq: 42,
      });

      const res = await app.request("/threads/thread-1/default-execution-options");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        model: "gpt-5-codex",
        serviceTier: "fast",
        reasoningLevel: "high",
        sandboxMode: "workspace-write",
        source: "client/turn/start",
        seq: 42,
      });
    });

    it("returns null when defaults are absent", async () => {
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread(),
      );
      (threadManager.getDefaultExecutionOptions as ReturnType<typeof vi.fn>).mockReturnValue(
        undefined,
      );

      const res = await app.request("/threads/thread-1/default-execution-options");
      expect(res.status).toBe(200);
      expect(await res.json()).toBeNull();
    });
  });

  describe("POST /threads/:id/tell", () => {
    it("sends text input to the thread", async () => {
      const thread = makeThread();
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        thread,
      );

      const res = await app.request("/threads/thread-1/tell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: [{ type: "text", text: "Do more stuff" }],
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(threadManager.tell).toHaveBeenCalledWith(
        "thread-1",
        { input: [{ type: "text", text: "Do more stuff" }] },
      );
    });

    it("sends multimodal input payload to the thread", async () => {
      const thread = makeThread();
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        thread,
      );

      const res = await app.request("/threads/thread-1/tell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: [
            { type: "text", text: "Check these" },
            { type: "image", url: "https://example.com/mock.png" },
            { type: "localImage", path: "/tmp/mock.png" },
          ],
        }),
      });

      expect(res.status).toBe(200);
      expect(threadManager.tell).toHaveBeenCalledWith("thread-1", {
        input: [
          { type: "text", text: "Check these" },
          { type: "image", url: "https://example.com/mock.png" },
          { type: "localImage", path: "/tmp/mock.png" },
        ],
      });
    });

    it("forwards model and reasoning overrides when provided", async () => {
      const thread = makeThread();
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        thread,
      );

      const res = await app.request("/threads/thread-1/tell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: [{ type: "text", text: "Do more stuff" }],
          model: "gpt-5-codex",
          reasoningLevel: "high",
        }),
      });

      expect(res.status).toBe(200);
      expect(threadManager.tell).toHaveBeenCalledWith(
        "thread-1",
        { input: [{ type: "text", text: "Do more stuff" }] },
        { model: "gpt-5-codex", reasoningLevel: "high" },
      );
    });

    it("forwards service tier override when provided", async () => {
      const thread = makeThread();
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);

      const res = await app.request("/threads/thread-1/tell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: [{ type: "text", text: "Do more stuff" }],
          serviceTier: "fast",
        }),
      });

      expect(res.status).toBe(200);
      expect(threadManager.tell).toHaveBeenCalledWith(
        "thread-1",
        { input: [{ type: "text", text: "Do more stuff" }] },
        expect.objectContaining({ serviceTier: "fast" }),
      );
    });

    it("forwards sandbox mode override when provided", async () => {
      const thread = makeThread();
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        thread,
      );

      const res = await app.request("/threads/thread-1/tell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: [{ type: "text", text: "Do more stuff" }],
          sandboxMode: "workspace-write",
        }),
      });

      expect(res.status).toBe(200);
      expect(threadManager.tell).toHaveBeenCalledWith(
        "thread-1",
        { input: [{ type: "text", text: "Do more stuff" }] },
        expect.objectContaining({ sandboxMode: "workspace-write" }),
      );
    });

    it("forwards tell mode when provided", async () => {
      const thread = makeThread();
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        thread,
      );

      const res = await app.request("/threads/thread-1/tell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: [{ type: "text", text: "Do more stuff" }],
          mode: "steer",
        }),
      });

      expect(res.status).toBe(200);
      expect(threadManager.tell).toHaveBeenCalledWith(
        "thread-1",
        { input: [{ type: "text", text: "Do more stuff" }], mode: "steer" },
      );
    });

    it("demotes active primary checkout before telling when requested", async () => {
      const thread = makeThread({ status: "idle" });
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
      (threadManager.isPrimaryCheckoutActive as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (threadManager.demotePrimaryCheckout as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        demoted: true,
        message: "Primary checkout demoted",
        primaryStatus: { projectId: "proj-1" },
      });

      const res = await app.request("/threads/thread-1/tell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: [{ type: "text", text: "Do more stuff" }],
          demotePrimaryIfNeeded: true,
        }),
      });

      expect(res.status).toBe(200);
      expect(threadManager.isPrimaryCheckoutActive).toHaveBeenCalledWith("thread-1");
      expect(threadManager.demotePrimaryCheckout).toHaveBeenCalledWith("thread-1");
      expect(threadManager.tell).toHaveBeenCalledWith(
        "thread-1",
        { input: [{ type: "text", text: "Do more stuff" }] },
      );
      const demoteCallOrder = (threadManager.demotePrimaryCheckout as ReturnType<typeof vi.fn>)
        .mock.invocationCallOrder[0];
      const tellCallOrder = (threadManager.tell as ReturnType<typeof vi.fn>)
        .mock.invocationCallOrder[0];
      expect(demoteCallOrder).toBeLessThan(tellCallOrder);
    });

    it("does not demote when tell mode is steer", async () => {
      const thread = makeThread({ status: "active" });
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
      (threadManager.isPrimaryCheckoutActive as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const res = await app.request("/threads/thread-1/tell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: [{ type: "text", text: "Do more stuff" }],
          mode: "steer",
          demotePrimaryIfNeeded: true,
        }),
      });

      expect(res.status).toBe(200);
      expect(threadManager.demotePrimaryCheckout).not.toHaveBeenCalled();
      expect(threadManager.tell).toHaveBeenCalledWith(
        "thread-1",
        { input: [{ type: "text", text: "Do more stuff" }], mode: "steer" },
      );
    });

    it("returns 404 when thread not found", async () => {
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        undefined,
      );

      const res = await app.request("/threads/nonexistent/tell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: [{ type: "text", text: "hello" }] }),
      });

      expect(res.status).toBe(404);
      expect(threadManager.tell).not.toHaveBeenCalled();
    });

    it("returns 409 when thread is inactive", async () => {
      const thread = makeThread({ status: "idle" });
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        thread,
      );
      (threadManager.tell as ReturnType<typeof vi.fn>).mockImplementation(
        () => {
          throw inactiveSessionError("Thread thread-1 has no active process");
        },
      );

      const res = await app.request("/threads/thread-1/tell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: [{ type: "text", text: "hello" }],
        }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe("Thread thread-1 has no active process");
      expect(body.code).toBe("inactive_session");
    });

    it("returns 409 when tell rejects asynchronously for inactive thread", async () => {
      const thread = makeThread({ status: "idle" });
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        thread,
      );
      (threadManager.tell as ReturnType<typeof vi.fn>).mockRejectedValue(
        inactiveSessionError("Thread thread-1 has no codex session"),
      );

      const res = await app.request("/threads/thread-1/tell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: [{ type: "text", text: "hello again" }],
        }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe("Thread thread-1 has no codex session");
      expect(body.code).toBe("inactive_session");
    });

    it("returns 409 when thread is archived", async () => {
      const thread = makeThread({ status: "idle", archivedAt: 1234 });
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        thread,
      );
      (threadManager.tell as ReturnType<typeof vi.fn>).mockRejectedValue(
        threadArchivedError("thread-1"),
      );

      const res = await app.request("/threads/thread-1/tell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: [{ type: "text", text: "hello archive" }],
        }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe("Thread thread-1 is archived");
      expect(body.code).toBe("thread_archived");
    });

    it("returns 400 for missing input", async () => {
      const res = await app.request("/threads/thread-1/tell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 when tell payload includes relative local attachment path", async () => {
      const thread = makeThread();
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        thread,
      );

      const res = await app.request("/threads/thread-1/tell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: [{ type: "localImage", path: "relative/image.png" }],
        }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        code: "invalid_request",
        error: "Attachment path must be absolute",
        message: "Attachment path must be absolute",
      });
      expect(threadManager.tell).not.toHaveBeenCalled();
    });
  });

  describe("queued follow-up routes", () => {
    it("uses raw lookup before enqueueing a follow-up", async () => {
      const thread = makeThread({
        queuedMessages: [],
      });
      const queuedThread = makeThread({
        queuedMessages: [
          {
            id: "queued-1",
            input: [{ type: "text", text: "Queued item" }],
            reasoningLevel: "medium",
            sandboxMode: "danger-full-access",
            createdAt: 2000,
          },
        ],
      });
      const getRawById = threadManager.getRawById.mockReturnValue(thread);
      (threadManager.getById as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("Expected route to use raw thread lookup");
      });
      (threadManager.enqueueFollowUp as ReturnType<typeof vi.fn>).mockReturnValue(
        queuedThread,
      );

      const res = await app.request("/threads/thread-1/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: [{ type: "text", text: "Queued item" }],
          reasoningLevel: "medium",
          sandboxMode: "danger-full-access",
        }),
      });

      expect(res.status).toBe(201);
      expect(getRawById).toHaveBeenCalledWith("thread-1");
      expect(threadManager.getById).not.toHaveBeenCalled();
    });

    it("queues a follow-up and returns the persisted queue item", async () => {
      const thread = makeThread({
        queuedMessages: [],
      });
      const queuedThread = makeThread({
        queuedMessages: [
          {
            id: "queued-1",
            input: [{ type: "text", text: "Queued item" }],
            model: "gpt-5-codex",
            reasoningLevel: "medium",
            sandboxMode: "danger-full-access",
            createdAt: 2000,
          },
        ],
      });
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
      (threadManager.enqueueFollowUp as ReturnType<typeof vi.fn>).mockReturnValue(
        queuedThread,
      );

      const res = await app.request("/threads/thread-1/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: [{ type: "text", text: "Queued item" }],
          model: "gpt-5-codex",
          reasoningLevel: "medium",
          sandboxMode: "danger-full-access",
        }),
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({
        id: "queued-1",
        input: [{ type: "text", text: "Queued item" }],
      });
      expect(threadManager.enqueueFollowUp).toHaveBeenCalledWith("thread-1", {
        input: [{ type: "text", text: "Queued item" }],
        model: "gpt-5-codex",
        reasoningLevel: "medium",
        sandboxMode: "danger-full-access",
      });
    });

    it("sends a queued follow-up", async () => {
      const thread = makeThread();
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
      (threadManager.sendQueuedFollowUp as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        queuedMessage: {
          id: "queued-1",
          input: [{ type: "text", text: "Queued item" }],
          reasoningLevel: "medium",
          sandboxMode: "danger-full-access",
          createdAt: 2000,
        },
      });

      const res = await app.request("/threads/thread-1/queue/queued-1/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "steer-if-active" }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        ok: true,
      });
      expect(threadManager.sendQueuedFollowUp).toHaveBeenCalledWith(
        "thread-1",
        "queued-1",
        { mode: "steer-if-active" },
      );
    });

    it("deletes a queued follow-up", async () => {
      const thread = makeThread();
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);

      const res = await app.request("/threads/thread-1/queue/queued-1", {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(threadManager.removeQueuedFollowUp).toHaveBeenCalledWith(
        "thread-1",
        "queued-1",
      );
    });
  });

  describe("POST /threads/:id/stop", () => {
    it("stops a thread", async () => {
      const thread = makeThread();
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        thread,
      );

      const res = await app.request("/threads/thread-1/stop", {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(threadManager.stop).toHaveBeenCalledWith("thread-1");
    });

    it("returns 404 when thread not found", async () => {
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        undefined,
      );

      const res = await app.request("/threads/nonexistent/stop", {
        method: "POST",
      });

      expect(res.status).toBe(404);
      expect(threadManager.stop).not.toHaveBeenCalled();
    });
  });

  describe("POST /threads/:id/promote", () => {
    it("promotes a thread into primary checkout", async () => {
      const thread = makeThread({ environmentId: "worktree" });
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
      (threadManager.promoteThread as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        promoted: true,
        message: "Primary checkout promoted",
        primaryStatus: {
          projectId: thread.projectId,
          activeThreadId: thread.id,
        },
      });

      const res = await app.request("/threads/thread-1/promote", {
        method: "POST",
      });

      expect(res.status).toBe(200);
      expect(threadManager.promoteThread).toHaveBeenCalledWith("thread-1");
      expect(await res.json()).toMatchObject({
        ok: true,
        promoted: true,
      });
    });
  });

  describe("POST /threads/:id/demote-primary", () => {
    it("demotes an active primary checkout thread", async () => {
      const thread = makeThread({ environmentId: "worktree" });
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
      (threadManager.demotePrimaryCheckout as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        demoted: true,
        message: "Primary checkout demoted",
        primaryStatus: {
          projectId: thread.projectId,
        },
      });

      const res = await app.request("/threads/thread-1/demote-primary", {
        method: "POST",
      });

      expect(res.status).toBe(200);
      expect(threadManager.demotePrimaryCheckout).toHaveBeenCalledWith("thread-1");
      expect(await res.json()).toMatchObject({
        ok: true,
        demoted: true,
      });
    });
  });

  describe("POST /threads/:id/operations", () => {
    it("requests a commit operation intent", async () => {
      const thread = makeThread({ status: "idle" });
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
      (threadManager.requestThreadOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        operationId: "op-1",
        operation: "commit",
        status: "accepted",
        executionStatus: "running",
        queued: false,
        message: "Commit operation accepted and running",
        demotedPrimaryCheckout: false,
      });

      const res = await app.request("/threads/thread-1/operations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "commit",
          options: {
            includeUnstaged: true,
            message: "feat: test",
          },
        }),
      });

      expect(res.status).toBe(202);
      expect(threadManager.requestThreadOperation).toHaveBeenCalledWith("thread-1", {
        operation: "commit",
        options: {
          includeUnstaged: true,
          message: "feat: test",
        },
      });
      expect(await res.json()).toMatchObject({
        ok: true,
        operation: "commit",
      });
    });

    it("returns 400 for invalid operation payloads", async () => {
      const thread = makeThread({ status: "idle" });
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);

      const res = await app.request("/threads/thread-1/operations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "unknown",
        }),
      });

      expect(res.status).toBe(400);
      expect(threadManager.requestThreadOperation).not.toHaveBeenCalled();
    });
  });

  describe("POST /threads/:id/archive", () => {
    it("archives a thread", async () => {
      const thread = makeThread();
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        thread,
      );

      const res = await app.request("/threads/thread-1/archive", {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(threadManager.archive).toHaveBeenCalledWith("thread-1");
    });

    it("returns 409 when worktree has uncommitted work and force is not set", async () => {
      const thread = makeThread({ environmentId: "worktree" });
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        thread,
      );
      (threadManager.requiresForceArchive as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (threadManager.getWorkStatus as ReturnType<typeof vi.fn>).mockReturnValue({
        state: "dirty_uncommitted",
      });

      const res = await app.request("/threads/thread-1/archive", {
        method: "POST",
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error:
          "Thread workspace has uncommitted or unmerged work. Archiving may lose work; retry with force=true.",
        code: "worktree_not_clean",
        workStatusState: "dirty_uncommitted",
      });
      expect(threadManager.archive).not.toHaveBeenCalled();
    });

    it("uses async work status when available", async () => {
      const thread = makeThread({ environmentId: "worktree" });
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
      (threadManager.requiresForceArchive as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const getWorkStatusAsync = vi.fn().mockResolvedValue({
        state: "dirty_uncommitted",
      });
      (threadManager as ThreadOrchestrator & {
        getWorkStatusAsync?: typeof getWorkStatusAsync;
      }).getWorkStatusAsync = getWorkStatusAsync;
      (threadManager.getWorkStatus as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("sync should not be used");
      });

      const res = await app.request("/threads/thread-1/archive", {
        method: "POST",
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error:
          "Thread workspace has uncommitted or unmerged work. Archiving may lose work; retry with force=true.",
        code: "worktree_not_clean",
        workStatusState: "dirty_uncommitted",
      });
      expect(getWorkStatusAsync).toHaveBeenCalledWith("thread-1");
      expect(threadManager.archive).not.toHaveBeenCalled();
    });

    it("archives a dirty worktree thread when force=true", async () => {
      const thread = makeThread({ environmentId: "worktree" });
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        thread,
      );
      (threadManager.requiresForceArchive as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (threadManager.getWorkStatus as ReturnType<typeof vi.fn>).mockReturnValue({
        state: "dirty_and_committed_unmerged",
      });

      const res = await app.request("/threads/thread-1/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(threadManager.archive).toHaveBeenCalledWith("thread-1");
    });

    it("returns 404 when thread not found", async () => {
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        undefined,
      );

      const res = await app.request("/threads/nonexistent/archive", {
        method: "POST",
      });

      expect(res.status).toBe(404);
      expect(threadManager.archive).not.toHaveBeenCalled();
    });
  });

  describe("POST /threads/:id/unarchive", () => {
    it("unarchives a thread", async () => {
      const thread = makeThread({ archivedAt: 1234 });
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        thread,
      );

      const res = await app.request("/threads/thread-1/unarchive", {
        method: "POST",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(threadManager.unarchive).toHaveBeenCalledWith("thread-1");
    });

    it("returns 404 when thread not found", async () => {
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        undefined,
      );

      const res = await app.request("/threads/nonexistent/unarchive", {
        method: "POST",
      });

      expect(res.status).toBe(404);
      expect(threadManager.unarchive).not.toHaveBeenCalled();
    });
  });


  describe("POST /threads/:id/read", () => {
    it("marks a thread as read", async () => {
      const thread = makeThread({ lastReadAt: 1000, updatedAt: 2000 });
      const updatedThread = makeThread({ lastReadAt: 2000, updatedAt: 2000 });
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        thread,
      );
      (threadManager.markRead as ReturnType<typeof vi.fn>).mockReturnValue(
        updatedThread,
      );

      const res = await app.request("/threads/thread-1/read", {
        method: "POST",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(updatedThread);
      expect(threadManager.markRead).toHaveBeenCalledWith("thread-1");
    });

    it("returns 404 when thread not found", async () => {
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        undefined,
      );

      const res = await app.request("/threads/nonexistent/read", {
        method: "POST",
      });

      expect(res.status).toBe(404);
      expect(threadManager.markRead).not.toHaveBeenCalled();
    });
  });

  describe("GET /threads/:id/primary-status", () => {
    it("returns primary checkout status for the thread project", async () => {
      const thread = makeThread({ projectId: "proj-1" });
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
      (threadManager.getPrimaryCheckoutStatus as ReturnType<typeof vi.fn>).mockReturnValue({
        projectId: "proj-1",
        activeThreadId: "thread-1",
      });

      const res = await app.request("/threads/thread-1/primary-status");

      expect(res.status).toBe(200);
      expect(threadManager.getPrimaryCheckoutStatus).toHaveBeenCalledWith("proj-1");
      expect(await res.json()).toEqual({
        projectId: "proj-1",
        activeThreadId: "thread-1",
      });
    });
  });

  describe("GET /threads/:id/work-status", () => {
    it("uses raw lookup before reading async work status", async () => {
      const thread = makeThread();
      const workStatus = makeWorkStatus();
      threadManager.getRawById.mockReturnValue(thread);
      threadManager.getHydratedByIdAsync.mockResolvedValue(thread);
      threadManager.getWorkStatusAsync.mockResolvedValue(workStatus);

      const res = await app.request("/threads/thread-1/work-status");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(workStatus);
      expect(threadManager.getRawById).toHaveBeenCalledWith("thread-1");
      expect(threadManager.getHydratedByIdAsync).not.toHaveBeenCalled();
      expect(threadManager.getWorkStatusAsync).toHaveBeenCalledWith("thread-1", undefined);
    });
  });

  describe("GET /threads/:id/merge-base-branches", () => {
    it("returns merge-base branch options without hydrating the thread", async () => {
      const thread = makeThread();
      threadManager.getRawById.mockReturnValue(thread);
      threadManager.getHydratedByIdAsync.mockResolvedValue(thread);
      threadManager.getMergeBaseBranchesAsync.mockResolvedValue(["main", "release/1.0"]);

      const res = await app.request("/threads/thread-1/merge-base-branches");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(["main", "release/1.0"]);
      expect(threadManager.getRawById).toHaveBeenCalledWith("thread-1");
      expect(threadManager.getHydratedByIdAsync).not.toHaveBeenCalled();
      expect(threadManager.getMergeBaseBranchesAsync).toHaveBeenCalledWith("thread-1");
    });
  });

  describe("route lookup guardrails", () => {
    it("avoids hydrated lookup when archiving with async work-status checks", async () => {
      const thread = makeThread({ environmentId: "worktree" });
      threadManager.getRawById.mockReturnValue(thread);
      threadManager.getHydratedByIdAsync.mockResolvedValue(thread);
      (threadManager.requiresForceArchive as ReturnType<typeof vi.fn>).mockReturnValue(true);
      threadManager.getWorkStatusAsync.mockResolvedValue({ state: "dirty_uncommitted" });

      const res = await app.request("/threads/thread-1/archive", {
        method: "POST",
      });

      expect(res.status).toBe(409);
      expect(threadManager.getRawById).toHaveBeenCalledWith("thread-1");
      expect(threadManager.getHydratedByIdAsync).not.toHaveBeenCalled();
      expect(threadManager.getWorkStatusAsync).toHaveBeenCalledWith("thread-1");
    });

    it("avoids hydrated lookup when computing git diff", async () => {
      const thread = makeThread({ status: "idle" });
      threadManager.getRawById.mockReturnValue(thread);
      threadManager.getHydratedByIdAsync.mockResolvedValue(thread);
      threadManager.getGitDiffAsync.mockResolvedValue({
        mode: "local_uncommitted",
        commits: [],
        selection: { type: "combined" },
        diff: "diff --git a/file b/file",
        truncated: false,
      });

      const res = await app.request("/threads/thread-1/git-diff");

      expect(res.status).toBe(200);
      expect(threadManager.getRawById).toHaveBeenCalledWith("thread-1");
      expect(threadManager.getHydratedByIdAsync).not.toHaveBeenCalled();
      expect(threadManager.getGitDiffAsync).toHaveBeenCalledWith(
        "thread-1",
        { type: "combined" },
        undefined,
      );
    });
  });

  describe("GET /threads/:id/events", () => {
    it("returns events for a thread", async () => {
      const thread = makeThread();
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        thread,
      );

      const events = [makeEvent({ seq: 1 }), makeEvent({ seq: 2, id: "evt-2" })];
      (threadManager.getEvents as ReturnType<typeof vi.fn>).mockReturnValue(
        events,
      );

      const res = await app.request("/threads/thread-1/events");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(2);
      expect(body[0].seq).toBe(1);
      expect(body[1].seq).toBe(2);
      expect(threadManager.getEvents).toHaveBeenCalledWith(
        "thread-1",
        undefined,
        undefined,
      );
    });

    it("passes afterSeq query param", async () => {
      const thread = makeThread();
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        thread,
      );
      (threadManager.getEvents as ReturnType<typeof vi.fn>).mockReturnValue(
        [],
      );

      const res = await app.request("/threads/thread-1/events?afterSeq=5");

      expect(res.status).toBe(200);
      expect(threadManager.getEvents).toHaveBeenCalledWith(
        "thread-1",
        5,
        undefined,
      );
    });

    it("returns 404 when thread not found", async () => {
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        undefined,
      );

      const res = await app.request("/threads/nonexistent/events");

      expect(res.status).toBe(404);
      expect(threadManager.getEvents).not.toHaveBeenCalled();
    });
  });

  describe("GET /threads/:id/timeline", () => {
    it("returns projected timeline rows", async () => {
      const thread = makeThread();
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
      (threadManager.getTimeline as ReturnType<typeof vi.fn>).mockReturnValue({
        rows: [],
      });

      const res = await app.request("/threads/thread-1/timeline?limit=120");

      expect(res.status).toBe(200);
      expect(threadManager.getTimeline).toHaveBeenCalledWith(
        "thread-1",
        120,
        false,
      );
    });
  });

  describe("GET /threads/:id/tool-group-messages", () => {
    it("returns deferred tool-group messages", async () => {
      const thread = makeThread();
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
      (threadManager.getToolGroupMessages as ReturnType<typeof vi.fn>).mockReturnValue({
        messages: [],
      });

      const res = await app.request(
        "/threads/thread-1/tool-group-messages?turnId=turn-1&sourceSeqStart=3&sourceSeqEnd=8",
      );

      expect(res.status).toBe(200);
      expect(threadManager.getToolGroupMessages).toHaveBeenCalledWith("thread-1", {
        turnId: "turn-1",
        sourceSeqStart: 3,
        sourceSeqEnd: 8,
      });
    });
  });

  describe("GET /threads/:id/git-diff", () => {
    it("returns git diff payload for combined selection", async () => {
      const thread = makeThread({ status: "idle" });
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
      (threadManager.getGitDiff as ReturnType<typeof vi.fn>).mockReturnValue({
        mode: "local_uncommitted",
        commits: [],
        selection: { type: "combined" },
        diff: "diff --git a/file b/file",
        truncated: false,
      });

      const res = await app.request("/threads/thread-1/git-diff");

      expect(res.status).toBe(200);
      expect(threadManager.getGitDiff).toHaveBeenCalledWith(
        "thread-1",
        { type: "combined" },
        undefined,
      );
    });

    it("returns 400 when commit selection is missing commitSha", async () => {
      const thread = makeThread({ status: "idle" });
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);

      const res = await app.request("/threads/thread-1/git-diff?selection=commit");

      expect(res.status).toBe(400);
      expect(threadManager.getGitDiff).not.toHaveBeenCalled();
    });
  });

  describe("POST /threads/:id/open-path", () => {
    it("resolves the thread path and opens it", async () => {
      const openPath = vi.fn();
      app = new Hono().route(
        "/threads",
        createThreadRoutes(threadManager, { openPath }),
      );
      (threadManager.resolveThreadOpenPath as ReturnType<typeof vi.fn>).mockReturnValue(
        "/tmp/worktrees/thread-1/src/file.ts",
      );

      const res = await app.request("/threads/thread-1/open-path", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          relativePath: "src/file.ts",
          target: "file",
          editor: "cursor",
        }),
      });

      expect(res.status).toBe(200);
      expect(threadManager.resolveThreadOpenPath).toHaveBeenCalledWith(
        "thread-1",
        "src/file.ts",
      );
      expect(openPath).toHaveBeenCalledWith({
        path: "/tmp/worktrees/thread-1/src/file.ts",
        target: "file",
        editor: "cursor",
      });
    });
  });

  describe("GET /threads/:id/output", () => {
    it("returns output for a thread", async () => {
      const thread = makeThread({ status: "idle" });
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        thread,
      );
      (threadManager.getOutput as ReturnType<typeof vi.fn>).mockReturnValue(
        "Final answer",
      );

      const res = await app.request("/threads/thread-1/output");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.output).toBe("Final answer");
    });

    it("returns null output when no output available", async () => {
      const thread = makeThread();
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        thread,
      );
      (threadManager.getOutput as ReturnType<typeof vi.fn>).mockReturnValue(
        undefined,
      );

      const res = await app.request("/threads/thread-1/output");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.output).toBeNull();
    });

    it("returns 404 when thread not found", async () => {
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        undefined,
      );

      const res = await app.request("/threads/nonexistent/output");

      expect(res.status).toBe(404);
      expect(threadManager.getOutput).not.toHaveBeenCalled();
    });
  });
});
