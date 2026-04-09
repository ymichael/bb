import {
  buildCloudAuthCredentialUpsert,
  createCloudAuthCrypto,
} from "@bb/agent-provider-auth";
import {
  getSandboxProviderCredentialByProviderId,
  upsertSandboxProviderCredential,
} from "@bb/db";
import {
  cloudAuthAttemptResponseSchema,
  cloudAuthConnectResponseSchema,
  cloudAuthSettingsResponseSchema,
} from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readJson } from "../helpers/json.js";
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

describe("public cloud auth routes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists missing cloud auth connections by default", async () => {
    const harness = await createTestAppHarness();

    try {
      const response = await harness.app.request("/api/v1/system/cloud-auth");

      expect(response.status).toBe(200);
      const body = cloudAuthSettingsResponseSchema.parse(await readJson(response));
      expect(body).toEqual({
        connections: [
          {
            connectedAt: null,
            displayName: "Claude Code",
            errorMessage: null,
            expiresAt: null,
            label: null,
            lastRefreshedAt: null,
            providerId: "claude-code",
            status: "missing",
          },
          {
            connectedAt: null,
            displayName: "Codex",
            errorMessage: null,
            expiresAt: null,
            label: null,
            lastRefreshedAt: null,
            providerId: "codex",
            status: "missing",
          },
        ],
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("starts and completes a codex OAuth connection", async () => {
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("http://127.0.0.1:1455/")) {
        return nativeFetch(input, init);
      }
      if (url === "https://auth.openai.com/oauth/token") {
        return new Response(
          JSON.stringify({
            access_token: createCodexAccessToken("acct_codex_test"),
            expires_in: 3600,
            id_token: createCodexIdToken("codex@example.test"),
            refresh_token: "refresh-token-1",
          }),
          {
            headers: {
              "content-type": "application/json",
            },
            status: 200,
          },
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }));

    const harness = await createTestAppHarness();

    try {
      const startResponse = await harness.app.request(
        "/api/v1/system/cloud-auth/codex/connect",
        {
          method: "POST",
        },
      );

      expect(startResponse.status).toBe(201);
      const startBody = cloudAuthConnectResponseSchema.parse(
        await readJson(startResponse),
      );
      const authUrl = new URL(startBody.authorizationUrl);
      expect(authUrl.hostname).toBe("auth.openai.com");
      expect(authUrl.searchParams.get("client_id")).toBe(
        "app_EMoamEEZ73f0CkXaXp7hrann",
      );

      await nativeFetch(
        `http://127.0.0.1:1455/auth/callback?code=test-code&state=${encodeURIComponent(authUrl.searchParams.get("state") ?? "")}`,
      );

      await vi.waitFor(async () => {
        const attemptResponse = await harness.app.request(
          `/api/v1/system/cloud-auth/attempts/${startBody.attemptId}`,
        );
        expect(attemptResponse.status).toBe(200);
        const attemptBody = cloudAuthAttemptResponseSchema.parse(
          await readJson(attemptResponse),
        );
        expect(attemptBody).toEqual({
          providerId: "codex",
          status: "completed",
          attemptId: startBody.attemptId,
          errorMessage: null,
        });
      });

      const settingsResponse = await harness.app.request("/api/v1/system/cloud-auth");
      expect(settingsResponse.status).toBe(200);
      const settingsBody = cloudAuthSettingsResponseSchema.parse(
        await readJson(settingsResponse),
      );
      expect(settingsBody.connections).toContainEqual({
        connectedAt: expect.any(Number),
        displayName: "Codex",
        errorMessage: null,
        expiresAt: expect.any(Number),
        label: "codex@example.test",
        lastRefreshedAt: expect.any(Number),
        providerId: "codex",
        status: "connected",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("sanitizes codex exchange errors before returning attempt status", async () => {
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("http://127.0.0.1:1455/")) {
        return nativeFetch(input, init);
      }
      if (url === "https://auth.openai.com/oauth/token") {
        return new Response(
          JSON.stringify({
            error: {
              message: "Provider-specific failure detail that should not leak",
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
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }));

    const harness = await createTestAppHarness();

    try {
      const startResponse = await harness.app.request(
        "/api/v1/system/cloud-auth/codex/connect",
        {
          method: "POST",
        },
      );

      expect(startResponse.status).toBe(201);
      const startBody = cloudAuthConnectResponseSchema.parse(
        await readJson(startResponse),
      );
      const authUrl = new URL(startBody.authorizationUrl);

      await nativeFetch(
        `http://127.0.0.1:1455/auth/callback?code=test-code&state=${encodeURIComponent(authUrl.searchParams.get("state") ?? "")}`,
      );

      await vi.waitFor(async () => {
        const attemptResponse = await harness.app.request(
          `/api/v1/system/cloud-auth/attempts/${startBody.attemptId}`,
        );
        expect(attemptResponse.status).toBe(200);
        const attemptBody = cloudAuthAttemptResponseSchema.parse(
          await readJson(attemptResponse),
        );
        expect(attemptBody).toEqual({
          attemptId: startBody.attemptId,
          errorMessage: "Codex OAuth token exchange failed with 401 (invalid_request_error)",
          providerId: "codex",
          status: "failed",
        });
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("starts and completes a claude OAuth connection", async () => {
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("http://127.0.0.1:53692/")) {
        return nativeFetch(input, init);
      }
      if (url === "https://platform.claude.com/v1/oauth/token") {
        return new Response(
          JSON.stringify({
            access_token: "claude-access-1",
            expires_in: 3600,
            refresh_token: "claude-refresh-1",
            scope:
              "org:create_api_key user:profile user:inference user:sessions:claude_code",
          }),
          {
            headers: {
              "content-type": "application/json",
            },
            status: 200,
          },
        );
      }
      if (url === "https://api.anthropic.com/api/oauth/profile") {
        return new Response(
          JSON.stringify({
            account: {
              email: "claude@example.test",
              uuid: "acct_claude_test",
            },
            organization: {
              name: "Claude Test Org",
              organization_type: "claude_max",
              uuid: "org_claude_test",
            },
          }),
          {
            headers: {
              "content-type": "application/json",
            },
            status: 200,
          },
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }));

    const harness = await createTestAppHarness();

    try {
      const startResponse = await harness.app.request(
        "/api/v1/system/cloud-auth/claude-code/connect",
        {
          method: "POST",
        },
      );

      expect(startResponse.status).toBe(201);
      const startBody = cloudAuthConnectResponseSchema.parse(
        await readJson(startResponse),
      );
      const authUrl = new URL(startBody.authorizationUrl);
      expect(authUrl.hostname).toBe("claude.ai");
      expect(authUrl.searchParams.get("client_id")).toBe(
        "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      );

      await nativeFetch(
        `http://127.0.0.1:53692/callback?code=test-code&state=${encodeURIComponent(authUrl.searchParams.get("state") ?? "")}`,
      );

      await vi.waitFor(async () => {
        const attemptResponse = await harness.app.request(
          `/api/v1/system/cloud-auth/attempts/${startBody.attemptId}`,
        );
        expect(attemptResponse.status).toBe(200);
        const attemptBody = cloudAuthAttemptResponseSchema.parse(
          await readJson(attemptResponse),
        );
        expect(attemptBody).toEqual({
          providerId: "claude-code",
          status: "completed",
          attemptId: startBody.attemptId,
          errorMessage: null,
        });
      });

      const settingsResponse = await harness.app.request("/api/v1/system/cloud-auth");
      expect(settingsResponse.status).toBe(200);
      const settingsBody = cloudAuthSettingsResponseSchema.parse(
        await readJson(settingsResponse),
      );
      expect(settingsBody.connections).toContainEqual({
        connectedAt: expect.any(Number),
        displayName: "Claude Code",
        errorMessage: null,
        expiresAt: expect.any(Number),
        label: "claude@example.test",
        lastRefreshedAt: expect.any(Number),
        providerId: "claude-code",
        status: "connected",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("shows invalid connections and supports disconnect", async () => {
    const harness = await createTestAppHarness();

    try {
      const crypto = await createCloudAuthCrypto({
        dataDir: harness.config.dataDir,
      });
      upsertSandboxProviderCredential(
        harness.db,
        buildCloudAuthCredentialUpsert({
          credential: {
            accessToken: createCodexAccessToken("bad-credential"),
            accountId: "bad-credential",
            expiresAt: 1_700_000_000_000,
            idToken: null,
            providerId: "codex",
            refreshToken: "refresh-token-invalid",
          },
          crypto,
          label: "bad-credential",
          lastErrorMessage: "Token refresh failed",
          lastRefreshedAt: 1_700_000_000_100,
          updatedAt: 1_700_000_000_200,
        }),
      );

      const settingsResponse = await harness.app.request("/api/v1/system/cloud-auth");
      expect(settingsResponse.status).toBe(200);
      const settingsBody = cloudAuthSettingsResponseSchema.parse(
        await readJson(settingsResponse),
      );
      expect(settingsBody.connections).toContainEqual({
        connectedAt: expect.any(Number),
        displayName: "Codex",
        errorMessage: "Token refresh failed",
        expiresAt: 1_700_000_000_000,
        label: "bad-credential",
        lastRefreshedAt: 1_700_000_000_100,
        providerId: "codex",
        status: "invalid",
      });

      const disconnectResponse = await harness.app.request(
        "/api/v1/system/cloud-auth/codex",
        {
          method: "DELETE",
        },
      );
      expect(disconnectResponse.status).toBe(200);
      await expect(readJson(disconnectResponse)).resolves.toEqual({ ok: true });
      expect(getSandboxProviderCredentialByProviderId(harness.db, "codex")).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("returns the persisted codex label without decrypting credentials", async () => {
    const harness = await createTestAppHarness();

    try {
      const crypto = await createCloudAuthCrypto({
        dataDir: harness.config.dataDir,
      });
      upsertSandboxProviderCredential(
        harness.db,
        buildCloudAuthCredentialUpsert({
          credential: {
            accessToken: createCodexAccessToken("acct_codex_old"),
            accountId: "acct_codex_old",
            expiresAt: 1_900_000_000_000,
            idToken: createCodexIdToken("saved-codex@example.test"),
            providerId: "codex",
            refreshToken: "refresh-token-existing",
          },
          crypto,
          label: "saved-codex@example.test",
          lastErrorMessage: null,
          lastRefreshedAt: 1_800_000_000_000,
          updatedAt: 1_800_000_000_000,
        }),
      );

      const settingsResponse = await harness.app.request("/api/v1/system/cloud-auth");
      expect(settingsResponse.status).toBe(200);
      const settingsBody = cloudAuthSettingsResponseSchema.parse(
        await readJson(settingsResponse),
      );
      expect(settingsBody.connections).toContainEqual({
        connectedAt: 1_800_000_000_000,
        displayName: "Codex",
        errorMessage: null,
        expiresAt: 1_900_000_000_000,
        label: "saved-codex@example.test",
        lastRefreshedAt: 1_800_000_000_000,
        providerId: "codex",
        status: "connected",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("sanitizes malformed claude profile responses", async () => {
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("http://127.0.0.1:53692/")) {
        return nativeFetch(input, init);
      }
      if (url === "https://platform.claude.com/v1/oauth/token") {
        return new Response(
          JSON.stringify({
            access_token: "claude-access-1",
            expires_in: 3600,
            refresh_token: "claude-refresh-1",
            scope: "user:profile",
          }),
          {
            headers: {
              "content-type": "application/json",
            },
            status: 200,
          },
        );
      }
      if (url === "https://api.anthropic.com/api/oauth/profile") {
        return new Response("{", {
          headers: {
            "content-type": "application/json",
          },
          status: 200,
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }));

    const harness = await createTestAppHarness();

    try {
      const startResponse = await harness.app.request(
        "/api/v1/system/cloud-auth/claude-code/connect",
        {
          method: "POST",
        },
      );

      expect(startResponse.status).toBe(201);
      const startBody = cloudAuthConnectResponseSchema.parse(
        await readJson(startResponse),
      );
      const authUrl = new URL(startBody.authorizationUrl);

      await nativeFetch(
        `http://127.0.0.1:53692/callback?code=test-code&state=${encodeURIComponent(authUrl.searchParams.get("state") ?? "")}`,
      );

      await vi.waitFor(async () => {
        const attemptResponse = await harness.app.request(
          `/api/v1/system/cloud-auth/attempts/${startBody.attemptId}`,
        );
        expect(attemptResponse.status).toBe(200);
        const attemptBody = cloudAuthAttemptResponseSchema.parse(
          await readJson(attemptResponse),
        );
        expect(attemptBody).toEqual({
          attemptId: startBody.attemptId,
          errorMessage: "Claude OAuth profile fetch returned an invalid response",
          providerId: "claude-code",
          status: "failed",
        });
      });
    } finally {
      await harness.cleanup();
    }
  });
});
