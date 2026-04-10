import {
  buildCloudAuthCredentialUpsert,
  createCloudAuthCrypto,
  type ClaudeStoredCredential,
  type CodexStoredCredential,
} from "@bb/agent-provider-auth";
import {
  getSandboxProviderCredentialByProviderId,
  deleteSandboxProviderCredentialByProviderId,
  upsertSandboxProviderCredential,
} from "@bb/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestAppHarness } from "../helpers/test-app.js";

function createCodexAccessToken(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
    "base64url",
  );
  const body = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": {
        chatgpt_account_id: accountId,
      },
    }),
  ).toString("base64url");
  return `${header}.${body}.signature`;
}

function createCodexIdToken(email: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
    "base64url",
  );
  const body = Buffer.from(
    JSON.stringify({
      email,
    }),
  ).toString("base64url");
  return `${header}.${body}.signature`;
}

async function seedCodexCredential(args: {
  accessToken: string;
  accountId: string;
  expiresAt: number;
  harness: Awaited<ReturnType<typeof createTestAppHarness>>;
  idToken: string | null;
  lastErrorMessage: string | null;
  lastRefreshedAt: number | null;
  refreshToken: string;
}): Promise<void> {
  const crypto = await createCloudAuthCrypto({
    dataDir: args.harness.config.dataDir,
  });
  const credential: CodexStoredCredential = {
    accessToken: args.accessToken,
    accountId: args.accountId,
    expiresAt: args.expiresAt,
    idToken: args.idToken,
    providerId: "codex",
    refreshToken: args.refreshToken,
  };
  upsertSandboxProviderCredential(
    args.harness.db,
    buildCloudAuthCredentialUpsert({
      credential,
      crypto,
      label: args.accountId,
      lastErrorMessage: args.lastErrorMessage,
      lastRefreshedAt: args.lastRefreshedAt,
      updatedAt: Date.now(),
    }),
  );
}

async function seedClaudeCredential(args: {
  accessToken: string;
  accountEmail: string | null;
  accountId: string | null;
  expiresAt: number;
  harness: Awaited<ReturnType<typeof createTestAppHarness>>;
  lastErrorMessage: string | null;
  lastRefreshedAt: number | null;
  refreshToken: string;
  scopes: string[];
  subscriptionType: ClaudeStoredCredential["subscriptionType"];
}): Promise<void> {
  const crypto = await createCloudAuthCrypto({
    dataDir: args.harness.config.dataDir,
  });
  const credential: ClaudeStoredCredential = {
    accessToken: args.accessToken,
    accountEmail: args.accountEmail,
    accountId: args.accountId,
    expiresAt: args.expiresAt,
    providerId: "claude-code",
    refreshToken: args.refreshToken,
    scopes: args.scopes,
    subscriptionType: args.subscriptionType,
  };
  upsertSandboxProviderCredential(
    args.harness.db,
    buildCloudAuthCredentialUpsert({
      credential,
      crypto,
      label: args.accountEmail,
      lastErrorMessage: args.lastErrorMessage,
      lastRefreshedAt: args.lastRefreshedAt,
      updatedAt: Date.now(),
    }),
  );
}

describe("cloud auth service refresh behavior", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not refresh credentials that are still outside the skew window", async () => {
    const harness = await createTestAppHarness();

    try {
      await seedCodexCredential({
        accessToken: createCodexAccessToken("acct_no_refresh"),
        accountId: "acct_no_refresh",
        expiresAt: Date.now() + 15 * 60_000,
        harness,
        idToken: createCodexIdToken("no-refresh@example.test"),
        lastErrorMessage: null,
        lastRefreshedAt: Date.now(),
        refreshToken: "refresh-token-no-refresh",
      });

      vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => {
        throw new Error("fetch should not be called for non-expired credentials");
      }));

      const resolved = await harness.deps.cloudAuth.getValidCredential({
        providerId: "codex",
      });

      expect(resolved?.credential.accountId).toBe("acct_no_refresh");
    } finally {
      await harness.cleanup();
    }
  });

  it("dedupes concurrent refreshes and persists the refreshed credential", async () => {
    const harness = await createTestAppHarness();

    try {
      await seedCodexCredential({
        accessToken: createCodexAccessToken("acct_refresh_before"),
        accountId: "acct_refresh_before",
        expiresAt: Date.now() - 1_000,
        harness,
        idToken: null,
        lastErrorMessage: "stale error",
        lastRefreshedAt: Date.now() - 60_000,
        refreshToken: "refresh-token-concurrent",
      });

      const refreshFetch = vi.fn<typeof fetch>(async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url !== "https://auth.openai.com/oauth/token") {
          throw new Error(`Unexpected fetch URL: ${url}`);
        }
        return new Response(
          JSON.stringify({
            access_token: createCodexAccessToken("acct_refresh_after"),
            expires_in: 3600,
            id_token: createCodexIdToken("refreshed@example.test"),
            refresh_token: "refresh-token-updated",
          }),
          {
            headers: {
              "content-type": "application/json",
            },
            status: 200,
          },
        );
      });
      vi.stubGlobal("fetch", refreshFetch);

      const [first, second] = await Promise.all([
        harness.deps.cloudAuth.getValidCredential({ providerId: "codex" }),
        harness.deps.cloudAuth.getValidCredential({ providerId: "codex" }),
      ]);

      expect(refreshFetch).toHaveBeenCalledTimes(1);
      expect(first?.credential.accountId).toBe("acct_refresh_after");
      expect(second?.credential.accountId).toBe("acct_refresh_after");

      const record = getSandboxProviderCredentialByProviderId(harness.db, "codex");
      expect(record?.lastErrorMessage).toBeNull();
      expect(record?.lastRefreshedAt).toEqual(expect.any(Number));
    } finally {
      await harness.cleanup();
    }
  });

  it("stores sanitized refresh failures and keeps the existing credential usable", async () => {
    const harness = await createTestAppHarness();

    try {
      await seedCodexCredential({
        accessToken: createCodexAccessToken("acct_refresh_failure"),
        accountId: "acct_refresh_failure",
        expiresAt: Date.now() - 1_000,
        harness,
        idToken: createCodexIdToken("failure@example.test"),
        lastErrorMessage: null,
        lastRefreshedAt: Date.now() - 60_000,
        refreshToken: "refresh-token-failure",
      });

      vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url !== "https://auth.openai.com/oauth/token") {
          throw new Error(`Unexpected fetch URL: ${url}`);
        }
        return new Response(
          JSON.stringify({
            error: {
              code: "refresh_token_reused",
              message: "This should not leak to clients",
              type: "invalid_request_error",
            },
          }),
          {
            headers: {
              "content-type": "application/json",
            },
            status: 401,
          },
        );
      }));

      const resolved = await harness.deps.cloudAuth.getValidCredential({
        providerId: "codex",
      });

      expect(resolved?.credential.accountId).toBe("acct_refresh_failure");

      const record = getSandboxProviderCredentialByProviderId(harness.db, "codex");
      expect(record?.lastErrorMessage).toBe(
        "Codex OAuth refresh failed with 401 (refresh_token_reused)",
      );

      const connections = await harness.deps.cloudAuth.listConnections();
      expect(connections).toContainEqual(
        expect.objectContaining({
          errorMessage: "Codex OAuth refresh failed with 401 (refresh_token_reused)",
          providerId: "codex",
          status: "invalid",
        }),
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("sanitizes decrypt failures without leaking plaintext into connection errors", async () => {
    const harness = await createTestAppHarness();

    try {
      const crypto = await createCloudAuthCrypto({
        dataDir: harness.config.dataDir,
      });
      const leakedValue = "codex-refresh-token-should-not-leak";
      upsertSandboxProviderCredential(harness.db, {
        encryptedAccessToken: crypto.encryptJson({
          plaintext: JSON.stringify(createCodexAccessToken("acct_decrypt_failure")),
        }),
        encryptedRefreshToken: crypto.encryptJson({
          plaintext: JSON.stringify(leakedValue),
        }),
        encryptedIdToken: null,
        encryptedMetadata: crypto.encryptJson({
          plaintext: JSON.stringify({
            accountId: 123,
            leakedValue,
          }),
        }),
        expiresAt: Date.now() + 15 * 60_000,
        label: "codex@example.test",
        lastErrorMessage: null,
        lastRefreshedAt: null,
        providerId: "codex",
        updatedAt: Date.now(),
      });

      await expect(
        harness.deps.cloudAuth.getValidCredential({
          providerId: "codex",
        }),
      ).resolves.toBeNull();

      const record = getSandboxProviderCredentialByProviderId(harness.db, "codex");
      expect(record?.lastErrorMessage).toBe("Failed to decrypt stored credential");
      expect(record?.lastErrorMessage).not.toContain(leakedValue);

      const connections = await harness.deps.cloudAuth.listConnections();
      expect(connections).toContainEqual(
        expect.objectContaining({
          errorMessage: "Failed to decrypt stored credential",
          providerId: "codex",
          status: "invalid",
        }),
      );
      expect(JSON.stringify(connections)).not.toContain(leakedValue);
    } finally {
      await harness.cleanup();
    }
  });

  it("does not rewrite already-quarantined decrypt failures on subsequent reads", async () => {
    const harness = await createTestAppHarness();

    try {
      const crypto = await createCloudAuthCrypto({
        dataDir: harness.config.dataDir,
      });
      upsertSandboxProviderCredential(harness.db, {
        encryptedAccessToken: crypto.encryptJson({
          plaintext: JSON.stringify(createCodexAccessToken("acct_decrypt_repeat")),
        }),
        encryptedRefreshToken: crypto.encryptJson({
          plaintext: JSON.stringify("refresh-token-repeat"),
        }),
        encryptedIdToken: null,
        encryptedMetadata: crypto.encryptJson({
          plaintext: JSON.stringify({
            accountId: 123,
          }),
        }),
        expiresAt: Date.now() + 15 * 60_000,
        label: "codex@example.test",
        lastErrorMessage: null,
        lastRefreshedAt: null,
        providerId: "codex",
        updatedAt: Date.now(),
      });

      await expect(
        harness.deps.cloudAuth.getValidCredential({
          providerId: "codex",
        }),
      ).resolves.toBeNull();
      const firstRecord = getSandboxProviderCredentialByProviderId(harness.db, "codex");
      const firstUpdatedAt = firstRecord?.updatedAt ?? null;

      await expect(
        harness.deps.cloudAuth.getValidCredential({
          providerId: "codex",
        }),
      ).resolves.toBeNull();
      const secondRecord = getSandboxProviderCredentialByProviderId(harness.db, "codex");

      expect(secondRecord?.lastErrorMessage).toBe("Failed to decrypt stored credential");
      expect(secondRecord?.updatedAt).toBe(firstUpdatedAt);
    } finally {
      await harness.cleanup();
    }
  });

  it("stores sanitized Claude refresh failures and keeps the existing credential usable", async () => {
    const harness = await createTestAppHarness();

    try {
      await seedClaudeCredential({
        accessToken: "claude-access-before",
        accountEmail: "claude@example.test",
        accountId: "acct_claude_failure",
        expiresAt: Date.now() - 1_000,
        harness,
        lastErrorMessage: null,
        lastRefreshedAt: Date.now() - 60_000,
        refreshToken: "claude-refresh-failure",
        scopes: ["user:profile"],
        subscriptionType: "max",
      });

      vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url !== "https://platform.claude.com/v1/oauth/token") {
          throw new Error(`Unexpected fetch URL: ${url}`);
        }
        return new Response(
          JSON.stringify({
            error: "invalid_grant",
          }),
          {
            headers: {
              "content-type": "application/json",
            },
            status: 401,
          },
        );
      }));

      const resolved = await harness.deps.cloudAuth.getValidCredential({
        providerId: "claude-code",
      });

      expect(resolved?.credential.accountId).toBe("acct_claude_failure");

      const record = getSandboxProviderCredentialByProviderId(
        harness.db,
        "claude-code",
      );
      expect(record?.lastErrorMessage).toBe(
        "Claude OAuth refresh failed with 401 (invalid_grant)",
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("returns null when a credential is deleted during refresh", async () => {
    const harness = await createTestAppHarness();

    try {
      await seedCodexCredential({
        accessToken: createCodexAccessToken("acct_refresh_delete"),
        accountId: "acct_refresh_delete",
        expiresAt: Date.now() - 1_000,
        harness,
        idToken: createCodexIdToken("deleted@example.test"),
        lastErrorMessage: null,
        lastRefreshedAt: Date.now() - 60_000,
        refreshToken: "refresh-token-delete",
      });

      vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url !== "https://auth.openai.com/oauth/token") {
          throw new Error(`Unexpected fetch URL: ${url}`);
        }
        deleteSandboxProviderCredentialByProviderId(harness.db, "codex");
        return new Response(
          JSON.stringify({
            access_token: createCodexAccessToken("acct_refresh_after_delete"),
            expires_in: 3600,
            id_token: createCodexIdToken("after-delete@example.test"),
            refresh_token: "refresh-token-after-delete",
          }),
          {
            headers: {
              "content-type": "application/json",
            },
            status: 200,
          },
        );
      }));

      await expect(
        harness.deps.cloudAuth.getValidCredential({
          providerId: "codex",
        }),
      ).resolves.toBeNull();
      expect(getSandboxProviderCredentialByProviderId(harness.db, "codex")).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });
});
