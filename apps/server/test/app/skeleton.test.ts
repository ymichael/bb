import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getPersonalProject,
  getProjectExecutionDefaults,
  hosts,
  type DbConnection,
} from "@bb/db";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import { initDb } from "../../src/db.js";
import { createApp } from "../../src/server.js";
import { readJson } from "../helpers/json.js";
import {
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { createTestAppHarness, withTestHarness } from "../helpers/test-app.js";

type InsertMigrationParameters = [string, number];

interface LatestMigrationCreatedAtRow {
  createdAt: number | null;
}

function readLatestAppliedMigrationCreatedAt(db: DbConnection): number {
  const row = db.$client
    .prepare<[], LatestMigrationCreatedAtRow>(
      `
        SELECT MAX(created_at) AS createdAt
        FROM __drizzle_migrations
      `,
    )
    .get();
  const createdAt = row?.createdAt;
  if (typeof createdAt !== "number") {
    throw new Error("Expected at least one applied migration timestamp");
  }
  return createdAt;
}

describe("server skeleton", () => {
  it("serves the machine install script bytes without auth", async () => {
    await withTestHarness(async (harness) => {
      const expected = readFileSync(
        new URL("../../src/assets/install-machine.sh", import.meta.url),
      );
      const response = await harness.app.request("/install.sh");

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "text/x-shellscript; charset=utf-8",
      );
      expect(Buffer.from(await response.arrayBuffer())).toEqual(expected);
    });
  });

  it("serves install version metadata without auth", async () => {
    const harness = await createTestAppHarness();
    const { app } = createApp(harness.deps, {
      bbAppArtifactService: {
        getArtifact: async () => ({
          digest: "a".repeat(64),
          path: "/unused",
          size: 0,
        }),
        getVersion: async () => "3.2.1-test",
      },
    });
    try {
      const response = await app.request("/install/version");
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        version: "3.2.1-test",
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("serves the cached server bb-app tarball without auth", async () => {
    const harness = await createTestAppHarness();
    const tarballPath = join(harness.config.dataDir, "fixture.tgz");
    writeFileSync(tarballPath, "tarball-bytes");
    const digest = "b".repeat(64);
    const getArtifact = vi.fn(async () => ({
      digest,
      path: tarballPath,
      size: 13,
    }));
    const { app } = createApp(harness.deps, {
      bbAppArtifactService: { getArtifact, getVersion: async () => "test" },
    });
    try {
      const response = await app.request("/install/bb-app.tgz");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/gzip");
      expect(response.headers.get("etag")).toBe(`"sha256-${digest}"`);
      expect(response.headers.get("x-bb-artifact-sha256")).toBe(digest);
      expect(await response.text()).toBe("tarball-bytes");
      const unchanged = await app.request("/install/bb-app.tgz", {
        headers: { "if-none-match": `"sha256-${digest}"` },
      });
      expect(unchanged.status).toBe(304);
      expect(await unchanged.text()).toBe("");
      expect(getArtifact).toHaveBeenCalledTimes(2);
    } finally {
      await harness.cleanup();
    }
  });

  it("echoes the launcher's launch id on /health only when one was given", async () => {
    await withTestHarness({ launchId: "launch-123" }, async (harness) => {
      const response = await harness.app.request("/health");
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        ok: true,
        launchId: "launch-123",
      });
    });
    await withTestHarness(async (harness) => {
      await expect(
        readJson(await harness.app.request("/health")),
      ).resolves.toEqual({ ok: true });
    });
  });

  it("serves public routes without auth", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request("/api/v1/hosts");
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual([]);
    });
  });

  it("rejects internal routes without a bearer token", async () => {
    await withTestHarness(async (harness) => {
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
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-data",
          localApiPort: null,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        }),
      });

      expect(response.status).toBe(401);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "unauthorized",
      });
    });
  });

  it("returns structured invalid_request errors for malformed JSON", async () => {
    await withTestHarness(async (harness) => {
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
    });
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

  it("ensures the personal project without pinning execution defaults", () => {
    const db = initDb(":memory:");
    try {
      expect(getPersonalProject(db)).toMatchObject({
        id: PERSONAL_PROJECT_ID,
        kind: "personal",
        name: "Personal",
      });

      expect(
        getProjectExecutionDefaults(db, {
          projectId: PERSONAL_PROJECT_ID,
        }),
      ).toBeNull();
    } finally {
      db.$client.close();
    }
  });

  it("warns when startup finds future-dated applied migrations", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-server-db-startup-"));
    try {
      const dbPath = join(dataDir, "bb.db");
      const seedDb = initDb(dbPath);
      let futureCreatedAt: number;
      try {
        const latestMigrationCreatedAt =
          readLatestAppliedMigrationCreatedAt(seedDb);
        vi.useFakeTimers();
        vi.setSystemTime(latestMigrationCreatedAt + 10_000);
        futureCreatedAt = Date.now() + 60_000;
        seedDb.$client
          .prepare<InsertMigrationParameters>(
            `
              INSERT INTO __drizzle_migrations (hash, created_at)
              VALUES (?, ?)
            `,
          )
          .run("future-migration-hash", futureCreatedAt);
      } finally {
        seedDb.$client.close();
      }

      const logger = {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
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
