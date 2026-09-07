import { drizzle } from "drizzle-orm/d1";
import {
  RESERVED_HANDLES,
  handleAppLinkAssociationRequest,
  parseVisitorHost,
  schema,
} from "@bb/connect-db";
import { refreshAccountSessionCookies } from "./account-session.js";
import { TUNNEL_OFFLINE_HEADER, TunnelDO, type Env } from "./tunnel-do.js";
import {
  invalidateSessionCookie,
  sha256Hex,
  parseCookie,
  markMachineSeen,
  resolveLabel,
  verifyMachineCredentialDetails,
  verifySessionCookieDetails,
} from "./session.js";
import {
  handleCreateDesktopSession,
  handleDisconnectServer,
  handleListAccountServers,
  verifyDesktopSessionCookie,
} from "./servers.js";
import { serveWithCache } from "./cache.js";
import { BB_ICON_DATA_URI } from "./bb-icon.js";
import { handleAssignMachineLabel } from "./machine-label.js";
import {
  publicConnectOrigin,
  resolveConnectRequestHost,
  resolveConnectRequestUrl,
  resolveConnectRuntime,
  stripCloudDevHeader,
} from "./cloud-dev.js";
import {
  GATE_AUTH_HEADER,
  GATE_MACHINE_ID_HEADER,
  MACHINE_CREDENTIAL_HEADER,
  TUNNEL_TARGET_HEADER,
} from "./protocol-headers.js";

export { TunnelDO };

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function withSetCookies(
  response: Response,
  setCookies: readonly string[],
): Response {
  const headers = new Headers(response.headers);
  for (const setCookie of setCookies) headers.append("set-cookie", setCookie);
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

export function dashboardSignInUrl(appUrl: string, returnTo: string): string {
  const url = new URL("/dashboard", appUrl);
  url.searchParams.set("returnTo", returnTo);
  return url.toString();
}

const GATE_STYLE = `
  :root{--canvas:oklch(1 0 0);--ink:oklch(0.3211 0 0);
    --muted:color-mix(in oklch,var(--ink) 55%,var(--canvas));
    --subtle:color-mix(in oklch,var(--ink) 40%,var(--canvas));
    --border:color-mix(in oklch,var(--ink) 14%,var(--canvas));
    --card:color-mix(in oklch,var(--ink) 2%,var(--canvas));
    --warn:oklch(0.72 0.15 66);
    --warn-bg:color-mix(in oklch,var(--warn) 14%,var(--canvas));
    --warn-border:color-mix(in oklch,var(--warn) 38%,var(--canvas));}
  @media (prefers-color-scheme:dark){:root{--canvas:oklch(0.195 0 0);--ink:oklch(0.81 0 0)}}
  *{box-sizing:border-box}
  body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;
    background:var(--canvas);color:var(--ink);
    font:15px/1.6 "Inter",-apple-system,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
  .wrap{width:100%;max-width:420px;padding:24px}
  .brand{display:flex;align-items:center;gap:10px;margin-bottom:18px}
  .brand img{width:28px;height:28px}
  .brand b{font-weight:600;font-size:15px;letter-spacing:-.01em}
  .brand span{color:var(--muted);font-size:13px}
  .card{border:1px solid var(--border);background:var(--card);border-radius:12px;padding:22px 24px}
  h1{margin:0 0 4px;font-size:18px;font-weight:600;letter-spacing:-.01em}
  p{margin:0 0 16px;color:var(--muted);font-size:14px}
  p.note{color:var(--subtle);font-size:13px}
  code{font-family:"Fira Code",ui-monospace,monospace;font-size:.92em}
  .btn{display:flex;align-items:center;justify-content:center;width:100%;padding:11px 16px;
    border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--ink);
    font:500 14px/1 "Inter",-apple-system,system-ui,sans-serif;text-decoration:none;cursor:pointer}
  .btn.primary{background:var(--ink);border-color:var(--ink);color:var(--canvas)}
  .glyph{width:34px;height:34px;border-radius:999px;background:var(--warn-bg);
    border:1px solid var(--warn-border);color:var(--warn);
    display:flex;align-items:center;justify-content:center;margin-bottom:12px}
  .glyph svg{width:16px;height:16px;stroke:currentColor}
`;

function gatePage(
  cardBody: string,
  status: number,
  metaRefreshSeconds?: number,
): Response {
  const refresh =
    metaRefreshSeconds !== undefined
      ? `<meta http-equiv="refresh" content="${metaRefreshSeconds}">`
      : "";
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
     <meta name="viewport" content="width=device-width, initial-scale=1">
     ${refresh}<title>bb connect</title>
     <link rel="preconnect" href="https://fonts.googleapis.com">
     <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
     <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
     <style>${GATE_STYLE}</style></head>
     <body><div class="wrap">
       <div class="brand"><img src="${BB_ICON_DATA_URI}" alt="bb"><div><b>bb connect</b><br><span>Your bb, reachable anywhere</span></div></div>
       <div class="card">${cardBody}</div>
     </div></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function relativeTime(date: Date, now: number = Date.now()): string {
  const diffMs = Math.max(0, now - date.getTime());
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function wantsHtml(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/html");
}

function signInPage(label: string, appUrl: string, returnTo: string): Response {
  const host = new URL(appUrl).host;
  const signInUrl = dashboardSignInUrl(appUrl, returnTo);
  return gatePage(
    `<h1>This is <code>${escapeHtml(label)}</code>'s bb</h1>
     <p>Sign in with the account that owns this server to open it.</p>
     <a class="btn primary" href="${signInUrl}">Sign in at ${escapeHtml(host)}</a>`,
    401,
  );
}

export function offlinePage(
  lastSeenAt: Date | null,
  kind: "server" | "machine",
): Response {
  const heading =
    kind === "machine" ? "This machine is offline" : "Your bb is offline";
  const lastSeen = lastSeenAt
    ? kind === "machine"
      ? `This machine was last seen ${relativeTime(lastSeenAt)}. `
      : `Last seen ${relativeTime(lastSeenAt)}. `
    : "";
  const note =
    kind === "machine"
      ? "Usually this means the machine is asleep or bb isn't running on it."
      : "Usually this means the machine is asleep or bb isn't running.";
  return gatePage(
    `<div class="glyph"><svg viewBox="0 0 16 16" fill="none" stroke-width="1.5"><path d="M1.5 6.2a9.5 9.5 0 0 1 13 0M3.8 8.7a6 6 0 0 1 8.4 0M6.1 11.2a2.6 2.6 0 0 1 3.8 0" stroke-linecap="round"/><path d="M2 2l12 12" stroke-linecap="round"/><circle cx="8" cy="13.6" r="0.9" fill="currentColor" stroke="none"/></svg></div>
     <h1>${heading}</h1>
     <p>${lastSeen}This page retries automatically when it comes back.</p>
     <p class="note">${note}</p>
     <button class="btn" onclick="location.reload()">Retry now</button>`,
    503,
    10,
  );
}

function machinePage(
  label: string,
  accountHandle: string,
  runtime: ReturnType<typeof resolveConnectRuntime>,
): Response {
  const appOrigin = publicConnectOrigin(accountHandle, runtime);
  const appHost = new URL(appOrigin).host;
  const baseHost = new URL(runtime.accountAppUrl).host;
  return gatePage(
    `<h1><code>${escapeHtml(label)}</code> is a machine</h1>
     <p>This machine is on <code>${escapeHtml(accountHandle)}</code>'s account. Its shares appear at <code>${escapeHtml(label)}--&lt;port&gt;.${escapeHtml(baseHost)}</code>.</p>
     <a class="btn primary" href="${escapeHtml(appOrigin)}">Open the bb app at ${escapeHtml(appHost)}</a>`,
    200,
  );
}

export function requestForTunnelDo(
  request: Request,
  target: string | null,
  authKind?: "machine" | "session",
): Request {
  const headers = new Headers(request.headers);
  headers.delete(TUNNEL_TARGET_HEADER);
  headers.delete(MACHINE_CREDENTIAL_HEADER);
  headers.delete(GATE_AUTH_HEADER);
  headers.delete(GATE_MACHINE_ID_HEADER);
  stripCloudDevHeader(headers);
  if (target !== null) {
    headers.set(TUNNEL_TARGET_HEADER, target);
  }
  if (authKind !== undefined) {
    headers.set(GATE_AUTH_HEADER, authKind);
  }
  return new Request(request, { headers });
}

function isHostManagementMutation(request: Request, pathname: string): boolean {
  if (request.method === "POST" && pathname === "/internal/hosts/enroll-key") {
    return true;
  }
  if (request.method === "POST" && pathname === "/api/v1/hosts/join-codes") {
    return true;
  }
  if (
    request.method === "PATCH" &&
    /^\/api\/v1\/hosts\/[^/]+\/permission-ceiling$/u.test(pathname)
  ) {
    return true;
  }
  return (
    (request.method === "PATCH" || request.method === "DELETE") &&
    /^\/api\/v1\/hosts\/[^/]+$/u.test(pathname)
  );
}

export function cacheNamespace(
  routingKey: string,
  target: string | null,
): string {
  return target !== null ? `${routingKey}--${target}` : routingKey;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const runtime = resolveConnectRuntime(env);
    const url = resolveConnectRequestUrl(request.url, request.headers, runtime);
    if (url.pathname === "/api/connect/servers") {
      return handleListAccountServers(request, env);
    }
    if (url.pathname === "/api/connect/disconnect") {
      return handleDisconnectServer(request, env);
    }
    if (url.pathname === "/api/connect/desktop-session") {
      return handleCreateDesktopSession(request, env);
    }
    if (url.pathname === "/api/connect/machine-label") {
      return handleAssignMachineLabel(request, env);
    }
    const host = resolveConnectRequestHost(request.headers, runtime);
    const parsed = parseVisitorHost(host, env.BASE_DOMAIN);
    if (!parsed) return text("bb connect: unknown host\n", 404);
    if (parsed.target === null) {
      const appLinks = handleAppLinkAssociationRequest(
        { method: request.method, url: url.toString() },
        env,
      );
      if (appLinks) return appLinks;
    }
    const { handle: label, target } = parsed;
    if (RESERVED_HANDLES.has(label)) {
      return Response.redirect(
        `${runtime.accountAppUrl}${url.pathname}${url.search}`,
        301,
      );
    }

    const db = drizzle(env.DB, { schema });
    const isTunnelDial = url.pathname === "/__tunnel";
    const resolved = await resolveLabel(
      label,
      db,
      isTunnelDial ? { fresh: true } : undefined,
    );
    if (!resolved) return text(`bb connect: no server for "${label}"\n`, 404);

    const routingKey =
      resolved.kind === "machine" ? resolved.routingKey : label;
    const stub = env.TUNNEL_DO.get(env.TUNNEL_DO.idFromName(routingKey));

    if (url.pathname === "/__tunnel") {
      if (target !== null) return text("bb connect: not found\n", 404);
      const auth = request.headers.get("authorization") ?? "";
      const credential = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const owner =
        resolved.kind === "server" ? resolved.server : resolved.machine;
      if (owner.revokedAt != null || owner.credentialHash == null) {
        return text(
          resolved.kind === "server"
            ? "bb connect: server not paired\n"
            : "bb connect: machine not paired\n",
          403,
        );
      }
      if ((await sha256Hex(credential)) !== owner.credentialHash) {
        return text("bb connect: invalid credential\n", 401);
      }
      const forward = new URL(request.url);
      forward.searchParams.delete("serverId");
      forward.searchParams.delete("machineId");
      if (resolved.kind === "server") {
        forward.searchParams.set("serverId", owner.id);
      } else {
        forward.searchParams.set("machineId", owner.id);
      }
      const headers = new Headers(request.headers);
      stripCloudDevHeader(headers);
      return stub.fetch(
        new Request(new Request(forward, request), { headers }),
      );
    }

    if (url.pathname.startsWith("/__"))
      return text("bb connect: not found\n", 404);

    if (resolved.kind === "machine" && target === null) {
      return machinePage(label, resolved.accountHandle, runtime);
    }

    const isPublicInstallPath =
      url.pathname === "/install.sh" ||
      url.pathname === "/install/version" ||
      url.pathname === "/install/bb-app.tgz";
    if (request.method === "GET" && isPublicInstallPath) {
      if (target !== null) return text("bb connect: not found\n", 404);
      const headers = new Headers(request.headers);
      headers.delete(MACHINE_CREDENTIAL_HEADER);
      headers.delete(TUNNEL_TARGET_HEADER);
      headers.delete(GATE_AUTH_HEADER);
      headers.delete(GATE_MACHINE_ID_HEADER);
      stripCloudDevHeader(headers);
      return stub.fetch(new Request(request, { headers }));
    }

    const isMachinePath =
      url.pathname.startsWith("/internal") ||
      url.pathname === "/api/v1" ||
      url.pathname.startsWith("/api/v1/");
    if (target !== null && url.pathname.startsWith("/internal")) {
      return text("bb connect: not found\n", 404);
    }
    const presentedMachineCredential = request.headers.get(
      MACHINE_CREDENTIAL_HEADER,
    );
    if (isMachinePath && presentedMachineCredential !== null) {
      if (target !== null) return text("bb connect: not found\n", 404);
      const verified = await verifyMachineCredentialDetails(
        presentedMachineCredential,
        db,
      );
      if (verified == null || verified.userId !== resolved.userId) {
        return text("bb connect: machine not authorized\n", 403);
      }
      if (isHostManagementMutation(request, url.pathname)) {
        return text("bb connect: machine cannot manage hosts\n", 403);
      }
      ctx.waitUntil(markMachineSeen(verified.machineId, db));
      const headers = new Headers(request.headers);
      headers.delete(MACHINE_CREDENTIAL_HEADER);
      headers.delete(TUNNEL_TARGET_HEADER);
      headers.delete(GATE_AUTH_HEADER);
      headers.delete(GATE_MACHINE_ID_HEADER);
      stripCloudDevHeader(headers);
      headers.set(GATE_AUTH_HEADER, "machine");
      headers.set(GATE_MACHINE_ID_HEADER, verified.machineId);
      return stub.fetch(new Request(request, { headers }));
    }
    if (url.pathname.startsWith("/internal")) {
      return text("bb connect: machine not authorized\n", 403);
    }

    const cookieHeader = request.headers.get("cookie");
    const cookie = parseCookie(cookieHeader, runtime.sessionCookieName);
    const desktopCookie = parseCookie(
      cookieHeader,
      runtime.desktopSessionCookieName,
    );
    const appUrl = runtime.accountAppUrl;
    if (!cookie && !desktopCookie)
      return signInPage(label, appUrl, url.toString());
    const verifiedSession = cookie
      ? await verifySessionCookieDetails(cookie, env.BETTER_AUTH_SECRET, db)
      : null;
    const sessionUserId = verifiedSession?.userId ?? null;
    const desktopUserId = desktopCookie
      ? await verifyDesktopSessionCookie(desktopCookie, env.BETTER_AUTH_SECRET)
      : null;
    if (!sessionUserId && !desktopUserId) {
      return signInPage(label, appUrl, url.toString());
    }
    if (
      sessionUserId !== resolved.userId &&
      desktopUserId !== resolved.userId
    ) {
      return text("bb connect: not your server\n", 403);
    }

    const doRequest = requestForTunnelDo(request, target, "session");
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return stub.fetch(doRequest);
    }
    const cached = await serveWithCache(
      request,
      cacheNamespace(routingKey, target),
      ctx,
      (init) => {
        if (init === undefined) return stub.fetch(doRequest);
        const headers = new Headers(doRequest.headers);
        headers.set("if-none-match", init.ifNoneMatch);
        return stub.fetch(new Request(doRequest, { headers }));
      },
    );
    let response = cached.response;
    if (
      response.status === 503 &&
      response.headers.get(TUNNEL_OFFLINE_HEADER) === "1" &&
      wantsHtml(request)
    ) {
      response = offlinePage(
        resolved.kind === "server"
          ? resolved.server.lastSeenAt
          : resolved.machine.lastSeenAt,
        resolved.kind,
      );
    }

    if (
      !cached.cacheable &&
      cookie !== null &&
      sessionUserId === resolved.userId &&
      verifiedSession?.needsRefresh === true
    ) {
      invalidateSessionCookie(cookie);
      const setCookies = await refreshAccountSessionCookies(
        `${runtime.sessionCookieName}=${cookie}`,
        runtime.accountAppUrl,
        (authRequest) => fetch(authRequest),
      );
      if (setCookies !== null) return withSetCookies(response, setCookies);
    }
    return response;
  },
} satisfies ExportedHandler<Env>;
