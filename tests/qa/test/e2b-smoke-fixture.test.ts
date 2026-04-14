import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadQaAuthFixture } from "../src/e2b-smoke/fixture.js";

const FIXTURE_PATH_ENV_VAR = "BB_CLOUD_AUTH_FIXTURE_PATH";
const persistedClaudeFixtureSchema = z.object({
  claude: z.object({
    access: z.string(),
    refresh: z.string(),
  }).optional(),
});
const persistedCodexFixtureSchema = z.object({
  "openai-codex": z.object({
    access: z.string(),
    idToken: z.string(),
    refresh: z.string(),
  }).optional(),
});

describe("e2b smoke auth fixture", () => {
  const originalFixturePath = process.env[FIXTURE_PATH_ENV_VAR];
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    if (originalFixturePath === undefined) {
      delete process.env[FIXTURE_PATH_ENV_VAR];
    } else {
      process.env[FIXTURE_PATH_ENV_VAR] = originalFixturePath;
    }
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("persists refreshed claude fixture updates back to disk", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-e2b-fixture-test-"));
    const fixturePath = join(tempDir, "credentials.json");
    const fixture = {
      claude: {
        access: "old-claude-access-token",
        expires: 1_777_000_000_000,
        refresh: "old-claude-refresh-token",
      },
      createdAt: "2026-04-10T00:00:00.000Z",
    };

    try {
      await writeFile(
        fixturePath,
        `${JSON.stringify(fixture, null, 2)}\n`,
        "utf8",
      );
      process.env[FIXTURE_PATH_ENV_VAR] = fixturePath;
      globalThis.fetch = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              access_token: "new-claude-access-token",
              expires_in: 3600,
              refresh_token: "new-claude-refresh-token",
              scope: "user:profile",
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              account: {
                email: "qa@example.com",
                uuid: "acct_123",
              },
              organization: {
                name: "QA Org",
                organization_type: "claude_pro",
                uuid: "org_123",
              },
            }),
            { status: 200 },
          ),
        );

      const loadedFixture = await loadQaAuthFixture();

      expect(loadedFixture.notices).toEqual([]);
      expect(loadedFixture.fixture?.claude).toMatchObject({
        access: "new-claude-access-token",
        refresh: "new-claude-refresh-token",
      });
      const persisted = persistedClaudeFixtureSchema.parse(
        JSON.parse(await readFile(fixturePath, "utf8")),
      );
      expect(persisted.claude).toMatchObject({
        access: "new-claude-access-token",
        refresh: "new-claude-refresh-token",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("persists refreshed codex fixture updates back to disk", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-e2b-fixture-test-"));
    const fixturePath = join(tempDir, "credentials.json");
    const fixture = {
      "openai-codex": {
        access: "old-codex-access-token",
        accountId: "acct_old",
        expires: 1_777_000_000_000,
        idToken: "old-codex-id-token",
        refresh: "old-codex-refresh-token",
      },
      createdAt: "2026-04-10T00:00:00.000Z",
    };

    try {
      await writeFile(
        fixturePath,
        `${JSON.stringify(fixture, null, 2)}\n`,
        "utf8",
      );
      process.env[FIXTURE_PATH_ENV_VAR] = fixturePath;
      globalThis.fetch = vi.fn<typeof fetch>().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "new-codex-access-token",
            expires_in: 7200,
            id_token: "new-codex-id-token",
            refresh_token: "new-codex-refresh-token",
          }),
          { status: 200 },
        ),
      );

      const loadedFixture = await loadQaAuthFixture();

      expect(loadedFixture.notices).toEqual([]);
      expect(loadedFixture.fixture?.["openai-codex"]).toMatchObject({
        access: "new-codex-access-token",
        idToken: "new-codex-id-token",
        refresh: "new-codex-refresh-token",
      });
      const persisted = persistedCodexFixtureSchema.parse(
        JSON.parse(await readFile(fixturePath, "utf8")),
      );
      expect(persisted["openai-codex"]).toMatchObject({
        access: "new-codex-access-token",
        idToken: "new-codex-id-token",
        refresh: "new-codex-refresh-token",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails hard when codex fixture refresh fails", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-e2b-fixture-test-"));
    const fixturePath = join(tempDir, "credentials.json");
    const fixture = {
      "openai-codex": {
        access: "old-codex-access-token",
        expires: 1_777_000_000_000,
        refresh: "old-codex-refresh-token",
      },
      createdAt: "2026-04-10T00:00:00.000Z",
    };

    try {
      await writeFile(
        fixturePath,
        `${JSON.stringify(fixture, null, 2)}\n`,
        "utf8",
      );
      process.env[FIXTURE_PATH_ENV_VAR] = fixturePath;
      globalThis.fetch = vi.fn<typeof fetch>().mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: "invalid_grant" }),
          { status: 400 },
        ),
      );

      await expect(loadQaAuthFixture()).rejects.toThrow(
        "Codex fixture refresh failed; reacquire it with the auth-connect helper.",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("persists a refreshed claude fixture before failing on codex refresh", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bb-e2b-fixture-test-"));
    const fixturePath = join(tempDir, "credentials.json");
    const fixture = {
      claude: {
        access: "old-claude-access-token",
        expires: 1_777_000_000_000,
        refresh: "old-claude-refresh-token",
      },
      "openai-codex": {
        access: "old-codex-access-token",
        expires: 1_777_000_000_000,
        refresh: "old-codex-refresh-token",
      },
      createdAt: "2026-04-10T00:00:00.000Z",
    };

    try {
      await writeFile(
        fixturePath,
        `${JSON.stringify(fixture, null, 2)}\n`,
        "utf8",
      );
      process.env[FIXTURE_PATH_ENV_VAR] = fixturePath;
      globalThis.fetch = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              access_token: "new-claude-access-token",
              expires_in: 3600,
              refresh_token: "new-claude-refresh-token",
              scope: "user:profile",
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              account: {
                email: "qa@example.com",
                uuid: "acct_123",
              },
              organization: {
                name: "QA Org",
                organization_type: "claude_pro",
                uuid: "org_123",
              },
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ error: "invalid_grant" }),
            { status: 400 },
          ),
        );

      await expect(loadQaAuthFixture()).rejects.toThrow(
        "Codex fixture refresh failed; reacquire it with the auth-connect helper.",
      );

      const persisted = persistedClaudeFixtureSchema.parse(
        JSON.parse(await readFile(fixturePath, "utf8")),
      );
      expect(persisted.claude).toMatchObject({
        access: "new-claude-access-token",
        refresh: "new-claude-refresh-token",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
