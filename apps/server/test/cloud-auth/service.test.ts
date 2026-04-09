import {
  buildCloudAuthCredentialUpsert,
  createCloudAuthCrypto,
  type CodexStoredCredential,
} from "@bb/agent-provider-auth";
import {
  getSandboxProviderCredentialByProviderId,
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
});
