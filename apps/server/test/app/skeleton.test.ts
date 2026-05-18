import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hosts } from "@bb/db";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import { initDb } from "../../src/db.js";
import { createApp } from "../../src/server.js";
import { readJson } from "../helpers/json.js";
import {
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";

describe("server skeleton", () => {
  it("serves public routes without auth", async () => {
    const harness = await createTestAppHarness();
    try {
      const response = await harness.app.request("/api/v1/hosts");
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects internal routes without a bearer token", async () => {
    const harness = await createTestAppHarness();
    try {
      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostId: "host-1",
          instanceId: "instance-1",
          hostName: "Host",
          hostType: "persistent",
          dataDir: "/tmp/host-data",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        }),
      });

      expect(response.status).toBe(401);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "unauthorized",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("returns structured invalid_request errors for malformed JSON", async () => {
    const harness = await createTestAppHarness();
    try {
      const response = await harness.app.request("/api/v1/projects", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: "{",
      });

      expect(response.status).toBe(400);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("logs public API requests that exceed the slow request threshold", async () => {
    const harness = await createTestAppHarness();
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const serverApp = createApp(
      {
        ...harness.deps,
        logger,
      },
      {
        slowApiRequestLogThresholdMs: 0,
      },
    );
    try {
      const response = await serverApp.app.request("/api/v1/hosts");
      expect(response.status).toBe(200);
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          durationMs: expect.any(Number),
          method: "GET",
          path: "/api/v1/hosts",
          status: 200,
        }),
        "Slow API request",
      );
    } finally {
      await serverApp.closeWebSockets();
      await harness.cleanup();
    }
  });

  it("does not log slow API requests for thread event long-poll waits", async () => {
    const harness = await createTestAppHarness();
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const serverApp = createApp(
      {
        ...harness.deps,
        logger,
      },
      {
        slowApiRequestLogThresholdMs: 0,
      },
    );
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-slow-api-events-wait",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const thread = seedThread(harness.deps, { projectId: project.id });

      const response = await serverApp.app.request(
        `/api/v1/threads/${thread.id}/events/wait?type=turn%2Fstarted&waitMs=0`,
      );

      expect(response.status).toBe(204);
      expect(logger.debug).not.toHaveBeenCalled();
    } finally {
      await serverApp.closeWebSockets();
      await harness.cleanup();
    }
  });

  it("initializes an in-memory database and applies migrations", () => {
    const db = initDb(":memory:");
    expect(db.select().from(hosts).all()).toEqual([]);
    db.$client.close();
  });

  it("warns when startup finds future-dated applied migrations", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1779139400001 + 10_000);

    const dataDir = mkdtempSync(join(tmpdir(), "bb-server-db-startup-"));
    try {
      const dbPath = join(dataDir, "bb.db");
      const futureCreatedAt = Date.now() + 60_000;
      const seedDb = initDb(dbPath);
      seedDb.$client
        .prepare<[string, number]>(
          `
            INSERT INTO __drizzle_migrations (hash, created_at)
            VALUES (?, ?)
          `,
        )
        .run("future-migration-hash", futureCreatedAt);
      seedDb.$client.close();

      const logger = {
        debug: vi.fn(),
        warn: vi.fn(),
      };
      const db = initDb(dbPath, { logger });
      try {
        expect(logger.warn).toHaveBeenCalledWith(
          {
            migrations: [
              {
                createdAt: futureCreatedAt,
                hash: "future-migration-hash",
              },
            ],
            now: expect.any(Number),
          },
          "Applied database migrations have future timestamps",
        );
      } finally {
        db.$client.close();
      }
    } finally {
      rmSync(dataDir, { force: true, recursive: true });
      vi.useRealTimers();
    }
  });
});
