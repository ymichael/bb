import { and, eq, gt, isNull } from "drizzle-orm";
import {
  CONNECT_SESSION_EXPIRES_IN_SECONDS,
  CONNECT_SESSION_UPDATE_AGE_SECONDS,
  type ConnectDb,
  labelClaim,
  machine,
  machineRoutingKey,
  profile,
  server,
  session,
} from "@bb/connect-db";

const LABEL_TTL_MS = 15_000;
const SESSION_TTL_MS = 20_000;
const SESSION_REFRESH_BEFORE_EXPIRY_MS =
  (CONNECT_SESSION_EXPIRES_IN_SECONDS - CONNECT_SESSION_UPDATE_AGE_SECONDS) *
  1000;

interface CacheEntry<T> {
  value: Promise<T>;
  expires: number;
}
const labelCache = new Map<string, CacheEntry<ResolvedLabel | null>>();

interface CachedSession {
  userId: string;
  expiresAt: number;
}

const sessionCache = new Map<string, CacheEntry<CachedSession | null>>();

export function invalidateSessionCookie(cookieValue: string): void {
  sessionCache.delete(safeDecode(cookieValue));
}

function cacheGet<T>(
  map: Map<string, CacheEntry<T>>,
  key: string,
  now: number,
): Promise<T> | undefined {
  const hit = map.get(key);
  if (hit && hit.expires > now) return hit.value;
  if (hit) map.delete(key);
  return undefined;
}

function cacheStore<T>(
  map: Map<string, CacheEntry<T>>,
  key: string,
  value: Promise<T>,
  expires: number,
  settledExpires?: (value: T) => number,
): Promise<T> {
  const entry: CacheEntry<T> = { value, expires };
  map.set(key, entry);
  value.then(
    (settled) => {
      if (settledExpires === undefined || map.get(key) !== entry) return;
      entry.expires = settledExpires(settled);
    },
    () => {
      if (map.get(key) === entry) map.delete(key);
    },
  );
  return value;
}

interface ResolvedServer {
  kind: "server";
  userId: string;
  server: {
    id: string;
    credentialHash: string | null;
    revokedAt: Date | null;
    lastSeenAt: Date | null;
  };
}

interface ResolvedMachine {
  kind: "machine";
  routingKey: string;
  userId: string;
  accountHandle: string;
  machine: {
    id: string;
    credentialHash: string;
    revokedAt: Date | null;
    lastSeenAt: Date | null;
  };
}

type ResolvedLabel = ResolvedServer | ResolvedMachine;

export async function resolveLabel(
  label: string,
  db: ConnectDb,
  options?: { fresh?: boolean },
): Promise<ResolvedLabel | null> {
  const now = Date.now();
  if (!options?.fresh) {
    const cached = cacheGet(labelCache, label, now);
    if (cached !== undefined) return cached;
  }
  return cacheStore(
    labelCache,
    label,
    lookupLabel(label, db),
    now + LABEL_TTL_MS,
  );
}

async function lookupLabel(
  label: string,
  db: ConnectDb,
): Promise<ResolvedLabel | null> {
  const serverRow = await db
    .select({
      userId: server.userId,
      serverId: server.id,
      credentialHash: server.credentialHash,
      revokedAt: server.revokedAt,
      lastSeenAt: server.lastSeenAt,
    })
    .from(server)
    .where(eq(server.subdomain, label))
    .get();
  if (serverRow) {
    return {
      kind: "server",
      userId: serverRow.userId,
      server: {
        id: serverRow.serverId,
        credentialHash: serverRow.credentialHash,
        revokedAt: serverRow.revokedAt,
        lastSeenAt: serverRow.lastSeenAt,
      },
    };
  }

  const machineRow = await db
    .select({
      userId: machine.userId,
      accountHandle: profile.handle,
      machineId: machine.id,
      credentialHash: machine.credentialHash,
      revokedAt: machine.revokedAt,
      lastSeenAt: machine.lastSeenAt,
      generation: labelClaim.generation,
    })
    .from(machine)
    .innerJoin(profile, eq(profile.userId, machine.userId))
    .innerJoin(
      labelClaim,
      and(
        eq(labelClaim.label, machine.subdomain),
        eq(labelClaim.kind, "machine"),
        eq(labelClaim.ownerId, machine.id),
      ),
    )
    .where(eq(machine.subdomain, label))
    .get();
  if (!machineRow) return null;
  return {
    kind: "machine",
    routingKey: machineRoutingKey(label, machineRow.generation),
    userId: machineRow.userId,
    accountHandle: machineRow.accountHandle,
    machine: {
      id: machineRow.machineId,
      credentialHash: machineRow.credentialHash,
      revokedAt: machineRow.revokedAt,
      lastSeenAt: machineRow.lastSeenAt,
    },
  };
}

export interface VerifiedSessionCookie {
  userId: string;
  needsRefresh: boolean;
}

function verifiedSession(
  session: CachedSession,
  now: number,
): VerifiedSessionCookie {
  return {
    userId: session.userId,
    needsRefresh: session.expiresAt <= now + SESSION_REFRESH_BEFORE_EXPIRY_MS,
  };
}

export async function verifySessionCookieDetails(
  cookieValue: string,
  secret: string,
  db: ConnectDb,
): Promise<VerifiedSessionCookie | null> {
  const decoded = safeDecode(cookieValue);
  const dot = decoded.lastIndexOf(".");
  if (dot <= 0) return null;

  const now = Date.now();
  const cached = cacheGet(sessionCache, decoded, now);
  const cachedSession =
    cached !== undefined
      ? await cached
      : await cacheStore(
          sessionCache,
          decoded,
          lookupCachedSession(
            decoded.slice(0, dot),
            decoded.slice(dot + 1),
            secret,
            db,
            now,
          ),
          now + SESSION_TTL_MS,
          (looked) =>
            looked === null
              ? now + SESSION_TTL_MS
              : Math.min(now + SESSION_TTL_MS, looked.expiresAt),
        );
  return cachedSession === null ? null : verifiedSession(cachedSession, now);
}

async function lookupCachedSession(
  token: string,
  providedSig: string,
  secret: string,
  db: ConnectDb,
  now: number,
): Promise<CachedSession | null> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(token),
  );
  const expectedSig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
  if (!constantTimeEqual(providedSig, expectedSig)) return null;

  const row = await db
    .select({ expiresAt: session.expiresAt, userId: session.userId })
    .from(session)
    .where(and(eq(session.token, token), gt(session.expiresAt, new Date(now))))
    .get();
  return row
    ? { userId: row.userId, expiresAt: row.expiresAt.getTime() }
    : null;
}

export async function verifySessionCookie(
  cookieValue: string,
  secret: string,
  db: ConnectDb,
): Promise<string | null> {
  return (
    (await verifySessionCookieDetails(cookieValue, secret, db))?.userId ?? null
  );
}

const machineLastSeenWrites = new Map<string, number>();
export const MACHINE_LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifyMachineCredential(
  credential: string,
  db: ConnectDb,
): Promise<string | null> {
  return (await verifyMachineCredentialDetails(credential, db))?.userId ?? null;
}

export async function verifyMachineCredentialDetails(
  credential: string,
  db: ConnectDb,
): Promise<{ machineId: string; userId: string } | null> {
  if (!credential) return null;
  const hash = await sha256Hex(credential);
  const row = await db
    .select({ machineId: machine.id, userId: machine.userId })
    .from(machine)
    .where(and(eq(machine.credentialHash, hash), isNull(machine.revokedAt)))
    .get();
  return row ?? null;
}

export async function markMachineSeen(
  machineId: string,
  db: ConnectDb,
  now: number = Date.now(),
): Promise<boolean> {
  const previous = machineLastSeenWrites.get(machineId);
  if (
    previous !== undefined &&
    now - previous < MACHINE_LAST_SEEN_WRITE_INTERVAL_MS
  ) {
    return false;
  }
  machineLastSeenWrites.set(machineId, now);
  await db
    .update(machine)
    .set({ lastSeenAt: new Date(now) })
    .where(and(eq(machine.id, machineId), isNull(machine.revokedAt)))
    .run();
  return true;
}

export function parseCookie(
  header: string | null,
  name: string,
): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
