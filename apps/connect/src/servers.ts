import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  SERVER_OFFLINE_AFTER_MS,
  schema,
  server,
  type ConnectDb,
} from "@bb/connect-db";
import {
  parseCookie,
  sha256Hex,
  verifyMachineCredential,
  verifySessionCookie,
} from "./session.js";
import { resolveConnectRuntime } from "./cloud-dev.js";
import { MACHINE_CREDENTIAL_HEADER } from "./protocol-headers.js";
import type { Env } from "./tunnel-do.js";

const DESKTOP_SESSION_TTL_MS = 60 * 60 * 1000;

function bytesToBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function stringToBase64Url(value: string): string {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

function base64UrlToString(value: string): string | null {
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    return new TextDecoder().decode(
      Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)),
    );
  } catch {
    return null;
  }
}

async function signDesktopSessionPayload(
  payload: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function createDesktopSessionCookie(
  userId: string,
  secret: string,
  expiresAt: number,
): Promise<string> {
  const payload = stringToBase64Url(JSON.stringify({ expiresAt, userId }));
  return `${payload}.${await signDesktopSessionPayload(payload, secret)}`;
}

export async function verifyDesktopSessionCookie(
  cookieValue: string,
  secret: string,
  now: number = Date.now(),
): Promise<string | null> {
  const dot = cookieValue.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = cookieValue.slice(0, dot);
  const signature = cookieValue.slice(dot + 1);
  const expected = await signDesktopSessionPayload(payload, secret);
  if (signature.length !== expected.length) return null;
  let mismatch = 0;
  for (let index = 0; index < signature.length; index += 1) {
    mismatch |= signature.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  if (mismatch !== 0) return null;

  const decoded = base64UrlToString(payload);
  if (decoded === null) return null;
  try {
    const value: unknown = JSON.parse(decoded);
    if (
      typeof value !== "object" ||
      value === null ||
      !("userId" in value) ||
      typeof value.userId !== "string" ||
      !("expiresAt" in value) ||
      typeof value.expiresAt !== "number" ||
      value.expiresAt <= now
    ) {
      return null;
    }
    return value.userId;
  } catch {
    return null;
  }
}

const serverCredentialCache = new Map<
  string,
  { value: string | null; expires: number }
>();
const SERVER_CRED_TTL_MS = 20_000;

export async function verifyServerCredential(
  credential: string,
  db: ConnectDb,
): Promise<string | null> {
  if (!credential) return null;
  const now = Date.now();
  const cached = serverCredentialCache.get(credential);
  if (cached && cached.expires > now) return cached.value;
  if (cached) serverCredentialCache.delete(credential);

  const hash = await sha256Hex(credential);
  const row = await db
    .select({ userId: server.userId })
    .from(server)
    .where(and(eq(server.credentialHash, hash), isNull(server.revokedAt)))
    .get();
  const userId = row?.userId ?? null;
  serverCredentialCache.set(credential, {
    value: userId,
    expires: now + SERVER_CRED_TTL_MS,
  });
  return userId;
}

export async function revokeServerCredential(
  credential: string,
  db: ConnectDb,
): Promise<{ subdomain: string } | null> {
  const presented = credential.trim();
  if (!presented) return null;

  const revoked = await db
    .update(server)
    .set({ credentialHash: null, revokedAt: new Date() })
    .where(
      and(
        eq(server.credentialHash, await sha256Hex(presented)),
        isNull(server.revokedAt),
      ),
    )
    .returning({ subdomain: server.subdomain })
    .get();
  serverCredentialCache.delete(presented);
  return revoked ?? null;
}

export async function resolveAccountUserId(
  request: Request,
  secret: string,
  db: ConnectDb,
  sessionCookieName: string,
): Promise<string | null> {
  const presented = request.headers.get(MACHINE_CREDENTIAL_HEADER) ?? "";
  if (presented) {
    const machineUserId = await verifyMachineCredential(presented, db);
    if (machineUserId) return machineUserId;
    const serverUserId = await verifyServerCredential(presented, db);
    if (serverUserId) return serverUserId;
  }

  const cookie = parseCookie(request.headers.get("cookie"), sessionCookieName);
  if (!cookie) return null;
  return verifySessionCookie(cookie, secret, db);
}

interface AccountServerListing {
  handle: string;
  name: string;
  live: boolean;
}

export async function listAccountServers(
  db: ConnectDb,
  userId: string,
  now: number = Date.now(),
): Promise<AccountServerListing[]> {
  const rows = await db
    .select({
      subdomain: server.subdomain,
      name: server.name,
      lastSeenAt: server.lastSeenAt,
      credentialHash: server.credentialHash,
      revokedAt: server.revokedAt,
    })
    .from(server)
    .where(eq(server.userId, userId))
    .all();

  return rows.map((row) => {
    const handle = row.subdomain;
    const trimmed = row.name.trim();
    const name = trimmed.length > 0 ? trimmed : handle;
    const connected = row.credentialHash != null && row.revokedAt == null;
    const lastSeenMs = row.lastSeenAt?.getTime() ?? null;
    const live =
      connected &&
      lastSeenMs != null &&
      now - lastSeenMs < SERVER_OFFLINE_AFTER_MS;
    return { handle, name, live };
  });
}

export async function handleListAccountServers(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: {
        "content-type": "application/json; charset=utf-8",
        allow: "GET",
      },
    });
  }

  const db = drizzle(env.DB, { schema });
  const runtime = resolveConnectRuntime(env);
  const userId = await resolveAccountUserId(
    request,
    env.BETTER_AUTH_SECRET,
    db,
    runtime.sessionCookieName,
  );
  if (!userId) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  const servers = await listAccountServers(db, userId);
  return new Response(JSON.stringify({ servers }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function handleDisconnectServer(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: {
        "content-type": "application/json; charset=utf-8",
        allow: "POST",
      },
    });
  }

  const db = drizzle(env.DB, { schema });
  const credential = request.headers.get(MACHINE_CREDENTIAL_HEADER) ?? "";
  const revoked = await revokeServerCredential(credential, db);
  if (!revoked) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  try {
    const stub = env.TUNNEL_DO.get(env.TUNNEL_DO.idFromName(revoked.subdomain));
    await stub.fetch("https://tunnel/__control/close");
  } catch {}
  return Response.json({ ok: true });
}

export async function handleCreateDesktopSession(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: {
        "content-type": "application/json; charset=utf-8",
        allow: "POST",
      },
    });
  }
  const db = drizzle(env.DB, { schema });
  const runtime = resolveConnectRuntime(env);
  const userId = await resolveAccountUserId(
    request,
    env.BETTER_AUTH_SECRET,
    db,
    runtime.sessionCookieName,
  );
  if (!userId) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  const expiresAt = Date.now() + DESKTOP_SESSION_TTL_MS;
  const value = await createDesktopSessionCookie(
    userId,
    env.BETTER_AUTH_SECRET,
    expiresAt,
  );
  return new Response(
    JSON.stringify({
      cookie: {
        domain: `.${env.BASE_DOMAIN}`,
        expiresAt,
        name: runtime.desktopSessionCookieName,
        value,
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );
}
