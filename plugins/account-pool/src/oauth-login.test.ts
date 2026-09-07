import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { Account } from "./contracts.js";
import {
  ClaudeOAuthLogin,
  parseManualCode,
  type ClaudeOAuthAccount,
} from "./oauth-login.js";

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function startServer(handler: Handler): Promise<string> {
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("OAuth test server did not bind.");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function requestBody(request: IncomingMessage): Promise<object> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Expected an object request body.");
  }
  return parsed;
}

function savedAccount(authenticated: ClaudeOAuthAccount): Account {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    provider: "claude",
    kind: "oauth",
    label: authenticated.label,
    email: authenticated.email,
    accountUuid: authenticated.accountUuid,
    subscriptionType: authenticated.subscriptionType,
    rateLimitTier: authenticated.rateLimitTier,
    enabled: true,
    priority: 100,
    createdAt: 1,
    lastUsedAt: null,
    lastUsedHostId: null,
  };
}

describe("Claude OAuth login", () => {
  it("accepts callback URLs, code#state, and bare codes and fills the account from the profile", async () => {
    const exchanges: object[] = [];
    const profileHeaders: Array<string | undefined> = [];
    const serverUrl = await startServer(async (request, response) => {
      if (request.url?.startsWith("/authorize")) {
        response.end("authorize");
        return;
      }
      if (request.url === "/token") {
        exchanges.push(await requestBody(request));
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            access_token: "access-token",
            refresh_token: "refresh-token",
            expires_in: 3600,
          }),
        );
        return;
      }
      if (request.url === "/profile") {
        const beta = request.headers["anthropic-beta"];
        profileHeaders.push(Array.isArray(beta) ? beta[0] : beta);
        expect(request.headers.authorization).toBe("Bearer access-token");
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            account: {
              uuid: "11111111-2222-4333-8444-555555555555",
              email: "person@example.com",
              display_name: "Personal Claude",
              has_claude_max: true,
              rate_limit_tier: "default_claude_max_5x",
            },
            organization: { name: "Personal" },
          }),
        );
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    const saved: ClaudeOAuthAccount[] = [];
    const login = new ClaudeOAuthLogin({
      authorizeUrl: `${serverUrl}/authorize`,
      tokenUrl: `${serverUrl}/token`,
      profileUrl: `${serverUrl}/profile`,
      now: () => 10_000,
      addAccount: async (authenticated) => {
        saved.push(authenticated);
        return savedAccount(authenticated);
      },
    });

    const shapes: Array<"url" | "hash" | "bare"> = ["url", "hash", "bare"];
    for (const shape of shapes) {
      const started = login.start();
      const authorize = new URL(started.authorizeUrl);
      expect(await (await fetch(started.authorizeUrl)).text()).toBe(
        "authorize",
      );
      expect(authorize.searchParams.get("client_id")).toBe(
        "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      );
      expect(authorize.searchParams.get("response_type")).toBe("code");
      expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorize.searchParams.get("redirect_uri")).toBe(
        "https://console.anthropic.com/oauth/code/callback",
      );
      const state = authorize.searchParams.get("state");
      if (state === null) throw new Error("Missing OAuth state.");
      const pasted =
        shape === "url"
          ? `https://console.anthropic.com/oauth/code/callback?code=code-url&state=${state}`
          : shape === "hash"
            ? `code-hash#${state}`
            : "code-bare";
      await expect(
        login.complete({ sessionId: started.sessionId, pasted }),
      ).resolves.toMatchObject({
        label: "Personal Claude",
        email: "person@example.com",
        accountUuid: "11111111-2222-4333-8444-555555555555",
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_5x",
      });
    }

    expect(saved).toHaveLength(3);
    expect(saved[0]).toMatchObject({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: 3_610_000,
    });
    expect(exchanges.map((exchange) => Reflect.get(exchange, "code"))).toEqual([
      "code-url",
      "code-hash",
      "code-bare",
    ]);
    expect(exchanges.every((exchange) => Reflect.get(exchange, "state"))).toBe(
      true,
    );
    expect(profileHeaders).toEqual([
      "oauth-2025-04-20",
      "oauth-2025-04-20",
      "oauth-2025-04-20",
    ]);
  });

  it("rejects a mismatched state before token exchange", async () => {
    let tokenRequests = 0;
    const serverUrl = await startServer((_request, response) => {
      tokenRequests += 1;
      response.end();
    });
    const login = new ClaudeOAuthLogin({
      tokenUrl: serverUrl,
      addAccount: async (authenticated) => savedAccount(authenticated),
    });
    const started = login.start();
    await expect(
      login.complete({
        sessionId: started.sessionId,
        pasted: "authorization-code#wrong-state",
      }),
    ).rejects.toThrow("OAuth state mismatch. Start again.");
    expect(tokenRequests).toBe(0);
  });

  it("expires an in-memory login session after ten minutes", async () => {
    let now = 1_000;
    const login = new ClaudeOAuthLogin({
      now: () => now,
      addAccount: async (authenticated) => savedAccount(authenticated),
    });
    const started = login.start();
    now += 10 * 60 * 1_000;
    await expect(
      login.complete({ sessionId: started.sessionId, pasted: "code" }),
    ).rejects.toThrow("Code expired, start again.");
  });

  it("returns a user-readable exchange failure and consumes the session", async () => {
    const serverUrl = await startServer((_request, response) => {
      response.statusCode = 400;
      response.end("rejected secret detail");
    });
    const login = new ClaudeOAuthLogin({
      tokenUrl: serverUrl,
      addAccount: async (authenticated) => savedAccount(authenticated),
    });
    const started = login.start();
    await expect(
      login.complete({ sessionId: started.sessionId, pasted: "bad-code" }),
    ).rejects.toThrow("Claude token exchange failed (HTTP 400). Start again.");
    await expect(
      login.complete({ sessionId: started.sessionId, pasted: "bad-code" }),
    ).rejects.toThrow("Login session was not found. Start again.");
  });

  it("does not expose malformed token response contents", async () => {
    const serverUrl = await startServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ access_token: "sensitive-token" }));
    });
    const login = new ClaudeOAuthLogin({
      tokenUrl: serverUrl,
      addAccount: async (authenticated) => savedAccount(authenticated),
    });
    const started = login.start();
    const completion = login.complete({
      sessionId: started.sessionId,
      pasted: "authorization-code",
    });

    await expect(completion).rejects.toThrow(
      "Claude token exchange returned an invalid response. Start again.",
    );
    await expect(completion).rejects.not.toThrow("sensitive-token");
  });
});

describe("parseManualCode", () => {
  it("rejects empty input", () => {
    expect(() => parseManualCode(" ", "state")).toThrow(
      "Paste the authorization code.",
    );
  });
});
