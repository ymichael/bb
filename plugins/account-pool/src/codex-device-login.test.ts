import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountSummary } from "./contracts.js";
import {
  CodexDeviceLogin,
  type CodexDeviceAccount,
} from "./codex-device-login.js";

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>;

const servers: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  while (servers.length > 0) await servers.pop()?.();
});

async function startAuth(handler: Handler): Promise<string> {
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => {
      response.statusCode = 500;
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fake auth server did not bind.");
  }
  servers.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return `http://127.0.0.1:${address.port}`;
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function jwt(payload: object): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

function summary(account: CodexDeviceAccount): AccountSummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    provider: "codex",
    kind: "oauth",
    label: account.label,
    email: account.email,
    accountUuid: null,
    codexAccountId: account.accountId,
    subscriptionType: null,
    rateLimitTier: null,
    enabled: true,
    priority: 100,
    createdAt: 1,
    lastUsedAt: null,
    lastUsedHostId: null,
    lastUsedHostName: null,
    fiveHourUtilization: null,
    fiveHourResetAt: null,
    fiveHourStatus: null,
    sevenDayUtilization: null,
    sevenDayResetAt: null,
    sevenDayStatus: null,
    representativeClaim: null,
    familyWeekly: {
      fable: null,
      sonnet: null,
      opus: null,
      haiku: null,
      other: null,
    },
    limitWindows: [],
    observedAt: null,
    heldUntil: null,
    error: null,
    inFlight: 0,
    status: "ready",
  };
}

function createPollingHarness(args?: {
  tokenResponses?: Response[];
  expiresIn?: number;
}) {
  const clock = { now: Date.parse("2026-09-04T12:00:00Z") };
  let tokenPolls = 0;
  const tokenResponses = args?.tokenResponses ?? [];
  const login = new CodexDeviceLogin({
    now: () => clock.now,
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/api/accounts/deviceauth/usercode")) {
        return Response.json({
          device_auth_id: "device-secret",
          user_code: "USER-SECRET",
          interval: 5,
          expires_in: args?.expiresIn ?? 600,
        });
      }
      if (url.endsWith("/api/accounts/deviceauth/token")) {
        const response = tokenResponses[tokenPolls];
        tokenPolls += 1;
        return response ?? new Response(null, { status: 404 });
      }
      throw new Error(`Unexpected request to ${url}`);
    },
    addAccount: async (account) => summary(account),
  });
  return { clock, login, tokenPolls: () => tokenPolls };
}

describe("Codex device login", () => {
  it("polls pending then exchanges and stores the ID-token account claims", async () => {
    let now = Date.parse("2026-09-04T12:00:00Z");
    let polls = 0;
    const requests: Array<{ url: string; body: string }> = [];
    const accessToken = jwt({ exp: 2_000_000_000 });
    const idToken = jwt({
      email: "codex@example.com",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "chatgpt-account-1",
      },
    });
    const authBaseUrl = await startAuth(async (request, response) => {
      const requestBody = await body(request);
      requests.push({ url: request.url ?? "", body: requestBody });
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/accounts/deviceauth/usercode") {
        response.end(
          JSON.stringify({
            device_auth_id: "device-secret",
            user_code: "USER-SECRET",
            interval: "5",
            expires_at: "2026-09-04T12:10:00Z",
          }),
        );
        return;
      }
      if (request.url === "/api/accounts/deviceauth/token") {
        polls += 1;
        if (polls === 1) {
          response.statusCode = 403;
          response.end(
            JSON.stringify({
              error: { code: "deviceauth_authorization_pending" },
            }),
          );
          return;
        }
        response.end(
          JSON.stringify({
            authorization_code: "authorization-secret",
            code_challenge: "challenge-secret",
            code_verifier: "verifier-secret",
          }),
        );
        return;
      }
      if (request.url === "/oauth/token") {
        response.end(
          JSON.stringify({
            access_token: accessToken,
            refresh_token: "refresh-secret",
            id_token: idToken,
          }),
        );
        return;
      }
      response.statusCode = 404;
      response.end("{}");
    });
    const added: CodexDeviceAccount[] = [];
    const login = new CodexDeviceLogin({
      authBaseUrl,
      now: () => now,
      addAccount: async (account) => {
        added.push(account);
        return summary(account);
      },
    });

    const started = await login.start();
    expect(started).toMatchObject({
      verificationUri: `${authBaseUrl}/codex/device`,
      userCode: "USER-SECRET",
      intervalMs: 5_000,
      expiresAt: Date.parse("2026-09-04T12:10:00Z"),
    });
    expect(await login.poll({ sessionId: started.sessionId })).toEqual({
      status: "pending",
    });
    expect(polls).toBe(0);
    now += 5_000;
    expect(await login.poll({ sessionId: started.sessionId })).toEqual({
      status: "pending",
    });
    expect(polls).toBe(1);
    now += 5_000;
    const completed = await login.poll({ sessionId: started.sessionId });

    expect(completed).toMatchObject({
      status: "complete",
      account: {
        codexAccountId: "chatgpt-account-1",
        email: "codex@example.com",
      },
    });
    expect(added).toEqual([
      expect.objectContaining({
        accountId: "chatgpt-account-1",
        email: "codex@example.com",
        accessToken,
        refreshToken: "refresh-secret",
        idToken,
        expiresAt: 2_000_000_000_000,
      }),
    ]);
    expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    });
    expect(JSON.parse(requests[1]?.body ?? "")).toEqual({
      device_auth_id: "device-secret",
      user_code: "USER-SECRET",
    });
    expect(new URLSearchParams(requests[3]?.body)).toEqual(
      new URLSearchParams({
        grant_type: "authorization_code",
        code: "authorization-secret",
        redirect_uri: `${authBaseUrl}/deviceauth/callback`,
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        code_verifier: "verifier-secret",
      }),
    );
  });

  it("returns pending for an immediate poll without fetching", async () => {
    const { login, tokenPolls } = createPollingHarness();
    const started = await login.start();

    expect(await login.poll({ sessionId: started.sessionId })).toEqual({
      status: "pending",
    });
    expect(tokenPolls()).toBe(0);
    expect(login.nextPollDelayMs(started.sessionId)).toBe(5_000);
  });

  it("keeps a session pending after HTTP 404", async () => {
    const { clock, login, tokenPolls } = createPollingHarness();
    const started = await login.start();
    clock.now += 5_000;

    expect(await login.poll({ sessionId: started.sessionId })).toEqual({
      status: "pending",
    });
    clock.now += 5_000;
    expect(await login.poll({ sessionId: started.sessionId })).toEqual({
      status: "pending",
    });
    expect(tokenPolls()).toBe(2);
  });

  it("extends the session interval after slow_down", async () => {
    const { clock, login, tokenPolls } = createPollingHarness({
      tokenResponses: [
        Response.json(
          { error: { code: "deviceauth_slow_down" } },
          { status: 429 },
        ),
      ],
    });
    const started = await login.start();
    clock.now += 5_000;

    expect(await login.poll({ sessionId: started.sessionId })).toEqual({
      status: "pending",
    });
    expect(login.nextPollDelayMs(started.sessionId)).toBe(10_000);
    clock.now += 5_000;
    expect(await login.poll({ sessionId: started.sessionId })).toEqual({
      status: "pending",
    });
    expect(tokenPolls()).toBe(1);
    clock.now += 5_000;
    expect(await login.poll({ sessionId: started.sessionId })).toEqual({
      status: "pending",
    });
    expect(tokenPolls()).toBe(2);
  });

  it("extends the session interval for slow_down on HTTP 200", async () => {
    const { clock, login, tokenPolls } = createPollingHarness({
      tokenResponses: [
        Response.json({ error: { code: "deviceauth_slow_down" } }),
      ],
    });
    const started = await login.start();
    clock.now += 5_000;

    expect(await login.poll({ sessionId: started.sessionId })).toEqual({
      status: "pending",
    });
    expect(login.nextPollDelayMs(started.sessionId)).toBe(10_000);
    expect(tokenPolls()).toBe(1);
  });

  it("keeps a session pending after a pre-expiry HTTP 500", async () => {
    const { clock, login, tokenPolls } = createPollingHarness({
      tokenResponses: [new Response(null, { status: 500 })],
    });
    const started = await login.start();
    clock.now += 5_000;

    expect(await login.poll({ sessionId: started.sessionId })).toEqual({
      status: "pending",
    });
    clock.now += 5_000;
    expect(await login.poll({ sessionId: started.sessionId })).toEqual({
      status: "pending",
    });
    expect(tokenPolls()).toBe(2);
  });

  it("removes a cancelled session", async () => {
    const { login } = createPollingHarness();
    const started = await login.start();

    expect(login.cancel({ sessionId: started.sessionId })).toBe(true);
    expect(await login.poll({ sessionId: started.sessionId })).toEqual({
      status: "error",
      message: "Login session was not found. Start again.",
    });
  });

  it("removes an expired session with its timer", async () => {
    vi.useFakeTimers();
    const { login } = createPollingHarness({ expiresIn: 1 });
    const started = await login.start();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(await login.poll({ sessionId: started.sessionId })).toEqual({
      status: "error",
      message: "Login session was not found. Start again.",
    });
  });

  it("clears session timers and state on dispose", async () => {
    vi.useFakeTimers();
    const { login } = createPollingHarness();
    const started = await login.start();
    expect(vi.getTimerCount()).toBe(1);

    login.dispose();

    expect(vi.getTimerCount()).toBe(0);
    expect(await login.poll({ sessionId: started.sessionId })).toEqual({
      status: "error",
      message: "Login session was not found. Start again.",
    });
  });

  it("expires the session after ten minutes without polling auth", async () => {
    let now = Date.parse("2026-09-04T12:00:00Z");
    let tokenPolls = 0;
    const authBaseUrl = await startAuth((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/accounts/deviceauth/usercode") {
        response.end(
          JSON.stringify({
            device_auth_id: "device-secret",
            user_code: "USER-SECRET",
            interval: "5",
            expires_at: "2026-09-04T12:15:00Z",
          }),
        );
        return;
      }
      tokenPolls += 1;
      response.end("{}");
    });
    const login = new CodexDeviceLogin({
      authBaseUrl,
      now: () => now,
      addAccount: async (account) => summary(account),
    });
    const started = await login.start();
    now += 10 * 60 * 1_000;
    expect(await login.poll({ sessionId: started.sessionId })).toEqual({
      status: "error",
      message: "Code expired, start again.",
    });
    expect(tokenPolls).toBe(0);
  });

  it("redacts exchange failures and never writes codes or tokens to logs", async () => {
    let now = Date.parse("2026-09-04T12:00:00Z");
    const logged: string[] = [];
    const methods: Array<"log" | "warn" | "error"> = ["log", "warn", "error"];
    for (const method of methods) {
      vi.spyOn(console, method).mockImplementation((...values) => {
        logged.push(values.map(String).join(" "));
      });
    }
    const authBaseUrl = await startAuth((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/accounts/deviceauth/usercode") {
        response.end(
          JSON.stringify({
            device_auth_id: "device-secret",
            user_code: "USER-SECRET",
            interval: "5",
            expires_in: 600,
          }),
        );
        return;
      }
      if (request.url === "/api/accounts/deviceauth/token") {
        response.end(
          JSON.stringify({
            authorization_code: "authorization-secret",
            code_challenge: "challenge-secret",
            code_verifier: "verifier-secret",
          }),
        );
        return;
      }
      response.statusCode = 400;
      response.end("refresh-secret rejected");
    });
    const login = new CodexDeviceLogin({
      authBaseUrl,
      now: () => now,
      addAccount: async (account) => summary(account),
    });
    const started = await login.start();
    now += 5_000;
    const result = await login.poll({ sessionId: started.sessionId });
    expect(result).toEqual({
      status: "error",
      message: "Codex token exchange failed (HTTP 400). Start again.",
    });
    expect(JSON.stringify(result)).not.toMatch(
      /USER-SECRET|device-secret|authorization-secret|verifier-secret|refresh-secret/u,
    );
    expect(logged).toEqual([]);
  });
});
