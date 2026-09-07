import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFrame, encodeFrame, type Frame } from "@bb/tunnel-contract";
import { machine } from "@bb/connect-db";

import { cacheKey } from "./cache";
import { parseClientProtocolVersion } from "./tunnel-do";
import {
  cacheNamespace,
  dashboardSignInUrl,
  requestForTunnelDo,
} from "./worker";
import {
  GATE_AUTH_HEADER,
  GATE_MACHINE_ID_HEADER,
  TUNNEL_TARGET_HEADER,
} from "./protocol-headers";

describe("connect sign-in page", () => {
  it("points unauthenticated visitors at the dashboard auth flow with returnTo", () => {
    expect(
      dashboardSignInUrl(
        "https://getbb.app",
        "https://sawyer.getbb.app/thread/thr_123?view=full",
      ),
    ).toBe(
      "https://getbb.app/dashboard?returnTo=https%3A%2F%2Fsawyer.getbb.app%2Fthread%2Fthr_123%3Fview%3Dfull",
    );
  });

  it("uses the configured app origin for staging", () => {
    expect(
      dashboardSignInUrl(
        "https://vibecodethis.site",
        "https://sawyer.vibecodethis.site/",
      ),
    ).toBe(
      "https://vibecodethis.site/dashboard?returnTo=https%3A%2F%2Fsawyer.vibecodethis.site%2F",
    );
  });
});

describe("requestForTunnelDo", () => {
  it("sets the target header on share hosts and strips visitor-supplied values", () => {
    const req = new Request("https://sawyer--8000.getbb.app/", {
      headers: { [TUNNEL_TARGET_HEADER]: "smuggled", cookie: "a=b" },
    });
    const out = requestForTunnelDo(req, "8000");
    expect(out.headers.get(TUNNEL_TARGET_HEADER)).toBe("8000");
    expect(out.headers.get("cookie")).toBe("a=b");
  });

  it("strips a smuggled target header on bare-handle hosts", () => {
    const req = new Request("https://sawyer.getbb.app/", {
      headers: { [TUNNEL_TARGET_HEADER]: "9999" },
    });
    const out = requestForTunnelDo(req, null);
    expect(out.headers.get(TUNNEL_TARGET_HEADER)).toBeNull();
  });

  it("strips a forged gate auth header and stamps the authenticated kind", () => {
    const req = new Request("https://sawyer.getbb.app/", {
      headers: {
        [GATE_AUTH_HEADER]: "machine",
        [GATE_MACHINE_ID_HEADER]: "forged-machine",
      },
    });
    const out = requestForTunnelDo(req, null, "session");
    expect(out.headers.get(GATE_AUTH_HEADER)).toBe("session");
    expect(out.headers.get(GATE_MACHINE_ID_HEADER)).toBeNull();
  });
});

describe("cache namespace", () => {
  it("uses the bare handle or the full share label", () => {
    expect(cacheNamespace("sawyer", null)).toBe("sawyer");
    expect(cacheNamespace("sawyer", "8000")).toBe("sawyer--8000");
  });

  it("builds distinct edge-cache keys for bare handle vs share label", () => {
    const url = new URL("https://example/assets/app.js");
    const bare = cacheKey("sawyer", url);
    const share = cacheKey("sawyer--8000", url);
    expect(bare.url).not.toBe(share.url);
    expect(bare.url).toContain("/sawyer/assets/app.js");
    expect(share.url).toContain("/sawyer--8000/assets/app.js");
  });
});

describe("parseClientProtocolVersion", () => {
  it("treats missing or unparsable as 0", () => {
    expect(parseClientProtocolVersion(null)).toBe(0);
    expect(parseClientProtocolVersion("")).toBe(0);
    expect(parseClientProtocolVersion("nope")).toBe(0);
    expect(parseClientProtocolVersion("-1")).toBe(0);
  });

  it("parses non-negative integers", () => {
    expect(parseClientProtocolVersion("0")).toBe(0);
    expect(parseClientProtocolVersion("1")).toBe(1);
    expect(parseClientProtocolVersion("12")).toBe(12);
  });
});

vi.mock("./session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session.js")>()),
  invalidateSessionCookie: vi.fn(),
  markMachineSeen: vi.fn(),
  parseCookie: vi.fn(),
  resolveLabel: vi.fn(),
  verifyMachineCredentialDetails: vi.fn(),
  verifySessionCookieDetails: vi.fn(),
}));

vi.mock("./account-session.js", () => ({
  refreshAccountSessionCookies: vi.fn(),
}));

vi.mock("./servers.js", () => ({
  handleCreateDesktopSession: vi.fn(),
  handleDisconnectServer: vi.fn(),
  handleListAccountServers: vi.fn(),
  verifyDesktopSessionCookie: vi.fn(),
}));

vi.mock("./machine-label.js", () => ({
  handleAssignMachineLabel: vi.fn(),
}));

vi.mock("./cache.js", async () => {
  const actual =
    await vi.importActual<typeof import("./cache.js")>("./cache.js");
  return {
    ...actual,
    serveWithCache: vi.fn(
      async (
        _request: Request,
        _namespace: string,
        _ctx: ExecutionContext,
        fetchOrigin: () => Promise<Response>,
      ) => ({ cacheable: false, response: await fetchOrigin() }),
    ),
  };
});

vi.mock("drizzle-orm/d1", () => ({
  drizzle: vi.fn(() => ({})),
}));

import { drizzle } from "drizzle-orm/d1";

import {
  invalidateSessionCookie,
  markMachineSeen,
  parseCookie,
  resolveLabel,
  verifyMachineCredentialDetails,
  verifySessionCookieDetails,
} from "./session.js";
import { refreshAccountSessionCookies } from "./account-session.js";
import {
  handleCreateDesktopSession,
  handleDisconnectServer,
  handleListAccountServers,
  verifyDesktopSessionCookie,
} from "./servers.js";
import { SECURE_DESKTOP_SESSION_COOKIE as DESKTOP_SESSION_COOKIE } from "./cloud-dev.js";
import { handleAssignMachineLabel } from "./machine-label.js";
import { serveWithCache } from "./cache.js";
import worker, { offlinePage, relativeTime, wantsHtml } from "./worker.js";
import { TUNNEL_OFFLINE_HEADER, TunnelDO } from "./tunnel-do.js";

const mockParseCookie = vi.mocked(parseCookie);
const mockInvalidateSession = vi.mocked(invalidateSessionCookie);
const mockRefreshAccountSession = vi.mocked(refreshAccountSessionCookies);
const mockResolveLabel = vi.mocked(resolveLabel);
const mockMarkMachineSeen = vi.mocked(markMachineSeen);
const mockVerifyMachine = vi.mocked(verifyMachineCredentialDetails);
const mockVerifySessionDetails = vi.mocked(verifySessionCookieDetails);
const mockServeWithCache = vi.mocked(serveWithCache);
const mockHandleListAccountServers = vi.mocked(handleListAccountServers);
const mockHandleCreateDesktopSession = vi.mocked(handleCreateDesktopSession);
const mockHandleDisconnectServer = vi.mocked(handleDisconnectServer);
const mockVerifyDesktopSession = vi.mocked(verifyDesktopSessionCookie);
const mockHandleAssignMachineLabel = vi.mocked(handleAssignMachineLabel);

function sessionDetails(userId = OWNER, needsRefresh = false) {
  return { userId, needsRefresh };
}

function resolvedServer(
  over: Partial<{
    lastSeenAt: Date | null;
    userId: string;
  }> = {},
) {
  return {
    kind: "server" as const,
    userId: over.userId ?? OWNER,
    server: {
      id: "srv1",
      credentialHash: "abc",
      revokedAt: null,
      lastSeenAt: over.lastSeenAt ?? null,
    },
  };
}

function resolvedMachine(
  over: Partial<{
    credentialHash: string;
    lastSeenAt: Date | null;
    revokedAt: Date | null;
    routingKey: string;
    userId: string;
  }> = {},
) {
  return {
    kind: "machine" as const,
    routingKey: over.routingKey ?? "sawyer-air:machine-generation",
    userId: over.userId ?? OWNER,
    accountHandle: "sawyer",
    machine: {
      id: "machine-air",
      credentialHash: over.credentialHash ?? "abc",
      revokedAt: over.revokedAt ?? null,
      lastSeenAt: over.lastSeenAt ?? null,
    },
  };
}

const BASE = "getbb.app";
const OWNER = "user-owner";
const OTHER = "user-other";

function makeEnv(doFetch: (req: Request) => Promise<Response> | Response) {
  const captured: Request[] = [];
  const routingKeys: string[] = [];
  const stub = {
    fetch: (req: Request) => {
      captured.push(req);
      return Promise.resolve(doFetch(req));
    },
  };
  const env = {
    TUNNEL_DO: {
      idFromName: (name: string) => {
        routingKeys.push(name);
        return { name };
      },
      get: () => stub,
    },
    DB: {} as D1Database,
    BASE_DOMAIN: BASE,
    BETTER_AUTH_SECRET: "test-secret",
  };
  const ctx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
  return { env, ctx, captured, routingKeys };
}

function visitorRequest(
  host: string,
  path = "/",
  init: RequestInit = {},
): Request {
  const headers = new Headers(init.headers);
  headers.set("host", host);
  return new Request(`https://${host}${path}`, { ...init, headers });
}

describe("GET /api/connect/servers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHandleListAccountServers.mockResolvedValue(
      new Response(JSON.stringify({ servers: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("intercepts the path before host routing (never proxies to the tunnel)", async () => {
    const { env, ctx, captured } = makeEnv(() => new Response("origin"));
    const res = await worker.fetch(
      visitorRequest("sawyer.getbb.app", "/api/connect/servers", {
        headers: { "x-bb-connect-machine": "bbcm_ok" },
      }),
      env as never,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(mockHandleListAccountServers).toHaveBeenCalledTimes(1);
    expect(mockResolveLabel).not.toHaveBeenCalled();
    expect(captured).toHaveLength(0);
  });

  it("handles the path even on an unknown host label", async () => {
    const { env, ctx } = makeEnv(() => new Response("origin"));
    mockHandleListAccountServers.mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    );
    const res = await worker.fetch(
      new Request("https://getbb.app/api/connect/servers", {
        headers: { host: "getbb.app" },
      }),
      env as never,
      ctx,
    );
    expect(res.status).toBe(401);
    expect(mockHandleListAccountServers).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/connect/desktop-session", () => {
  it("intercepts the exchange before tunnel routing", async () => {
    mockHandleCreateDesktopSession.mockResolvedValue(
      new Response(JSON.stringify({ cookie: { value: "short-lived" } })),
    );
    const { env, ctx, captured } = makeEnv(() => new Response("origin"));
    const response = await worker.fetch(
      visitorRequest("sawyer.getbb.app", "/api/connect/desktop-session", {
        method: "POST",
        headers: { "x-bb-connect-machine": "paired" },
      }),
      env as never,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(mockHandleCreateDesktopSession).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(0);
  });
});

describe("POST /api/connect/disconnect", () => {
  it("intercepts self-revocation before tunnel routing", async () => {
    mockHandleDisconnectServer.mockResolvedValue(Response.json({ ok: true }));
    const { env, ctx, captured } = makeEnv(() => new Response("origin"));
    const request = visitorRequest(
      "sawyer.getbb.app",
      "/api/connect/disconnect",
      {
        method: "POST",
        headers: { "x-bb-connect-machine": "paired" },
      },
    );
    const response = await worker.fetch(request, env as never, ctx);

    expect(response.status).toBe(200);
    expect(mockHandleDisconnectServer).toHaveBeenCalledWith(request, env);
    expect(mockResolveLabel).not.toHaveBeenCalled();
    expect(captured).toHaveLength(0);
  });
});

describe("POST /api/connect/machine-label", () => {
  it("intercepts machine-authenticated assignment before label routing", async () => {
    mockHandleAssignMachineLabel.mockResolvedValue(
      Response.json({ label: "sawyer-air" }),
    );
    const { env, ctx, captured } = makeEnv(() => new Response("origin"));
    const request = visitorRequest(
      "unknown.getbb.app",
      "/api/connect/machine-label",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bb-connect-machine": "bbcm_machine",
        },
        body: JSON.stringify({ desiredName: "Sawyer Air" }),
      },
    );
    const response = await worker.fetch(request, env as never, ctx);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ label: "sawyer-air" });
    expect(mockHandleAssignMachineLabel).toHaveBeenCalledWith(request, env);
    expect(mockResolveLabel).not.toHaveBeenCalled();
    expect(captured).toHaveLength(0);
  });
});

describe("gate tunnel authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("authenticates a machine label and passes machineId to its TunnelDO", async () => {
    const credential = "bbcm_machine_secret";
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(credential),
    );
    const hash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    mockResolveLabel.mockResolvedValue(
      resolvedMachine({ credentialHash: hash }),
    );
    const { env, ctx, captured } = makeEnv(() => new Response("upgraded"));
    const response = await worker.fetch(
      visitorRequest(
        "sawyer-air.getbb.app",
        "/__tunnel?v=1&serverId=victim-server&machineId=spoofed-machine",
        {
          headers: {
            authorization: `Bearer ${credential}`,
            "x-bb-cloud-dev-host": "smuggled",
          },
        },
      ),
      env as never,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(mockResolveLabel).toHaveBeenCalledTimes(1);
    expect(mockResolveLabel).toHaveBeenCalledWith(
      "sawyer-air",
      expect.anything(),
      { fresh: true },
    );
    expect(new URL(captured[0].url).searchParams.get("machineId")).toBe(
      "machine-air",
    );
    expect(new URL(captured[0].url).searchParams.get("serverId")).toBeNull();
    expect(captured[0].headers.get("x-bb-cloud-dev-host")).toBeNull();
  });

  it("dials immediately after a negative resolve and label assignment", async () => {
    const credential = "bbcm_new_machine";
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(credential),
    );
    const hash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    mockResolveLabel
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(resolvedMachine({ credentialHash: hash }));
    const beforeEnv = makeEnv(() => new Response("origin"));
    const before = await worker.fetch(
      visitorRequest("sawyer-air.getbb.app", "/"),
      beforeEnv.env as never,
      beforeEnv.ctx,
    );
    expect(before.status).toBe(404);

    mockHandleAssignMachineLabel.mockResolvedValue(
      Response.json({ label: "sawyer-air" }),
    );
    const assignmentEnv = makeEnv(() => new Response("origin"));
    const assigned = await worker.fetch(
      visitorRequest("unknown.getbb.app", "/api/connect/machine-label", {
        method: "POST",
        headers: { "x-bb-connect-machine": credential },
        body: JSON.stringify({ desiredName: "Sawyer Air" }),
      }),
      assignmentEnv.env as never,
      assignmentEnv.ctx,
    );
    expect(assigned.status).toBe(200);

    const dialEnv = makeEnv(() => new Response("upgraded"));
    const dial = await worker.fetch(
      visitorRequest("sawyer-air.getbb.app", "/__tunnel", {
        headers: { authorization: `Bearer ${credential}` },
      }),
      dialEnv.env as never,
      dialEnv.ctx,
    );
    expect(dial.status).toBe(200);
    expect(mockResolveLabel).toHaveBeenNthCalledWith(
      1,
      "sawyer-air",
      expect.anything(),
      undefined,
    );
    expect(mockResolveLabel).toHaveBeenNthCalledWith(
      2,
      "sawyer-air",
      expect.anything(),
      { fresh: true },
    );
    expect(dialEnv.captured).toHaveLength(1);
  });

  it("fresh-resolves from the outset after a cached negative and refuses revoked machines", async () => {
    const credential = "bbcm_stale";
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(credential),
    );
    const hash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    mockResolveLabel.mockResolvedValueOnce(null);
    const firstEnv = makeEnv(() => new Response("origin"));
    const stale = await worker.fetch(
      visitorRequest("sawyer-air.getbb.app", "/__tunnel", {
        headers: { authorization: `Bearer ${credential}` },
      }),
      firstEnv.env as never,
      firstEnv.ctx,
    );
    expect(stale.status).toBe(404);
    expect(mockResolveLabel).toHaveBeenCalledWith(
      "sawyer-air",
      expect.anything(),
      { fresh: true },
    );
    expect(firstEnv.captured).toHaveLength(0);

    mockResolveLabel.mockReset();
    mockResolveLabel.mockResolvedValue(
      resolvedMachine({ credentialHash: hash, revokedAt: new Date() }),
    );
    const secondEnv = makeEnv(() => new Response("origin"));
    const revoked = await worker.fetch(
      visitorRequest("sawyer-air.getbb.app", "/__tunnel", {
        headers: { authorization: `Bearer ${credential}` },
      }),
      secondEnv.env as never,
      secondEnv.ctx,
    );
    expect(revoked.status).toBe(403);
    expect(secondEnv.captured).toHaveLength(0);
  });
});

describe("machine gate auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveLabel.mockResolvedValue(resolvedServer());
    mockMarkMachineSeen.mockResolvedValue(true);
  });

  it("rejects /internal without a machine credential", async () => {
    const { env, ctx, captured } = makeEnv(() => new Response("origin"));
    const response = await worker.fetch(
      visitorRequest("sawyer.getbb.app", "/internal/session/open"),
      env as never,
      ctx,
    );
    expect(response.status).toBe(403);
    expect(captured).toHaveLength(0);
  });

  it("rejects bogus and cross-tenant machine credentials", async () => {
    const { env, ctx, captured } = makeEnv(() => new Response("origin"));
    mockVerifyMachine.mockResolvedValueOnce(null).mockResolvedValueOnce({
      machineId: "machine-other",
      userId: OTHER,
    });
    const bogus = await worker.fetch(
      visitorRequest("sawyer.getbb.app", "/internal/session/open", {
        headers: { "x-bb-connect-machine": "bogus" },
      }),
      env as never,
      ctx,
    );
    const crossTenant = await worker.fetch(
      visitorRequest("sawyer.getbb.app", "/internal/session/open", {
        headers: { "x-bb-connect-machine": "bbcm_other" },
      }),
      env as never,
      ctx,
    );
    expect(bogus.status).toBe(403);
    expect(crossTenant.status).toBe(403);
    expect(captured).toHaveLength(0);
  });

  it("forwards /internal and /api/v1 for the owner with the header stripped", async () => {
    mockVerifyMachine.mockResolvedValue({
      machineId: "machine-owner",
      userId: OWNER,
    });
    const { env, ctx, captured } = makeEnv(() => new Response("origin"));
    const internal = await worker.fetch(
      visitorRequest("sawyer.getbb.app", "/internal/session/open", {
        headers: {
          "x-bb-connect-machine": "bbcm_owner",
          "x-bb-cloud-dev-host": "smuggled",
        },
      }),
      env as never,
      ctx,
    );
    const api = await worker.fetch(
      visitorRequest("sawyer.getbb.app", "/api/v1/threads", {
        headers: {
          "x-bb-connect-machine": "bbcm_owner",
          "x-bb-cloud-dev-host": "smuggled",
        },
      }),
      env as never,
      ctx,
    );
    expect(internal.status).toBe(200);
    expect(api.status).toBe(200);
    expect(captured).toHaveLength(2);
    expect(
      captured.every(
        (request) => request.headers.get("x-bb-connect-machine") === null,
      ),
    ).toBe(true);
    expect(
      captured.every(
        (request) => request.headers.get("x-bb-cloud-dev-host") === null,
      ),
    ).toBe(true);
    expect(
      captured.every(
        (request) => request.headers.get(GATE_AUTH_HEADER) === "machine",
      ),
    ).toBe(true);
    expect(
      captured.every(
        (request) =>
          request.headers.get(GATE_MACHINE_ID_HEADER) === "machine-owner",
      ),
    ).toBe(true);
    expect(mockMarkMachineSeen).toHaveBeenCalledWith(
      "machine-owner",
      expect.anything(),
    );
  });

  it("forbids machine credentials from minting join codes", async () => {
    mockVerifyMachine.mockResolvedValue({
      machineId: "machine-owner",
      userId: OWNER,
    });
    const { env, ctx, captured } = makeEnv(() => new Response("origin"));
    const response = await worker.fetch(
      visitorRequest("sawyer.getbb.app", "/api/v1/hosts/join-codes", {
        method: "POST",
        headers: { "x-bb-connect-machine": "bbcm_owner" },
      }),
      env as never,
      ctx,
    );
    expect(response.status).toBe(403);
    expect(captured).toHaveLength(0);
  });

  it("forbids machine credentials from minting loopback enroll keys", async () => {
    mockVerifyMachine.mockResolvedValue({
      machineId: "machine-owner",
      userId: OWNER,
    });
    const { env, ctx, captured } = makeEnv(() => new Response("origin"));
    const response = await worker.fetch(
      visitorRequest("sawyer.getbb.app", "/internal/hosts/enroll-key", {
        method: "POST",
        headers: { "x-bb-connect-machine": "bbcm_owner" },
      }),
      env as never,
      ctx,
    );
    expect(response.status).toBe(403);
    expect(captured).toHaveLength(0);
  });

  it.each(["/install.sh", "/install/version", "/install/bb-app.tgz"])(
    "forwards GET %s without session or machine auth",
    async (path) => {
      const { env, ctx, captured } = makeEnv(() => new Response("artifact"));
      const response = await worker.fetch(
        visitorRequest("sawyer.getbb.app", path, {
          headers: { "x-bb-cloud-dev-host": "smuggled" },
        }),
        env as never,
        ctx,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("artifact");
      expect(captured).toHaveLength(1);
      expect(captured[0].headers.get("x-bb-cloud-dev-host")).toBeNull();
      expect(mockVerifyMachine).not.toHaveBeenCalled();
    },
  );
});

describe("bb mobile app-link association files", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockParseCookie.mockReturnValue(null);
    mockResolveLabel.mockResolvedValue(resolvedServer());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    "/.well-known/apple-app-site-association",
    "/.well-known/assetlinks.json",
  ])(
    "serves %s on a bare label without a session and without proxying",
    async (path) => {
      const { env, ctx, captured } = makeEnv(() => new Response("origin"));
      const response = await worker.fetch(
        visitorRequest("sawyer.getbb.app", path),
        env as never,
        ctx,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(captured).toHaveLength(0);
      expect(mockResolveLabel).not.toHaveBeenCalled();
      expect(mockVerifySessionDetails).not.toHaveBeenCalled();
    },
  );

  it("serves the AASA on bare labels that do not resolve yet (Apple fetches anonymously before a claim)", async () => {
    mockResolveLabel.mockResolvedValue(null);
    const { env, ctx, captured } = makeEnv(() => new Response("origin"));
    const unknown = await worker.fetch(
      visitorRequest(
        "nobody-here.getbb.app",
        "/.well-known/apple-app-site-association",
      ),
      env as never,
      ctx,
    );
    expect(unknown.status).toBe(200);
    const body = (await unknown.json()) as {
      applinks: { details: { appIDs: string[] }[] };
    };
    expect(body.applinks.details[0]?.appIDs).toEqual([
      "9QCU24SXK5.app.getbb.mobile",
    ]);
    expect(captured).toHaveLength(0);
  });

  it.each([
    "/.well-known/apple-app-site-association",
    "/.well-known/assetlinks.json",
  ])(
    "does not claim %s on share hosts — they front arbitrary local apps, so the file falls through to the session gate",
    async (path) => {
      const { env, ctx, captured } = makeEnv(() => new Response("origin"));
      const share = await worker.fetch(
        visitorRequest("sawyer--8000.getbb.app", path),
        env as never,
        ctx,
      );
      expect(share.status).toBe(401);
      expect(share.headers.get("content-type")).not.toBe("application/json");
      expect(captured).toHaveLength(0);
    },
  );

  it("reads Android fingerprints from the env and serves an empty list otherwise", async () => {
    const { env, ctx } = makeEnv(() => new Response("origin"));
    const empty = await worker.fetch(
      visitorRequest("sawyer.getbb.app", "/.well-known/assetlinks.json"),
      env as never,
      ctx,
    );
    const emptyBody = (await empty.json()) as {
      target: { sha256_cert_fingerprints: string[] };
    }[];
    expect(emptyBody[0]?.target.sha256_cert_fingerprints).toEqual([]);

    const withEnv = await worker.fetch(
      visitorRequest("sawyer.getbb.app", "/.well-known/assetlinks.json"),
      { ...env, ASSETLINKS_SHA256_FINGERPRINTS: "aa:bb,cc:dd" } as never,
      ctx,
    );
    const withEnvBody = (await withEnv.json()) as {
      target: { package_name: string; sha256_cert_fingerprints: string[] };
    }[];
    expect(withEnvBody[0]?.target.package_name).toBe("app.getbb.mobile");
    expect(withEnvBody[0]?.target.sha256_cert_fingerprints).toEqual([
      "AA:BB",
      "CC:DD",
    ]);
  });

  it("leaves other .well-known paths to the session gate", async () => {
    const { env, ctx, captured } = makeEnv(() => new Response("origin"));
    const response = await worker.fetch(
      visitorRequest("sawyer.getbb.app", "/.well-known/openid-configuration"),
      env as never,
      ctx,
    );
    expect(response.status).toBe(401);
    expect(captured).toHaveLength(0);
  });
});

describe("gate worker share hosts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveLabel.mockResolvedValue(resolvedServer());
    mockParseCookie.mockReturnValue("session-token");
    mockVerifySessionDetails.mockResolvedValue(sessionDetails());
    mockRefreshAccountSession.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("forwards share hosts to the DO with x-bb-tunnel-target", async () => {
    const { env, ctx, captured } = makeEnv(() => new Response("ok"));
    const res = await worker.fetch(
      visitorRequest("sawyer--8000.getbb.app", "/app", {
        headers: { [TUNNEL_TARGET_HEADER]: "smuggled" },
      }),
      env as never,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].headers.get(TUNNEL_TARGET_HEADER)).toBe("8000");
    expect(mockServeWithCache).toHaveBeenCalledWith(
      expect.any(Request),
      "sawyer--8000",
      ctx,
      expect.any(Function),
    );
  });

  it("renews an active owner session on an ordinary HTTP response", async () => {
    mockVerifySessionDetails.mockResolvedValue(sessionDetails(OWNER, true));
    mockRefreshAccountSession.mockResolvedValue([
      "__Secure-better-auth.session_token=renewed; Max-Age=604800; Domain=.getbb.app; Path=/; HttpOnly; SameSite=Lax; Secure",
      "__Secure-better-auth.session_data=cached; Max-Age=300; Domain=.getbb.app; Path=/; HttpOnly; SameSite=Lax; Secure",
    ]);
    const { env, ctx } = makeEnv(() => new Response("ok"));
    const response = await worker.fetch(
      visitorRequest("sawyer.getbb.app", "/api/v1/threads"),
      env as never,
      ctx,
    );

    expect(mockRefreshAccountSession).toHaveBeenCalledWith(
      "__Secure-better-auth.session_token=session-token",
      "https://getbb.app",
      expect.any(Function),
    );
    expect(mockInvalidateSession).toHaveBeenCalledWith("session-token");
    expect(response.headers.get("set-cookie")).toContain(
      "__Secure-better-auth.session_token=renewed",
    );
    expect(response.headers.get("set-cookie")).toContain(
      "__Secure-better-auth.session_data=cached",
    );
  });

  it("does not call the account worker before the update-age boundary", async () => {
    const { env, ctx } = makeEnv(() => new Response("ok"));
    const response = await worker.fetch(
      visitorRequest("sawyer.getbb.app", "/api/v1/threads"),
      env as never,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(mockInvalidateSession).not.toHaveBeenCalled();
    expect(mockRefreshAccountSession).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it.each(["hit", "miss"] as const)(
    "does not renew an owner session on an edge-cache %s",
    async (cacheStatus) => {
      mockVerifySessionDetails.mockResolvedValue(sessionDetails(OWNER, true));
      mockRefreshAccountSession.mockResolvedValue(["should-not-be-used"]);
      mockServeWithCache.mockResolvedValueOnce({
        cacheable: true,
        response: new Response("cached asset", {
          headers: { "x-bb-cache": cacheStatus },
        }),
      });
      const { env, ctx } = makeEnv(() => new Response("origin"));

      const response = await worker.fetch(
        visitorRequest("sawyer.getbb.app", "/assets/app.js"),
        env as never,
        ctx,
      );

      expect(mockRefreshAccountSession).not.toHaveBeenCalled();
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("x-bb-cache")).toBe(cacheStatus);
      await expect(response.text()).resolves.toBe("cached asset");
    },
  );

  it("reissues the local Cloud cookie without the Secure attribute", async () => {
    mockVerifySessionDetails.mockResolvedValue(sessionDetails(OWNER, true));
    mockRefreshAccountSession.mockResolvedValue([
      "better-auth.session_token=renewed; Max-Age=604800; Domain=.bb.localhost; Path=/; HttpOnly; SameSite=Lax",
    ]);
    const { env, ctx } = makeEnv(() => new Response("ok"));
    Object.assign(env, {
      ACCOUNT_APP_URL: "http://bb.localhost:42745",
      BASE_DOMAIN: "bb.localhost",
      CLOUD_DEV: "true",
    });
    const response = await worker.fetch(
      new Request("http://127.0.0.1:50743/api/v1/threads", {
        headers: {
          host: "127.0.0.1:50743",
          "x-bb-cloud-dev-host": "sawyer",
        },
      }),
      env as never,
      ctx,
    );

    expect(response.headers.get("set-cookie")).toBe(
      "better-auth.session_token=renewed; Max-Age=604800; Domain=.bb.localhost; Path=/; HttpOnly; SameSite=Lax",
    );
    expect(mockRefreshAccountSession).toHaveBeenCalledWith(
      "better-auth.session_token=session-token",
      "http://bb.localhost:42745",
      expect.any(Function),
    );
  });

  it("renders a bare machine-label page without proxying to the DO", async () => {
    mockResolveLabel.mockResolvedValue(resolvedMachine());
    mockParseCookie.mockReturnValue(null);
    const { env, ctx, captured } = makeEnv(() => new Response("origin"));
    const response = await worker.fetch(
      visitorRequest("sawyer-air.getbb.app", "/"),
      env as never,
      ctx,
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("sawyer-air</code> is a machine");
    expect(html).toContain("sawyer-air--&lt;port&gt;.getbb.app");
    expect(html).toContain("sawyer.getbb.app");
    expect(captured).toHaveLength(0);
    expect(mockVerifySessionDetails).not.toHaveBeenCalled();
  });

  it("renders local machine links with HTTP and the shared gateway port", async () => {
    mockResolveLabel.mockResolvedValue(resolvedMachine());
    const { env, ctx } = makeEnv(() => new Response("origin"));
    Object.assign(env, {
      ACCOUNT_APP_URL: "http://bb.localhost:42745",
      BASE_DOMAIN: "bb.localhost",
      CLOUD_DEV: "true",
    });
    const response = await worker.fetch(
      new Request("http://127.0.0.1:50743/", {
        headers: {
          host: "127.0.0.1:50743",
          "x-bb-cloud-dev-host": "sawyer-air",
        },
      }),
      env as never,
      ctx,
    );

    const html = await response.text();
    expect(html).toContain("sawyer-air--&lt;port&gt;.bb.localhost:42745");
    expect(html).toContain('href="http://sawyer.bb.localhost:42745"');
  });

  it("applies the same owner-session check to machine share hosts", async () => {
    mockResolveLabel.mockResolvedValue(resolvedMachine());
    const ownerEnv = makeEnv(() => new Response("machine-origin"));
    const ownerResponse = await worker.fetch(
      visitorRequest("sawyer-air--3000.getbb.app", "/"),
      ownerEnv.env as never,
      ownerEnv.ctx,
    );
    expect(ownerResponse.status).toBe(200);
    expect(ownerEnv.captured[0].headers.get(TUNNEL_TARGET_HEADER)).toBe("3000");
    expect(mockServeWithCache).toHaveBeenLastCalledWith(
      expect.any(Request),
      "sawyer-air:machine-generation--3000",
      ownerEnv.ctx,
      expect.any(Function),
    );

    mockVerifySessionDetails.mockResolvedValue(sessionDetails(OTHER));
    const otherEnv = makeEnv(() => new Response("machine-origin"));
    const otherResponse = await worker.fetch(
      visitorRequest("sawyer-air--3000.getbb.app", "/"),
      otherEnv.env as never,
      otherEnv.ctx,
    );
    expect(otherResponse.status).toBe(403);
    expect(otherEnv.captured).toHaveLength(0);
  });

  it("isolates a reused machine label by ownership generation", async () => {
    mockResolveLabel.mockResolvedValue(
      resolvedMachine({ routingKey: "shared-machine:generation-a" }),
    );
    const oldEnv = makeEnv(() => new Response("owner-a"));
    const oldResponse = await worker.fetch(
      visitorRequest("shared-machine--3000.getbb.app", "/asset.js"),
      oldEnv.env as never,
      oldEnv.ctx,
    );
    expect(oldResponse.status).toBe(200);
    expect(oldEnv.routingKeys).toEqual(["shared-machine:generation-a"]);
    expect(mockServeWithCache).toHaveBeenLastCalledWith(
      expect.any(Request),
      "shared-machine:generation-a--3000",
      oldEnv.ctx,
      expect.any(Function),
    );

    mockResolveLabel.mockResolvedValue(
      resolvedMachine({
        routingKey: "shared-machine:generation-b",
        userId: OTHER,
      }),
    );
    const blockedEnv = makeEnv(() => new Response("wrong-owner-content"));
    const blockedResponse = await worker.fetch(
      visitorRequest("shared-machine--3000.getbb.app", "/asset.js"),
      blockedEnv.env as never,
      blockedEnv.ctx,
    );
    expect(blockedResponse.status).toBe(403);
    expect(blockedEnv.routingKeys).toEqual(["shared-machine:generation-b"]);
    expect(blockedEnv.captured).toHaveLength(0);

    mockVerifySessionDetails.mockResolvedValue(sessionDetails(OTHER));
    const newEnv = makeEnv(() => new Response("owner-b"));
    const newResponse = await worker.fetch(
      visitorRequest("shared-machine--3000.getbb.app", "/asset.js"),
      newEnv.env as never,
      newEnv.ctx,
    );
    expect(newResponse.status).toBe(200);
    expect(newEnv.routingKeys).toEqual(["shared-machine:generation-b"]);
    expect(mockServeWithCache).toHaveBeenLastCalledWith(
      expect.any(Request),
      "shared-machine:generation-b--3000",
      newEnv.ctx,
      expect.any(Function),
    );
  });

  it("strips a smuggled target header on bare hosts", async () => {
    const { env, ctx, captured } = makeEnv(() => new Response("ok"));
    await worker.fetch(
      visitorRequest("sawyer.getbb.app", "/", {
        headers: {
          [TUNNEL_TARGET_HEADER]: "9999",
          "x-bb-cloud-dev-host": "smuggled",
        },
      }),
      env as never,
      ctx,
    );
    expect(captured).toHaveLength(1);
    expect(captured[0].headers.get(TUNNEL_TARGET_HEADER)).toBeNull();
    expect(captured[0].headers.get("x-bb-cloud-dev-host")).toBeNull();
    expect(mockServeWithCache).toHaveBeenCalledWith(
      expect.any(Request),
      "sawyer",
      ctx,
      expect.any(Function),
    );
  });

  it("strips forged gate auth and stamps session-authenticated forwards", async () => {
    const { env, ctx, captured } = makeEnv(() => new Response("ok"));
    const response = await worker.fetch(
      visitorRequest("sawyer.getbb.app", "/api/v1/hosts/join-codes", {
        method: "POST",
        headers: { [GATE_AUTH_HEADER]: "machine" },
      }),
      env as never,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].headers.get(GATE_AUTH_HEADER)).toBe("session");
  });

  it("forwards a share host on a non-primary label (single-dash subdomain)", async () => {
    mockResolveLabel.mockResolvedValue(resolvedServer());
    const { env, ctx, captured } = makeEnv(() => new Response("ok"));
    const res = await worker.fetch(
      visitorRequest("sawyer-desktop--3000.getbb.app", "/app"),
      env as never,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(mockResolveLabel).toHaveBeenCalledWith(
      "sawyer-desktop",
      expect.anything(),
      undefined,
    );
    expect(captured[0].headers.get(TUNNEL_TARGET_HEADER)).toBe("3000");
    expect(mockServeWithCache).toHaveBeenCalledWith(
      expect.any(Request),
      "sawyer-desktop--3000",
      ctx,
      expect.any(Function),
    );
  });

  it("returns 401 sign-in page when share host has no session", async () => {
    mockParseCookie.mockReturnValue(null);
    const { env, ctx, captured } = makeEnv(() => new Response("ok"));
    const res = await worker.fetch(
      visitorRequest("sawyer--8000.getbb.app", "/"),
      env as never,
      ctx,
    );
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain("Sign in");
    expect(html).toContain("sawyer");
    expect(captured).toHaveLength(0);
  });

  it("preserves the public local URL in the sign-in returnTo", async () => {
    mockParseCookie.mockReturnValue(null);
    const { env, ctx } = makeEnv(() => new Response("ok"));
    Object.assign(env, {
      ACCOUNT_APP_URL: "http://bb.localhost:42745",
      BASE_DOMAIN: "bb.localhost",
      CLOUD_DEV: "true",
    });
    const response = await worker.fetch(
      new Request("http://127.0.0.1:50743/threads/thr_1?view=full", {
        headers: {
          host: "127.0.0.1:50743",
          "x-bb-cloud-dev-host": "sawyer",
        },
      }),
      env as never,
      ctx,
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toContain(
      "returnTo=http%3A%2F%2Fsawyer.bb.localhost%3A42745%2Fthreads%2Fthr_1%3Fview%3Dfull",
    );
  });

  it("returns 403 when share host session is a different user", async () => {
    mockVerifySessionDetails.mockResolvedValue(sessionDetails(OTHER));
    const { env, ctx, captured } = makeEnv(() => new Response("ok"));
    const res = await worker.fetch(
      visitorRequest("sawyer--8000.getbb.app", "/"),
      env as never,
      ctx,
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("not your server");
    expect(captured).toHaveLength(0);
    expect(mockRefreshAccountSession).not.toHaveBeenCalled();
  });

  it("accepts the short-lived desktop cookie for the owning account", async () => {
    mockParseCookie.mockImplementation((_header, name) =>
      name === DESKTOP_SESSION_COOKIE ? "desktop-token" : null,
    );
    mockVerifyDesktopSession.mockResolvedValue(OWNER);
    const { env, ctx, captured } = makeEnv(() => new Response("ok"));
    const response = await worker.fetch(
      visitorRequest("sawyer.getbb.app", "/"),
      env as never,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(mockVerifyDesktopSession).toHaveBeenCalledWith(
      "desktop-token",
      "test-secret",
    );
    expect(captured).toHaveLength(1);
  });

  it("uses the desktop cookie when a stale GitHub session belongs to another account", async () => {
    mockParseCookie.mockImplementation((_header, name) =>
      name === DESKTOP_SESSION_COOKIE ? "desktop-token" : "github-token",
    );
    mockVerifySessionDetails.mockResolvedValue(sessionDetails(OTHER));
    mockVerifyDesktopSession.mockResolvedValue(OWNER);
    const { env, ctx, captured } = makeEnv(() => new Response("ok"));
    const response = await worker.fetch(
      visitorRequest("sawyer.getbb.app", "/"),
      env as never,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
  });

  it("returns 404 for /__tunnel and /internal/* on share hosts", async () => {
    const { env, ctx, captured } = makeEnv(() => new Response("ok"));
    const tunnel = await worker.fetch(
      visitorRequest("sawyer--8000.getbb.app", "/__tunnel"),
      env as never,
      ctx,
    );
    expect(tunnel.status).toBe(404);
    expect(await tunnel.text()).toContain("not found");

    const internal = await worker.fetch(
      visitorRequest("sawyer--8000.getbb.app", "/internal/x"),
      env as never,
      ctx,
    );
    expect(internal.status).toBe(404);
    expect(await internal.text()).toContain("not found");
    expect(captured).toHaveLength(0);
  });

  it("redirects reserved handles and 404s the apex", async () => {
    const { env, ctx } = makeEnv(() => new Response("ok"));
    const reserved = await worker.fetch(
      visitorRequest("docs.getbb.app", "/docs"),
      env as never,
      ctx,
    );
    expect(reserved.status).toBe(301);
    expect(reserved.headers.get("location")).toBe("https://getbb.app/docs");

    const apex = await worker.fetch(
      new Request("https://getbb.app/", { headers: { host: "getbb.app" } }),
      env as never,
      ctx,
    );
    expect(apex.status).toBe(404);
    expect(await apex.text()).toContain("unknown host");
  });

  it("forwards websocket upgrades on share hosts with the target header", async () => {
    mockVerifySessionDetails.mockResolvedValue(sessionDetails(OWNER, true));
    const { env, ctx, captured } = makeEnv(
      () => new Response("upgraded", { status: 200 }),
    );
    await worker.fetch(
      visitorRequest("sawyer--8000.getbb.app", "/ws", {
        headers: { upgrade: "websocket" },
      }),
      env as never,
      ctx,
    );
    expect(captured).toHaveLength(1);
    expect(captured[0].headers.get(TUNNEL_TARGET_HEADER)).toBe("8000");
    expect(captured[0].headers.get("upgrade")).toBe("websocket");
    expect(mockServeWithCache).not.toHaveBeenCalled();
    expect(mockRefreshAccountSession).not.toHaveBeenCalled();
  });

  it("does not apply machine-credential branch on share hosts", async () => {
    mockParseCookie.mockReturnValue(null);
    mockVerifyMachine.mockResolvedValue({
      machineId: "machine-owner",
      userId: OWNER,
    });
    const { env, ctx, captured } = makeEnv(() => new Response("ok"));
    const res = await worker.fetch(
      visitorRequest("sawyer--8000.getbb.app", "/internal/ws", {
        headers: { "x-bb-connect-machine": "bbcm_ok" },
      }),
      env as never,
      ctx,
    );
    expect(res.status).toBe(404);
    expect(mockVerifyMachine).not.toHaveBeenCalled();
    expect(captured).toHaveLength(0);
  });

  it("rejects invalid share hosts as unknown", async () => {
    const { env, ctx } = makeEnv(() => new Response("ok"));
    const res = await worker.fetch(
      visitorRequest("sawyer--08000.getbb.app", "/"),
      env as never,
      ctx,
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("unknown host");
  });
});

const OFFLINE_BODY =
  "bb connect: this server is offline (no tunnel connected)\n";

function offlineDoResponse(): Response {
  return new Response(OFFLINE_BODY, {
    status: 503,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      [TUNNEL_OFFLINE_HEADER]: "1",
    },
  });
}

describe("gate offline page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockParseCookie.mockReturnValue("session-token");
    mockVerifySessionDetails.mockResolvedValue(sessionDetails());
  });

  it("renders the styled offline page on a browser navigation, using last-seen", async () => {
    mockResolveLabel.mockResolvedValue(
      resolvedServer({ lastSeenAt: new Date(Date.now() - 5 * 60_000) }),
    );
    const { env, ctx } = makeEnv(offlineDoResponse);
    const res = await worker.fetch(
      visitorRequest("sawyer.getbb.app", "/", {
        headers: { accept: "text/html" },
      }),
      env as never,
      ctx,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Your bb is offline");
    expect(html).toContain("Last seen 5 minutes ago");
    expect(html).toContain('http-equiv="refresh"');
  });

  it("omits the last-seen sentence when the server never connected", async () => {
    mockResolveLabel.mockResolvedValue(resolvedServer({ lastSeenAt: null }));
    const { env, ctx } = makeEnv(offlineDoResponse);
    const res = await worker.fetch(
      visitorRequest("sawyer.getbb.app", "/", {
        headers: { accept: "text/html" },
      }),
      env as never,
      ctx,
    );
    const html = await res.text();
    expect(html).toContain("Your bb is offline");
    expect(html).not.toContain("Last seen");
  });

  it("names the machine and its last-seen when a machine share host is offline", async () => {
    mockResolveLabel.mockResolvedValue(
      resolvedMachine({ lastSeenAt: new Date(Date.now() - 5 * 60_000) }),
    );
    const { env, ctx } = makeEnv(offlineDoResponse);
    const res = await worker.fetch(
      visitorRequest("sawyer-air--3000.getbb.app", "/", {
        headers: { accept: "text/html" },
      }),
      env as never,
      ctx,
    );
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain("This machine is offline");
    expect(html).toContain("This machine was last seen 5 minutes ago");
    expect(html).not.toContain("Your bb is offline");
  });

  it("keeps the plain 503 for non-navigation requests (API/assets/fetch)", async () => {
    mockResolveLabel.mockResolvedValue(resolvedServer());
    const { env, ctx } = makeEnv(offlineDoResponse);
    const res = await worker.fetch(
      visitorRequest("sawyer.getbb.app", "/api/threads", {
        headers: { accept: "application/json" },
      }),
      env as never,
      ctx,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe(OFFLINE_BODY);
  });

  it("does not intercept an origin 503 that lacks the offline marker", async () => {
    mockResolveLabel.mockResolvedValue(resolvedServer());
    const { env, ctx } = makeEnv(
      () => new Response("origin down", { status: 503 }),
    );
    const res = await worker.fetch(
      visitorRequest("sawyer.getbb.app", "/", {
        headers: { accept: "text/html" },
      }),
      env as never,
      ctx,
    );
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("origin down");
  });
});

describe("gate page helpers", () => {
  it("relativeTime buckets from just-now through calendar date", () => {
    const now = Date.UTC(2026, 6, 8, 12, 0, 0);
    expect(relativeTime(new Date(now - 30_000), now)).toBe("just now");
    expect(relativeTime(new Date(now - 60_000), now)).toBe("1 minute ago");
    expect(relativeTime(new Date(now - 5 * 60_000), now)).toBe("5 minutes ago");
    expect(relativeTime(new Date(now - 60 * 60_000), now)).toBe("1 hour ago");
    expect(relativeTime(new Date(now - 3 * 60 * 60_000), now)).toBe(
      "3 hours ago",
    );
    expect(
      relativeTime(new Date(now - 3 * 24 * 60 * 60_000), now),
    ).not.toContain("ago");
  });

  it("wantsHtml only matches a text/html Accept", () => {
    expect(
      wantsHtml(
        new Request("https://x/", { headers: { accept: "text/html" } }),
      ),
    ).toBe(true);
    expect(
      wantsHtml(
        new Request("https://x/", {
          headers: { accept: "text/html,application/xhtml+xml" },
        }),
      ),
    ).toBe(true);
    expect(
      wantsHtml(new Request("https://x/", { headers: { accept: "*/*" } })),
    ).toBe(false);
    expect(wantsHtml(new Request("https://x/"))).toBe(false);
  });

  it("offlinePage is a self-retrying styled 503", async () => {
    const res = offlinePage(null, "server");
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Retry now");
  });
});

class FakeWebSocketRequestResponsePair {
  constructor(
    readonly request: string,
    readonly response: string,
  ) {}
}
vi.stubGlobal("WebSocketRequestResponsePair", FakeWebSocketRequestResponsePair);

type MockState = {
  addSocket: (ws: WebSocket, tags: string[]) => void;
  storage: Map<string, unknown>;
  restore: Promise<void>;
  api: DurableObjectState;
};

function mockDoState(initialStorage: Record<string, unknown> = {}): MockState {
  const storage = new Map<string, unknown>(Object.entries(initialStorage));
  const entries: Array<{ ws: WebSocket; tags: string[] }> = [];
  let restore = Promise.resolve();
  const api = {
    getWebSockets: (tag?: string) =>
      entries
        .filter((entry) => tag === undefined || entry.tags.includes(tag))
        .map((entry) => entry.ws),
    getTags: (ws: WebSocket) =>
      entries.find((entry) => entry.ws === ws)?.tags ?? [],
    acceptWebSocket: (ws: WebSocket, tags: string[] = []) => {
      entries.push({ ws, tags });
    },
    setWebSocketAutoResponse: vi.fn(),
    blockConcurrencyWhile: (fn: () => Promise<void>) => {
      restore = fn();
      return restore;
    },
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => {
        storage.set(key, value);
      },
      delete: async (key: string) => {
        storage.delete(key);
      },
      setAlarm: async () => {},
    },
  } as unknown as DurableObjectState;
  return {
    addSocket: (ws: WebSocket, tags: string[]) => {
      entries.push({ ws, tags });
    },
    storage,
    get restore() {
      return restore;
    },
    api,
  };
}

function makeDoEnv() {
  return {
    TUNNEL_DO: {} as DurableObjectNamespace,
    DB: {} as D1Database,
    BASE_DOMAIN: BASE,
    BETTER_AUTH_SECRET: "s",
  };
}

function fakeTunnelSocket(
  send?: (data: ArrayBuffer | ArrayBufferView | string) => void,
  readyState = 1,
) {
  return {
    send: send ?? vi.fn(),
    close: vi.fn(),
    deserializeAttachment: () => null,
    readyState,
  } as unknown as WebSocket;
}

describe("TunnelDO machine presence", () => {
  it("rejects a tunnel request carrying both identity kinds", async () => {
    const state = mockDoState();
    const dob = new TunnelDO(state.api, makeDoEnv());
    await state.restore;
    const response = await dob.fetch(
      new Request(
        "https://do.internal/__tunnel?serverId=victim&machineId=attacker",
        { headers: { upgrade: "websocket" } },
      ),
    );
    expect(response.status).toBe(400);
  });

  it("bumps machine.lastSeenAt when a machine-label tunnel is connected", async () => {
    const run = vi.fn(async () => {});
    const where = vi.fn(() => ({ run }));
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    vi.mocked(drizzle).mockReturnValue({ update } as never);
    const state = mockDoState({ machineId: "machine-air", protocolVersion: 1 });
    const dob = new TunnelDO(state.api, makeDoEnv());
    await state.restore;
    state.addSocket(fakeTunnelSocket(), ["tunnel"]);

    await dob.alarm();

    expect(update).toHaveBeenCalledWith(machine);
    expect(set).toHaveBeenCalledWith({ lastSeenAt: expect.any(Date) });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("TunnelDO targeted request with old client", () => {
  it("returns 502 when client protocol version is < 1", async () => {
    const state = mockDoState({ protocolVersion: 0 });
    const dob = new TunnelDO(state.api, makeDoEnv());
    await state.restore;

    state.addSocket(fakeTunnelSocket(), ["tunnel"]);

    const res = await dob.fetch(
      new Request("https://do.internal/", {
        headers: { [TUNNEL_TARGET_HEADER]: "8000" },
      }),
    );
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("too old for port sharing");
  });

  it("refuses targeted websocket upgrades when client is too old", async () => {
    const state = mockDoState({ protocolVersion: 0 });
    const dob = new TunnelDO(state.api, makeDoEnv());
    await state.restore;
    state.addSocket(fakeTunnelSocket(), ["tunnel"]);

    const res = await dob.fetch(
      new Request("https://do.internal/ws", {
        headers: {
          upgrade: "websocket",
          [TUNNEL_TARGET_HEADER]: "8000",
        },
      }),
    );
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("too old for port sharing");
  });

  it("stamps target on open-http when protocol version is >= 1", async () => {
    vi.useFakeTimers();
    try {
      const sent: Uint8Array[] = [];
      const state = mockDoState({ protocolVersion: 1 });
      const dob = new TunnelDO(state.api, makeDoEnv());
      await state.restore;
      state.addSocket(
        fakeTunnelSocket((data) => {
          if (typeof data === "string") return;
          if (data instanceof ArrayBuffer) {
            sent.push(new Uint8Array(data));
          } else {
            sent.push(
              new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
            );
          }
        }),
        ["tunnel"],
      );

      const pending = dob.fetch(
        new Request("https://do.internal/foo", {
          method: "GET",
          headers: { [TUNNEL_TARGET_HEADER]: "8000" },
        }),
      );

      expect(sent.length).toBeGreaterThanOrEqual(1);
      const frame = decodeFrame(sent[0]);
      expect(frame.type).toBe("open-http");
      if (frame.type !== "open-http") throw new Error("unreachable");
      expect(frame.target).toBe("8000");
      expect(frame.path).toBe("/foo");
      expect(
        frame.headers.every(([n]) => n.toLowerCase() !== TUNNEL_TARGET_HEADER),
      ).toBe(true);

      vi.advanceTimersByTime(30_000);
      const timedOut = await pending;
      expect(timedOut.status).toBe(504);
    } finally {
      vi.useRealTimers();
    }
  });
});

function captureSent(sent: Uint8Array[]) {
  return (data: ArrayBuffer | ArrayBufferView | string) => {
    if (typeof data === "string") return;
    if (data instanceof ArrayBuffer) {
      sent.push(new Uint8Array(data));
    } else {
      sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }
  };
}

function frameBuffer(frame: Frame): ArrayBuffer {
  const u8 = encodeFrame(frame);
  return u8.buffer.slice(
    u8.byteOffset,
    u8.byteOffset + u8.byteLength,
  ) as ArrayBuffer;
}

function openHttpStreamId(sent: Uint8Array[], index: number): number {
  const frame = decodeFrame(sent[index]);
  if (frame.type !== "open-http")
    throw new Error(`expected open-http at ${index}`);
  return frame.streamId;
}

describe("TunnelDO response relay", () => {
  it("closes the origin stream when the visitor cancels a response body", async () => {
    const sent: Uint8Array[] = [];
    const state = mockDoState({ protocolVersion: 1 });
    const dob = new TunnelDO(state.api, makeDoEnv());
    await state.restore;
    const tunnel = fakeTunnelSocket(captureSent(sent));
    state.addSocket(tunnel, ["tunnel"]);

    const pending = dob.fetch(new Request("https://do.internal/slow"));
    const streamId = openHttpStreamId(sent, 0);
    dob.webSocketMessage(
      tunnel,
      frameBuffer({
        type: "resp-head",
        streamId,
        status: 200,
        headers: [["content-type", "text/plain"]],
      }),
    );
    const response = await pending;

    await response.body?.cancel("visitor left");
    await vi.waitFor(() => {
      const close = sent
        .map(decodeFrame)
        .find(
          (frame) =>
            frame.type === "close-stream" && frame.streamId === streamId,
        );
      expect(close).toMatchObject({
        type: "close-stream",
        streamId,
        code: 1000,
        reason: "visitor canceled response body",
      });
    });
  });

  it("keeps a streamed response body open after the response-head timeout window", async () => {
    vi.useFakeTimers();
    try {
      const sent: Uint8Array[] = [];
      const state = mockDoState({ protocolVersion: 1 });
      const dob = new TunnelDO(state.api, makeDoEnv());
      await state.restore;
      const tunnel = fakeTunnelSocket(captureSent(sent));
      state.addSocket(tunnel, ["tunnel"]);

      const pending = dob.fetch(
        new Request("https://do.internal/session/tool-call"),
      );
      const streamId = openHttpStreamId(sent, 0);
      dob.webSocketMessage(
        tunnel,
        frameBuffer({
          type: "resp-head",
          streamId,
          status: 200,
          headers: [["content-type", "application/json"]],
        }),
      );
      const response = await pending;

      await vi.advanceTimersByTimeAsync(30_000);
      dob.webSocketMessage(
        tunnel,
        frameBuffer({
          type: "body-chunk",
          streamId,
          data: new TextEncoder().encode('{"answer":"ready"}'),
        }),
      );
      dob.webSocketMessage(tunnel, frameBuffer({ type: "body-end", streamId }));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ answer: "ready" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("relays null-body statuses (304/204) bodiless instead of stranding the visitor", async () => {
    const sent: Uint8Array[] = [];
    const state = mockDoState({ protocolVersion: 1 });
    const dob = new TunnelDO(state.api, makeDoEnv());
    await state.restore;
    const tunnel = fakeTunnelSocket(captureSent(sent));
    state.addSocket(tunnel, ["tunnel"]);

    for (const [index, status] of [304, 204].entries()) {
      const pending = dob.fetch(
        new Request("https://do.internal/app.js", {
          headers: { "if-none-match": 'W/"abc"' },
        }),
      );
      const streamId = openHttpStreamId(sent, index);
      dob.webSocketMessage(
        tunnel,
        frameBuffer({
          type: "resp-head",
          streamId,
          status,
          headers: [
            ["etag", 'W/"abc"'],
            ["connection", "keep-alive"],
          ],
        }),
      );
      dob.webSocketMessage(tunnel, frameBuffer({ type: "body-end", streamId }));
      const res = await pending;
      expect(res.status).toBe(status);
      expect(res.body).toBeNull();
      expect(res.headers.get("etag")).toBe('W/"abc"');
      expect(res.headers.get("connection")).toBeNull();
    }
  });

  it("answers 502 for a response status that cannot be constructed", async () => {
    const sent: Uint8Array[] = [];
    const state = mockDoState({ protocolVersion: 1 });
    const dob = new TunnelDO(state.api, makeDoEnv());
    await state.restore;
    const tunnel = fakeTunnelSocket(captureSent(sent));
    state.addSocket(tunnel, ["tunnel"]);

    const pending = dob.fetch(new Request("https://do.internal/weird"));
    const streamId = openHttpStreamId(sent, 0);
    dob.webSocketMessage(
      tunnel,
      frameBuffer({ type: "resp-head", streamId, status: 199, headers: [] }),
    );
    const res = await pending;
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("unrelayable");
  });

  it("fails in-flight streams and closes visitor sockets when a new tunnel replaces the old", async () => {
    const sent: Uint8Array[] = [];
    const state = mockDoState({ protocolVersion: 1 });
    const dob = new TunnelDO(state.api, makeDoEnv());
    await state.restore;
    const oldTunnel = fakeTunnelSocket(captureSent(sent));
    state.addSocket(oldTunnel, ["tunnel"]);
    const visitor = fakeTunnelSocket();
    state.addSocket(visitor, ["visitor:41"]);

    const pendingHead = dob.fetch(new Request("https://do.internal/pending"));
    const pendingBody = dob.fetch(new Request("https://do.internal/mid-body"));
    const bodyStreamId = openHttpStreamId(sent, 1);
    dob.webSocketMessage(
      oldTunnel,
      frameBuffer({
        type: "resp-head",
        streamId: bodyStreamId,
        status: 200,
        headers: [["content-type", "text/plain"]],
      }),
    );
    const midBodyResponse = await pendingBody;
    expect(midBodyResponse.status).toBe(200);

    const RealResponse = globalThis.Response;
    class FakeWebSocketPair {
      0 = fakeTunnelSocket();
      1 = fakeTunnelSocket();
    }
    class WorkersResponse extends RealResponse {
      readonly webSocket: WebSocket | null;
      constructor(
        body?: BodyInit | null,
        init?: ResponseInit & { webSocket?: WebSocket | null },
      ) {
        if (init?.webSocket != null) {
          super(null, { status: 200 });
          Object.defineProperty(this, "status", { value: init.status });
          this.webSocket = init.webSocket;
        } else {
          super(body ?? null, init);
          this.webSocket = null;
        }
      }
    }
    globalThis.Response = WorkersResponse as never;
    (globalThis as { WebSocketPair?: unknown }).WebSocketPair =
      FakeWebSocketPair;
    try {
      const upgrade = await dob.fetch(
        new Request("https://do.internal/__tunnel?v=1", {
          headers: { upgrade: "websocket" },
        }),
      );
      expect(upgrade.status).toBe(101);
    } finally {
      globalThis.Response = RealResponse;
      delete (globalThis as { WebSocketPair?: unknown }).WebSocketPair;
    }

    expect(vi.mocked(oldTunnel.close)).toHaveBeenCalledWith(
      1000,
      "replaced by a new tunnel connection",
    );
    expect(vi.mocked(visitor.close)).toHaveBeenCalledWith(
      1001,
      "tunnel reconnected",
    );

    const headResponse = await pendingHead;
    expect(headResponse.status).toBe(502);
    expect(await headResponse.text()).toContain(
      "tunnel reconnected mid-request",
    );
    await expect(midBodyResponse.text()).rejects.toBeTruthy();
  });
});

describe("TunnelDO dead tunnel sockets", () => {
  const READY_STATE_CLOSED = 3;

  function deadTunnelSocket() {
    return fakeTunnelSocket(() => {
      throw new TypeError("Can't call WebSocket send() after close().");
    }, READY_STATE_CLOSED);
  }

  it("answers 503 offline when the only tunnel socket is dead", async () => {
    const state = mockDoState({ protocolVersion: 1 });
    const dob = new TunnelDO(state.api, makeDoEnv());
    await state.restore;
    state.addSocket(deadTunnelSocket(), ["tunnel"]);

    const res = await dob.fetch(new Request("https://do.internal/"));
    expect(res.status).toBe(503);
    expect(res.headers.get("x-bb-tunnel-offline")).toBe("1");
  });

  it("routes around a lingering dead socket to the live replacement", async () => {
    const sent: Uint8Array[] = [];
    const state = mockDoState({ protocolVersion: 1 });
    const dob = new TunnelDO(state.api, makeDoEnv());
    await state.restore;
    state.addSocket(deadTunnelSocket(), ["tunnel"]);
    state.addSocket(fakeTunnelSocket(captureSent(sent)), ["tunnel"]);

    void dob.fetch(new Request("https://do.internal/app.js"));
    expect(sent.length).toBe(1);
    expect(decodeFrame(sent[0]).type).toBe("open-http");
  });

  it("answers 503 offline when send() throws despite an open readyState", async () => {
    const state = mockDoState({ protocolVersion: 1 });
    const dob = new TunnelDO(state.api, makeDoEnv());
    await state.restore;
    state.addSocket(
      fakeTunnelSocket(() => {
        throw new TypeError("Can't call WebSocket send() after close().");
      }),
      ["tunnel"],
    );

    const res = await dob.fetch(new Request("https://do.internal/"));
    expect(res.status).toBe(503);
    expect(res.headers.get("x-bb-tunnel-offline")).toBe("1");
  });
});
