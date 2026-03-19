import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { EnvironmentRecord, ThreadOrchestrator } from "@bb/core";
import { createEnvironmentRoutes } from "../../routes/environments.js";
import type { EnvironmentRepository } from "@bb/db";

function makeEnvironment(
  overrides: Partial<EnvironmentRecord> = {},
): EnvironmentRecord {
  return {
    id: "env-1",
    projectId: "proj-1",
    descriptor: {
      type: "path",
      path: "/tmp/project",
    },
    managed: false,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe("Environment routes", () => {
  let environmentRepo: EnvironmentRepository;
  let threadManager: ThreadOrchestrator;
  let app: Hono;

  beforeEach(() => {
    environmentRepo = {
      getById: vi.fn(),
      list: vi.fn(() => []),
    } as unknown as EnvironmentRepository;
    threadManager = {
      requestEnvironmentOperation: vi.fn(),
    } as unknown as ThreadOrchestrator;
    app = new Hono().route("/environments", createEnvironmentRoutes(environmentRepo, threadManager));
  });

  it("lists environments", async () => {
    (environmentRepo.list as ReturnType<typeof vi.fn>).mockReturnValue([
      makeEnvironment(),
    ]);

    const res = await app.request("/environments?projectId=proj-1");

    expect(res.status).toBe(200);
    expect(environmentRepo.list).toHaveBeenCalledWith({ projectId: "proj-1" });
    const body = await res.json();
    expect(body).toEqual([makeEnvironment()]);
  });

  it("returns an environment by id", async () => {
    (environmentRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      makeEnvironment({ id: "env-2", managed: true }),
    );

    const res = await app.request("/environments/env-2");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      id: "env-2",
      managed: true,
    });
  });

  it("dispatches environment operations through the orchestrator", async () => {
    (environmentRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      makeEnvironment({ id: "env-2", managed: true }),
    );
    (threadManager.requestEnvironmentOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      promoted: true,
      message: "Primary checkout promoted",
      primaryStatus: {
        projectId: "proj-1",
        activeEnvironmentId: "env-2",
        activeThreadId: "thread-1",
      },
    });

    const res = await app.request("/environments/env-2/operations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "promote_primary", initiatingThreadId: "thread-1" }),
    });

    expect(res.status).toBe(200);
    expect(threadManager.requestEnvironmentOperation).toHaveBeenCalledWith("env-2", {
      operation: "promote_primary",
      initiatingThreadId: "thread-1",
    });
  });

  it("dispatches commit operations with initiating thread context", async () => {
    (environmentRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      makeEnvironment({ id: "env-2", managed: true }),
    );
    (threadManager.requestEnvironmentOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      operationId: "op-1",
      operation: "commit",
      status: "accepted",
      executionStatus: "running",
      queued: false,
      message: "Commit operation accepted and running",
      demotedPrimaryCheckout: false,
    });

    const res = await app.request("/environments/env-2/operations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operation: "commit",
        initiatingThreadId: "thread-1",
        options: {
          includeUnstaged: true,
          message: "feat: test",
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(threadManager.requestEnvironmentOperation).toHaveBeenCalledWith("env-2", {
      operation: "commit",
      initiatingThreadId: "thread-1",
      options: {
        includeUnstaged: true,
        message: "feat: test",
      },
    });
  });
});
