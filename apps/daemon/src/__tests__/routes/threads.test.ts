import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Thread, ThreadEvent } from "@beanbag/core";
import { createThreadRoutes } from "../../routes/threads.js";
import type { ThreadManager } from "../../thread-manager.js";
import { inactiveSessionError, threadArchivedError } from "../../domain-errors.js";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    projectId: "proj-1",
    status: "active",
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

function mockThreadManager(): ThreadManager {
  return {
    spawn: vi.fn(),
    tell: vi.fn(),
    stop: vi.fn(),
    archive: vi.fn(),
    getById: vi.fn(),
    list: vi.fn(),
    getEvents: vi.fn(),
    getOutput: vi.fn(),
    isActive: vi.fn(),
    getActiveCount: vi.fn(),
    stopAll: vi.fn(),
  } as unknown as ThreadManager;
}

describe("Thread routes", () => {
  let threadManager: ReturnType<typeof mockThreadManager>;
  let app: Hono;

  beforeEach(() => {
    threadManager = mockThreadManager();
    const routes = createThreadRoutes(threadManager as any);
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
        ],
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
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        thread,
      );

      const res = await app.request("/threads/thread-1");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("thread-1");
      expect(body.status).toBe("active");
    });

    it("returns 404 for nonexistent thread", async () => {
      (threadManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        undefined,
      );

      const res = await app.request("/threads/nonexistent");

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("Thread nonexistent not found");
      expect(body.code).toBe("thread_not_found");
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
      expect(threadManager.getEvents).toHaveBeenCalledWith("thread-1", 5);
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
