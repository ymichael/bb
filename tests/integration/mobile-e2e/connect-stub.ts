import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";

const DEFAULT_GATE_PORT = 42998;
const DEFAULT_CONTROL_PORT = 42997;
const DEFAULT_UPSTREAM_PORT = 41999;
const DEFAULT_CODE = "STUB-PAIR";
const DEFAULT_HANDLE = "stub";
const OTHER_HANDLE = "other";
const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;
const DESKTOP_SESSION_COOKIE = "__Secure-bb-connect.desktop_session";
const MACHINE_CREDENTIAL_HEADER = "x-bb-connect-machine";
const GATE_AUTH_HEADER = "x-bb-gate-auth";
const GATE_MACHINE_ID_HEADER = "x-bb-gate-machine-id";

function readPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return parsed;
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return parsed;
}

const gatePort = readPort("BB_MOBILE_E2E_GATE_PORT", DEFAULT_GATE_PORT);
const controlPort = readPort(
  "BB_MOBILE_E2E_STUB_CONTROL_PORT",
  DEFAULT_CONTROL_PORT,
);
const upstreamUrl = new URL(
  process.env.BB_MOBILE_E2E_UPSTREAM_URL ??
    `http://127.0.0.1:${readPort("BB_MOBILE_E2E_PORT", DEFAULT_UPSTREAM_PORT)}`,
);
if (upstreamUrl.protocol !== "http:") {
  throw new Error("BB_MOBILE_E2E_UPSTREAM_URL must be http://");
}
const upstreamHost = upstreamUrl.hostname;
const upstreamPort = Number.parseInt(upstreamUrl.port, 10) || 80;
const handle = (process.env.BB_MOBILE_E2E_STUB_HANDLE ?? DEFAULT_HANDLE)
  .trim()
  .toLowerCase();
if (!/^[a-z0-9-]+$/u.test(handle)) {
  throw new Error(`Invalid BB_MOBILE_E2E_STUB_HANDLE: ${handle}`);
}
const pairingCode = (process.env.BB_MOBILE_E2E_CONNECT_CODE ?? DEFAULT_CODE)
  .trim()
  .toUpperCase();
const sessionTtlMs = readPositiveInt(
  "BB_MOBILE_E2E_SESSION_TTL_MS",
  DEFAULT_SESSION_TTL_MS,
);
const certDir =
  process.env.BB_MOBILE_E2E_STUB_CERT_DIR ??
  path.join(os.homedir(), ".bb-mobile-e2e", "connect-stub-certs");

const apexUrl = `https://localhost:${gatePort}`;
const serverUrl = `https://${handle}.localhost:${gatePort}`;
const otherServerUrl = `https://${OTHER_HANDLE}.localhost:${gatePort}`;
const cookieDomain = process.env.BB_MOBILE_E2E_COOKIE_DOMAIN ?? ".localhost";

interface TlsMaterial {
  key: Buffer;
  cert: Buffer;
  caPath: string;
}

function ensureCertificates(): TlsMaterial {
  mkdirSync(certDir, { recursive: true });
  const caKey = path.join(certDir, "ca.key");
  const caPem = path.join(certDir, "ca.pem");
  const leafKey = path.join(certDir, "leaf.key");
  const leafPem = path.join(certDir, "leaf.pem");
  const sanFile = path.join(certDir, "leaf.san");
  const sans = [
    "DNS:localhost",
    `DNS:${handle}.localhost`,
    `DNS:${OTHER_HANDLE}.localhost`,
    "DNS:*.localhost",
    "IP:127.0.0.1",
    "IP:::1",
  ].join(",");

  const openssl = (args: string[]): void => {
    execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });
  };

  if (!existsSync(caKey) || !existsSync(caPem)) {
    process.stderr.write(`connect-stub: generating CA in ${certDir}\n`);
    openssl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      caKey,
      "-out",
      caPem,
      "-days",
      "3650",
      "-subj",
      "/CN=bb mobile e2e connect stub CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    ]);
  }
  const sanStale =
    !existsSync(sanFile) || readFileSync(sanFile, "utf8") !== sans;
  if (!existsSync(leafKey) || !existsSync(leafPem) || sanStale) {
    process.stderr.write(
      `connect-stub: issuing leaf certificate for ${sans}\n`,
    );
    const csr = path.join(certDir, "leaf.csr");
    const ext = path.join(certDir, "leaf.ext");
    writeFileSync(
      ext,
      [
        `subjectAltName=${sans}`,
        "basicConstraints=CA:FALSE",
        "keyUsage=digitalSignature,keyEncipherment",
        "extendedKeyUsage=serverAuth",
        "",
      ].join("\n"),
    );
    openssl([
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      leafKey,
      "-out",
      csr,
      "-subj",
      "/CN=localhost",
    ]);
    openssl([
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      caPem,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-out",
      leafPem,
      "-days",
      "825",
      "-extfile",
      ext,
    ]);
    writeFileSync(sanFile, sans);
  }
  return {
    key: readFileSync(leafKey),
    cert: readFileSync(leafPem),
    caPath: caPem,
  };
}

function installRootCertificate(simulator: string, caPath: string): void {
  try {
    execFileSync(
      "xcrun",
      ["simctl", "keychain", simulator, "add-root-cert", caPath],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    process.stderr.write(
      `connect-stub: root certificate installed in simulator ${simulator}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `connect-stub: could not install the root certificate in ${simulator}: ${String(error)}\n`,
    );
  }
}

interface Machine {
  id: string;
  credential: string;
  createdAt: number;
  revokedAt: number | null;
}

interface Session {
  value: string;
  machineId: string;
  expiresAt: number;
  invalidatedAt: number | null;
}

const machines = new Map<string, Machine>();
const sessions = new Map<string, Session>();
const liveSockets = new Set<Duplex>();
const counters = {
  redeems: 0,
  desktopSessions: 0,
  listServers: 0,
  proxiedRequests: 0,
  proxiedUpgrades: 0,
  unauthenticatedRequests: 0,
  unauthenticatedUpgrades: 0,
};

function now(): number {
  return Date.now();
}

const verbose = process.env.BB_MOBILE_E2E_STUB_LOG === "1";

function trace(line: string): void {
  if (verbose) process.stderr.write(`connect-stub: ${line}\n`);
}

function describeCookies(header: string | undefined): string {
  if (!header) return "no cookie";
  const names = header
    .split(";")
    .map((part) => part.trim().split("=")[0] ?? "")
    .filter((name) => name.length > 0);
  return `cookies ${names.join(",")}`;
}

function activeMachine(credential: string | null): Machine | null {
  if (!credential) return null;
  const machine = machines.get(credential);
  return machine && machine.revokedAt === null ? machine : null;
}

function activeSession(value: string | null): Session | null {
  if (!value) return null;
  const session = sessions.get(value);
  if (!session || session.invalidatedAt !== null) return null;
  if (session.expiresAt <= now()) return null;
  const machine = Array.from(machines.values()).find(
    (candidate) => candidate.id === session.machineId,
  );
  return machine && machine.revokedAt === null ? session : null;
}

function closeLiveSockets(): number {
  const count = liveSockets.size;
  for (const socket of liveSockets) socket.destroy();
  liveSockets.clear();
  return count;
}

function expireSessions(): number {
  let count = 0;
  for (const session of sessions.values()) {
    if (session.invalidatedAt === null) {
      session.invalidatedAt = now();
      count += 1;
    }
  }
  return count;
}

function revokeMachines(): number {
  let count = 0;
  for (const machine of machines.values()) {
    if (machine.revokedAt === null) {
      machine.revokedAt = now();
      count += 1;
    }
  }
  return count;
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (rawName === name) return rest.join("=");
  }
  return null;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function signInPage(label: string, url: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sign in · ${label}</title></head><body><h1>Sign in to bb connect</h1><p>You need a session to reach <code>${label}</code>.</p><p><a href="${apexUrl}/dashboard?returnTo=${encodeURIComponent(url)}">Sign in</a></p></body></html>`;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function isMachinePath(pathname: string): boolean {
  return (
    pathname.startsWith("/internal") ||
    pathname === "/api/v1" ||
    pathname.startsWith("/api/v1/")
  );
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function upstreamHeaders(
  req: http.IncomingMessage,
  auth: "session" | "machine",
  machineId: string | null,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  const publicOrigin = `https://${headerValue(req.headers.host) ?? ""}`;
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (
      lower === "host" ||
      lower === MACHINE_CREDENTIAL_HEADER ||
      lower === GATE_AUTH_HEADER ||
      lower === GATE_MACHINE_ID_HEADER
    ) {
      continue;
    }
    headers[name] =
      lower === "origin" && value === publicOrigin ? upstreamUrl.origin : value;
  }
  headers.host = `${upstreamHost}:${upstreamPort}`;
  headers[GATE_AUTH_HEADER] = auth;
  if (machineId) headers[GATE_MACHINE_ID_HEADER] = machineId;
  return headers;
}

async function handleRedeemMachine(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method !== "POST")
    return json(res, 405, { error: "method_not_allowed" });
  let code = "";
  try {
    const body: unknown = JSON.parse((await readBody(req)) || "{}");
    if (typeof body === "object" && body !== null && "code" in body) {
      const raw = (body as { code?: unknown }).code;
      code = typeof raw === "string" ? raw.trim().toUpperCase() : "";
    }
  } catch {
    return json(res, 400, { error: "invalid-json" });
  }
  counters.redeems += 1;
  if (!code) return json(res, 400, { error: "missing-code" });
  if (code === "EXPIRED-CODE") return json(res, 410, { error: "expired" });
  if (code === "USED-CODE") return json(res, 409, { error: "already-used" });
  if (code === "LIMIT-CODE") return json(res, 409, { error: "machine-limit" });
  if (code !== pairingCode) return json(res, 404, { error: "invalid-code" });
  const machine: Machine = {
    id: randomUUID(),
    credential: `bbcm_${randomBytes(24).toString("base64url")}`,
    createdAt: now(),
    revokedAt: null,
  };
  machines.set(machine.credential, machine);
  process.stderr.write(
    `connect-stub: redeemed ${code} → machine ${machine.id}\n`,
  );
  return json(res, 200, {
    credential: machine.credential,
    machineId: machine.id,
    handle,
    serverUrl,
  });
}

function handleDesktopSession(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  if (req.method !== "POST")
    return json(res, 405, { error: "method_not_allowed" });
  counters.desktopSessions += 1;
  const machine = activeMachine(
    headerValue(req.headers[MACHINE_CREDENTIAL_HEADER]),
  );
  if (!machine) return json(res, 401, { error: "unauthorized" });
  const session: Session = {
    value: `${randomBytes(18).toString("base64url")}.${randomBytes(16).toString("base64url")}`,
    machineId: machine.id,
    expiresAt: now() + sessionTtlMs,
    invalidatedAt: null,
  };
  sessions.set(session.value, session);
  process.stderr.write(
    `connect-stub: desktop session minted for machine ${machine.id} (expires in ${sessionTtlMs}ms)\n`,
  );
  return json(res, 200, {
    cookie: {
      domain: cookieDomain,
      expiresAt: session.expiresAt,
      name: DESKTOP_SESSION_COOKIE,
      value: session.value,
    },
  });
}

function handleListServers(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  if (req.method !== "GET")
    return json(res, 405, { error: "method_not_allowed" });
  counters.listServers += 1;
  const machine = activeMachine(
    headerValue(req.headers[MACHINE_CREDENTIAL_HEADER]),
  );
  if (!machine) return json(res, 401, { error: "unauthorized" });
  return json(res, 200, {
    servers: [
      { handle, name: "Stub server", live: true },
      { handle: OTHER_HANDLE, name: "Other stub server", live: false },
    ],
  });
}

function handleControl(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): void {
  if (pathname === "/__stub/state" && req.method === "GET") {
    return json(res, 200, {
      apexUrl,
      serverUrl,
      otherServerUrl,
      upstreamUrl: upstreamUrl.origin,
      pairingCode,
      machines: Array.from(machines.values()).map((machine) => ({
        id: machine.id,
        createdAt: machine.createdAt,
        revokedAt: machine.revokedAt,
      })),
      sessions: Array.from(sessions.values()).map((session) => ({
        machineId: session.machineId,
        expiresAt: session.expiresAt,
        invalidatedAt: session.invalidatedAt,
      })),
      liveSockets: liveSockets.size,
      counters,
    });
  }
  if (req.method !== "POST")
    return json(res, 405, { error: "method_not_allowed" });
  if (pathname === "/__stub/expire-session") {
    const expired = expireSessions();
    const closed = closeLiveSockets();
    process.stderr.write(
      `connect-stub: expired ${expired} session(s), closed ${closed} socket(s)\n`,
    );
    return json(res, 200, { ok: true, expired, closed });
  }
  if (pathname === "/__stub/revoke-machine") {
    const revoked = revokeMachines();
    const expired = expireSessions();
    const closed = closeLiveSockets();
    process.stderr.write(
      `connect-stub: revoked ${revoked} machine(s), expired ${expired} session(s), closed ${closed} socket(s)\n`,
    );
    return json(res, 200, { ok: true, revoked, expired, closed });
  }
  if (pathname === "/__stub/reset") {
    const closed = closeLiveSockets();
    machines.clear();
    sessions.clear();
    process.stderr.write(`connect-stub: reset (closed ${closed} socket(s))\n`);
    return json(res, 200, { ok: true, closed });
  }
  return json(res, 404, { error: "not_found" });
}

function proxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  auth: "session" | "machine",
  machineId: string | null,
): void {
  counters.proxiedRequests += 1;
  const upstream = http.request(
    {
      host: upstreamHost,
      port: upstreamPort,
      method: req.method,
      path: req.url,
      headers: upstreamHeaders(req, auth, machineId),
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", (error) => {
    process.stderr.write(`connect-stub: upstream error ${String(error)}\n`);
    if (!res.headersSent) {
      res.writeHead(503, { "content-type": "text/plain" });
    }
    res.end("bb connect: server offline\n");
  });
  req.pipe(upstream);
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(
    req.url ?? "/",
    `https://${req.headers.host ?? "localhost"}`,
  );
  const pathname = url.pathname;
  if (pathname === "/api/connect/redeem-machine") {
    return handleRedeemMachine(req, res);
  }
  if (pathname === "/api/connect/desktop-session") {
    return handleDesktopSession(req, res);
  }
  if (pathname === "/api/connect/servers") return handleListServers(req, res);
  if (pathname.startsWith("/__stub/")) return handleControl(req, res, pathname);
  if (pathname.startsWith("/__")) {
    res.writeHead(404, { "content-type": "text/plain" });
    return void res.end("bb connect: not found\n");
  }

  const presented = headerValue(req.headers[MACHINE_CREDENTIAL_HEADER]);
  if (isMachinePath(pathname) && presented !== null) {
    const machine = activeMachine(presented);
    if (!machine) {
      res.writeHead(403, { "content-type": "text/plain" });
      return void res.end("bb connect: machine not authorized\n");
    }
    return proxyRequest(req, res, "machine", machine.id);
  }
  if (pathname.startsWith("/internal")) {
    res.writeHead(403, { "content-type": "text/plain" });
    return void res.end("bb connect: machine not authorized\n");
  }

  const cookieHeader = headerValue(req.headers.cookie) ?? undefined;
  const session = activeSession(
    parseCookie(cookieHeader, DESKTOP_SESSION_COOKIE),
  );
  trace(
    `${req.method ?? "GET"} ${url.host}${pathname} (${describeCookies(cookieHeader)}) → ${session ? "proxy" : "401 sign-in"}`,
  );
  if (!session) {
    counters.unauthenticatedRequests += 1;
    res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
    return void res.end(signInPage(url.host, url.toString()));
  }
  return proxyRequest(req, res, "session", null);
}

function handleUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  const url = new URL(
    req.url ?? "/",
    `https://${req.headers.host ?? "localhost"}`,
  );
  const cookieHeader = headerValue(req.headers.cookie) ?? undefined;
  const session = activeSession(
    parseCookie(cookieHeader, DESKTOP_SESSION_COOKIE),
  );
  trace(
    `UPGRADE ${url.host}${url.pathname} (${describeCookies(cookieHeader)}) → ${session ? "proxy" : "401 sign-in"}`,
  );
  if (!session) {
    counters.unauthenticatedUpgrades += 1;
    const body = signInPage(url.host, url.toString());
    socket.end(
      [
        "HTTP/1.1 401 Unauthorized",
        "content-type: text/html; charset=utf-8",
        `content-length: ${Buffer.byteLength(body)}`,
        "connection: close",
        "",
        body,
      ].join("\r\n"),
    );
    return;
  }
  counters.proxiedUpgrades += 1;
  const upstream = net.connect(upstreamPort, upstreamHost, () => {
    const headers = upstreamHeaders(req, "session", null);
    const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`];
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue;
      for (const entry of Array.isArray(value) ? value : [String(value)]) {
        lines.push(`${name}: ${entry}`);
      }
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    upstream.once("data", (chunk: Buffer) => {
      trace(
        `UPGRADE ${url.pathname} upstream answered: ${chunk.toString("latin1").split("\r\n", 1)[0] ?? ""}`,
      );
    });
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  liveSockets.add(socket);
  const cleanup = (): void => {
    liveSockets.delete(socket);
    upstream.destroy();
    socket.destroy();
  };
  upstream.on("error", cleanup);
  upstream.on("close", cleanup);
  socket.on("error", cleanup);
  socket.on("close", cleanup);
}

function main(): void {
  const tls = ensureCertificates();
  const simulator = process.env.BB_MOBILE_E2E_SIMULATOR;
  if (simulator) installRootCertificate(simulator, tls.caPath);

  const listeners: https.Server[] = [];
  for (const host of ["127.0.0.1", "::1"]) {
    const server = https.createServer(
      { key: tls.key, cert: tls.cert },
      (req, res) => {
        handleRequest(req, res).catch((error: unknown) => {
          process.stderr.write(
            `connect-stub: handler error ${String(error)}\n`,
          );
          if (!res.headersSent) json(res, 500, { error: "internal" });
          else res.end();
        });
      },
    );
    server.on("upgrade", handleUpgrade);
    server.on("error", (error) => {
      process.stderr.write(
        `connect-stub: listen error on ${host}: ${String(error)}\n`,
      );
      process.exit(1);
    });
    server.listen(gatePort, host);
    listeners.push(server);
  }

  const control = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname.startsWith("/__stub/"))
      return handleControl(req, res, pathname);
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("bb connect stub: control port only answers /__stub/*\n");
  });
  control.on("error", (error) => {
    process.stderr.write(
      `connect-stub: control listen error on ${controlPort}: ${String(error)}\n`,
    );
    process.exit(1);
  });
  control.listen(controlPort, "127.0.0.1");

  const shutdown = (signal: string): void => {
    process.stderr.write(`connect-stub: ${signal}, shutting down\n`);
    closeLiveSockets();
    for (const server of listeners) server.close();
    control.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const details = {
    apexUrl,
    serverUrl,
    otherServerUrl,
    handle,
    pairingCode,
    upstreamUrl: upstreamUrl.origin,
    controlUrl: `http://127.0.0.1:${controlPort}`,
    caPath: tls.caPath,
    installRootCert: `xcrun simctl keychain booted add-root-cert ${tls.caPath}`,
  };
  process.stdout.write(`${JSON.stringify(details)}\n`);
  process.stderr.write(
    `mobile-e2e connect stub ready: apex ${apexUrl}, gate ${serverUrl} → ${upstreamUrl.origin} (code ${pairingCode}; control http://127.0.0.1:${controlPort}/__stub/*; Ctrl-C to stop)\n` +
      `  trust the CA in a simulator once: ${details.installRootCert}\n`,
  );
}

main();
