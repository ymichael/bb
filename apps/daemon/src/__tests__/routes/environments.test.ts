import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { EnvironmentRecord } from "@beanbag/agent-core";
import { createEnvironmentRoutes } from "../../routes/environments.js";
import type { EnvironmentRepository } from "@beanbag/db";

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
  let app: Hono;

  beforeEach(() => {
    environmentRepo = {
      getById: vi.fn(),
      list: vi.fn(() => []),
    } as unknown as EnvironmentRepository;
    app = new Hono().route("/environments", createEnvironmentRoutes(environmentRepo));
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
});
