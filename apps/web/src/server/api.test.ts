import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectCode,
  labelClaim,
  machine,
  MAX_PER_ACCOUNT,
  schema,
  server,
  user,
} from "@bb/connect-db";
import {
  type Deps,
  checkAvailability,
  claimHandle,
  createConnectCode,
  createMachineCodeForServerCredential,
  createServer,
  disconnectServer,
  removeServer,
  getAccountState,
  redeemConnectCode,
  redeemMachineCode,
  resolveServerUrlTemplate,
  revokeMachineForServerCredential,
  revokeMachine,
} from "./api.js";
import { sha256Hex } from "./tokens.js";

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../../packages/connect-db/migrations", import.meta.url),
);

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;
let closeTunnel: ReturnType<typeof vi.fn<(subdomain: string) => Promise<void>>>;
let deps: Deps;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    if (file.endsWith(".sql"))
      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  db = drizzle(sqlite, { schema });
  closeTunnel = vi.fn<(subdomain: string) => Promise<void>>(async () => {});
  deps = {
    db,
    appUrl: "https://getbb.app",
    serverUrlTemplate: "https://{label}.getbb.app",
    closeTunnel,
  };
});

describe("resolveServerUrlTemplate", () => {
  it("accepts the local HTTP port without changing production defaults", () => {
    expect(resolveServerUrlTemplate(undefined, "getbb.app")).toBe(
      "https://{label}.getbb.app",
    );
    expect(
      resolveServerUrlTemplate(
        "http://{label}.bb.localhost:8787",
        "bb.localhost",
      ),
    ).toBe("http://{label}.bb.localhost:8787");
    expect(() =>
      resolveServerUrlTemplate("https://example.com/{label}", "example.com"),
    ).toThrow("under BASE_DOMAIN");
    expect(() =>
      resolveServerUrlTemplate("https://{label}.attacker.example", "getbb.app"),
    ).toThrow("under BASE_DOMAIN");
  });
});

afterEach(() => {
  sqlite.close();
});

function seedUser(id: string, githubLogin?: string): void {
  const now = new Date();
  db.insert(user)
    .values({
      id,
      name: "Test",
      email: `${id}@example.com`,
      emailVerified: true,
      githubLogin: githubLogin ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

describe("claimHandle", () => {
  it("creates the profile and the primary server (subdomain = handle)", async () => {
    seedUser("u1");
    const r = await claimHandle(deps, "u1", "Sawyer");
    expect(r).toEqual({ ok: true, handle: "sawyer" });

    const rows = db.select().from(server).where(eq(server.userId, "u1")).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].subdomain).toBe("sawyer");
    expect(rows[0].name).toBe("default");
  });

  it("rejects reserved, malformed, and already-taken labels", async () => {
    seedUser("u1");
    seedUser("u2");
    expect(await claimHandle(deps, "u1", "admin")).toEqual({
      error: "reserved",
    });
    expect(await claimHandle(deps, "u1", "foo--bar")).toEqual({
      error: "invalid-format",
    });
    expect(await claimHandle(deps, "u1", "ab")).toEqual({ error: "too-short" });

    await claimHandle(deps, "u1", "sawyer");
    expect(await claimHandle(deps, "u2", "sawyer")).toEqual({ error: "taken" });
  });

  it("refuses a second claim for the same account", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    expect(await claimHandle(deps, "u1", "sawyer2")).toEqual({
      error: "already-claimed",
    });
  });
});

describe("checkAvailability", () => {
  it("reports free, invalid, and taken labels distinctly", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    expect(await checkAvailability(deps, "sawyer-desktop")).toEqual({
      available: true,
      label: "sawyer-desktop",
    });
    expect(await checkAvailability(deps, "admin")).toEqual({
      available: false,
      reason: "invalid",
      error: "reserved",
    });
    expect(await checkAvailability(deps, "sawyer")).toEqual({
      available: false,
      reason: "taken",
      namespace: "handle",
    });
  });
});

describe("createServer (connect another bb)", () => {
  it("claims a new label and holds it as an offline row", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const r = await createServer(deps, "u1", "sawyer-desktop");
    expect("ok" in r && r.ok).toBe(true);
    if ("ok" in r) {
      expect(r.server.subdomain).toBe("sawyer-desktop");
      expect(r.server.isPrimary).toBe(false);
      expect(r.server.connected).toBe(false);
      expect(r.server.serverUrl).toBe("https://sawyer-desktop.getbb.app");
    }
  });

  it("enforces the per-account server cap", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    for (let i = 1; i < MAX_PER_ACCOUNT; i++) {
      expect("ok" in (await createServer(deps, "u1", `sawyer-${i}`))).toBe(
        true,
      );
    }
    expect(
      db.select().from(server).where(eq(server.userId, "u1")).all(),
    ).toHaveLength(MAX_PER_ACCOUNT);
    expect(await createServer(deps, "u1", "sawyer-over")).toEqual({
      error: "server-limit",
    });
  });

  it("rejects a label already taken by another server", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    await createServer(deps, "u1", "sawyer-desktop");
    expect(await createServer(deps, "u1", "sawyer-desktop")).toEqual({
      error: "taken",
    });
  });
});

describe("createConnectCode (per-server minting + reuse)", () => {
  async function primaryId(userId: string): Promise<string> {
    const rows = db
      .select()
      .from(server)
      .where(eq(server.userId, userId))
      .all();
    return rows[0].id;
  }

  it("mints a server-pair code bound to the requested server", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const desktop = await createServer(deps, "u1", "sawyer-desktop");
    if (!("ok" in desktop)) throw new Error("setup");

    const r = await createConnectCode(deps, "u1", {
      serverId: desktop.server.id,
    });
    if ("error" in r) throw new Error(r.error);
    expect(r.serverUrl).toBe("https://sawyer-desktop.getbb.app");
    expect(r.serverId).toBe(desktop.server.id);

    const row = db
      .select()
      .from(connectCode)
      .where(eq(connectCode.code, r.code))
      .get();
    expect(row?.serverId).toBe(desktop.server.id);
    expect(row?.purpose).toBe("server-pair");
  });

  it("reuses an unexpired code instead of re-minting when reuse=true", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const id = await primaryId("u1");

    const first = await createConnectCode(deps, "u1", {
      serverId: id,
      reuse: true,
    });
    const second = await createConnectCode(deps, "u1", {
      serverId: id,
      reuse: true,
    });
    if ("error" in first || "error" in second) throw new Error("mint failed");
    expect(second.code).toBe(first.code);
    expect(db.select().from(connectCode).all()).toHaveLength(1);
  });

  it("mints a fresh code when reuse is not requested", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const id = await primaryId("u1");
    const first = await createConnectCode(deps, "u1", { serverId: id });
    const second = await createConnectCode(deps, "u1", { serverId: id });
    if ("error" in first || "error" in second) throw new Error("mint failed");
    expect(second.code).not.toBe(first.code);
    expect(db.select().from(connectCode).all()).toHaveLength(2);
  });
});

describe("redeemConnectCode (multi-server routing label)", () => {
  it("returns the redeemed server's subdomain, not the account handle", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const desktop = await createServer(deps, "u1", "sawyer-desktop");
    if (!("ok" in desktop)) throw new Error("setup");

    const primary = db
      .select()
      .from(server)
      .where(eq(server.subdomain, "sawyer"))
      .get();
    expect(primary?.credentialHash).toBeNull();

    const minted = await createConnectCode(deps, "u1", {
      serverId: desktop.server.id,
    });
    if ("error" in minted) throw new Error(minted.error);

    const result = await redeemConnectCode(deps, minted.code);
    if ("error" in result)
      throw new Error(`${result.error} (${result.status})`);

    expect(result.handle).toBe("sawyer-desktop");
    expect(result.serverId).toBe(desktop.server.id);
    expect(result.tunnelUrl).toBe("wss://sawyer-desktop.getbb.app/__tunnel");
    expect(result.credential.startsWith("bbcred_")).toBe(true);

    const second = db
      .select()
      .from(server)
      .where(eq(server.id, desktop.server.id))
      .get();
    expect(second?.credentialHash).toBe(await sha256Hex(result.credential));
    expect(second?.revokedAt).toBeNull();

    const primaryAfter = db
      .select()
      .from(server)
      .where(eq(server.subdomain, "sawyer"))
      .get();
    expect(primaryAfter?.credentialHash).toBeNull();
  });

  it("returns the primary handle when redeeming a primary-server code", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const primary = db
      .select()
      .from(server)
      .where(eq(server.subdomain, "sawyer"))
      .get();
    const minted = await createConnectCode(deps, "u1", {
      serverId: primary!.id,
    });
    if ("error" in minted) throw new Error(minted.error);

    const result = await redeemConnectCode(deps, minted.code);
    if ("error" in result)
      throw new Error(`${result.error} (${result.status})`);

    expect(result.handle).toBe("sawyer");
    expect(result.tunnelUrl).toBe("wss://sawyer.getbb.app/__tunnel");
  });

  it("returns a ws tunnel URL for local Cloud", async () => {
    deps.serverUrlTemplate = "http://{label}.bb.localhost:42745";
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const primary = db
      .select()
      .from(server)
      .where(eq(server.subdomain, "sawyer"))
      .get();
    const minted = await createConnectCode(deps, "u1", {
      serverId: primary!.id,
    });
    if ("error" in minted) throw new Error(minted.error);

    const result = await redeemConnectCode(deps, minted.code);
    if ("error" in result) throw new Error(result.error);
    expect(result.tunnelUrl).toBe("ws://sawyer.bb.localhost:42745/__tunnel");
  });
});

describe("disconnectServer (server-scoped)", () => {
  it("clears only the target server's credential and closes only its tunnel", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const desktop = await createServer(deps, "u1", "sawyer-desktop");
    if (!("ok" in desktop)) throw new Error("setup");

    db.update(server).set({ credentialHash: "hash", revokedAt: null }).run();

    const r = await disconnectServer(deps, "u1", desktop.server.id);
    expect(r).toEqual({ ok: true });
    expect(closeTunnel).toHaveBeenCalledTimes(1);
    expect(closeTunnel).toHaveBeenCalledWith("sawyer-desktop");

    const target = db
      .select()
      .from(server)
      .where(eq(server.id, desktop.server.id))
      .get();
    expect(target?.credentialHash).toBeNull();
    expect(target?.revokedAt).not.toBeNull();

    const primary = db
      .select()
      .from(server)
      .where(eq(server.subdomain, "sawyer"))
      .get();
    expect(primary?.credentialHash).toBe("hash");
    expect(primary?.revokedAt).toBeNull();
  });

  it("refuses a server the caller does not own", async () => {
    seedUser("u1");
    seedUser("u2");
    await claimHandle(deps, "u1", "sawyer");
    await claimHandle(deps, "u2", "other");
    const victim = db
      .select()
      .from(server)
      .where(eq(server.subdomain, "other"))
      .get();
    expect(await disconnectServer(deps, "u1", victim!.id)).toEqual({
      error: "not-found",
    });
    expect(closeTunnel).not.toHaveBeenCalled();
  });
});

describe("removeServer (delete a never-paired row)", () => {
  it("deletes a never-paired secondary and frees its subdomain for re-claim", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const desktop = await createServer(deps, "u1", "sawyer-desktop");
    if (!("ok" in desktop)) throw new Error("setup");

    expect(await removeServer(deps, "u1", desktop.server.id)).toEqual({
      ok: true,
    });
    expect(
      db.select().from(server).where(eq(server.id, desktop.server.id)).get(),
    ).toBeUndefined();

    const avail = await checkAvailability(deps, "sawyer-desktop");
    expect(avail.available).toBe(true);

    expect(
      db.select().from(server).where(eq(server.subdomain, "sawyer")).get(),
    ).toBeDefined();
  });

  it("refuses to remove the primary (account handle) row", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const primary = db
      .select()
      .from(server)
      .where(eq(server.subdomain, "sawyer"))
      .get();
    expect(await removeServer(deps, "u1", primary!.id)).toEqual({
      error: "is-primary",
    });
    expect(
      db.select().from(server).where(eq(server.id, primary!.id)).get(),
    ).toBeDefined();
  });

  it("refuses to remove a still-connected secondary (disconnect first)", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const desktop = await createServer(deps, "u1", "sawyer-desktop");
    if (!("ok" in desktop)) throw new Error("setup");
    db.update(server)
      .set({ credentialHash: "hash", revokedAt: null })
      .where(eq(server.id, desktop.server.id))
      .run();

    expect(await removeServer(deps, "u1", desktop.server.id)).toEqual({
      error: "connected",
    });
    expect(
      db.select().from(server).where(eq(server.id, desktop.server.id)).get(),
    ).toBeDefined();
  });

  it("refuses a server the caller does not own", async () => {
    seedUser("u1");
    seedUser("u2");
    await claimHandle(deps, "u1", "sawyer");
    await claimHandle(deps, "u2", "other");
    const victim = db
      .select()
      .from(server)
      .where(eq(server.subdomain, "other"))
      .get();
    expect(await removeServer(deps, "u1", victim!.id)).toEqual({
      error: "not-found",
    });
  });
});

describe("getAccountState (adaptive single / multi)", () => {
  it("returns an empty account before a handle is claimed", async () => {
    seedUser("u1", "sawyerhood");
    const state = await getAccountState(deps, "u1");
    expect(state.handle).toBeNull();
    expect(state.servers).toHaveLength(0);
    expect(state.githubLogin).toBe("sawyerhood");
    expect(state.maxServers).toBe(MAX_PER_ACCOUNT);
  });

  it("returns one server, flagged primary, after a claim", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const state = await getAccountState(deps, "u1");
    expect(state.servers).toHaveLength(1);
    expect(state.servers[0]).toMatchObject({
      subdomain: "sawyer",
      isPrimary: true,
      connected: false,
      online: false,
      serverUrl: "https://sawyer.getbb.app",
    });
  });

  it("lists multiple servers with the primary first", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    await createServer(deps, "u1", "sawyer-desktop");
    await createServer(deps, "u1", "sawyer-studio");

    const state = await getAccountState(deps, "u1");
    expect(state.servers.map((s) => s.subdomain)).toEqual([
      "sawyer",
      "sawyer-desktop",
      "sawyer-studio",
    ]);
    expect(state.servers[0].isPrimary).toBe(true);
    expect(state.servers.slice(1).every((s) => !s.isPrimary)).toBe(true);
  });

  it("marks a server online only when credentialed and freshly seen", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    db.update(server)
      .set({ credentialHash: "hash", revokedAt: null, lastSeenAt: new Date() })
      .run();
    const online = (await getAccountState(deps, "u1")).servers[0];
    expect(online.connected).toBe(true);
    expect(online.online).toBe(true);

    db.update(server)
      .set({ lastSeenAt: new Date(Date.now() - 10 * 60 * 1000) })
      .run();
    const stale = (await getAccountState(deps, "u1")).servers[0];
    expect(stale.connected).toBe(true);
    expect(stale.online).toBe(false);
  });
});

describe("server-authenticated machine-code round trip", () => {
  it("mints for the credential's exact server and redeems one durable bbcm_ token", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const target = await createServer(deps, "u1", "sawyer-desktop");
    if (!("ok" in target)) throw new Error("server setup failed");
    const serverCredential = "bbcred_server_owned";
    db.update(server)
      .set({
        credentialHash: await sha256Hex(serverCredential),
        revokedAt: null,
      })
      .where(eq(server.id, target.server.id))
      .run();

    const minted = await createMachineCodeForServerCredential(
      deps,
      serverCredential,
    );
    if ("status" in minted) throw new Error(minted.error);
    expect(minted.serverUrl).toBe("https://sawyer-desktop.getbb.app");

    const redeemed = await redeemMachineCode(deps, minted.code);
    if ("error" in redeemed) throw new Error(redeemed.error);
    expect(redeemed.credential.startsWith("bbcm_")).toBe(true);
    expect(redeemed.serverUrl).toBe("https://sawyer-desktop.getbb.app");
    expect(db.select().from(machine).all()).toHaveLength(1);
    await expect(
      revokeMachineForServerCredential(
        deps,
        serverCredential,
        redeemed.machineId,
      ),
    ).resolves.toEqual({ ok: true });
    expect(
      db.select().from(machine).where(eq(machine.id, redeemed.machineId)).get()
        ?.revokedAt,
    ).not.toBeNull();
    await expect(redeemMachineCode(deps, minted.code)).resolves.toMatchObject({
      error: "already-used",
      status: 409,
    });
  });

  it("rejects a bogus server credential", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    await expect(
      createMachineCodeForServerCredential(deps, "bbcred_bogus"),
    ).resolves.toEqual({ error: "unauthorized", status: 401 });
  });
});

describe("dashboard machine recovery", () => {
  it("lists active machines and revokes only the owner's selected credential", async () => {
    seedUser("u1");
    seedUser("u2");
    const now = new Date();
    db.insert(machine)
      .values([
        {
          id: "machine-owner",
          userId: "u1",
          name: "lost laptop",
          subdomain: "lost-laptop",
          credentialHash: "hash-owner",
          lastSeenAt: now,
          createdAt: now,
        },
        {
          id: "machine-other",
          userId: "u2",
          credentialHash: "hash-other",
          createdAt: now,
        },
      ])
      .run();
    db.update(labelClaim)
      .set({ generation: "lost-generation" })
      .where(eq(labelClaim.label, "lost-laptop"))
      .run();

    expect((await getAccountState(deps, "u1")).machines).toEqual([
      {
        id: "machine-owner",
        name: "lost laptop",
        subdomain: "lost-laptop",
        online: true,
        lastSeenAt: now.getTime(),
        createdAt: now.getTime(),
      },
    ]);
    await expect(revokeMachine(deps, "u1", "machine-other")).resolves.toEqual({
      error: "not-found",
    });
    await expect(revokeMachine(deps, "u1", "machine-owner")).resolves.toEqual({
      ok: true,
    });
    expect(closeTunnel).toHaveBeenCalledWith("lost-laptop:lost-generation");
    expect(closeTunnel).toHaveBeenCalledTimes(1);
    expect((await getAccountState(deps, "u1")).machines).toEqual([]);
    expect(
      db.select().from(machine).where(eq(machine.id, "machine-owner")).get()
        ?.subdomain,
    ).toBeNull();
    expect(
      db.select().from(machine).where(eq(machine.id, "machine-other")).get()
        ?.revokedAt,
    ).toBeNull();
  });

  it("marks a machine online only when freshly seen, offline when stale", async () => {
    seedUser("u1");
    const now = new Date();
    const stale = new Date(now.getTime() - 10 * 60_000);
    db.insert(machine)
      .values([
        {
          id: "machine-fresh",
          userId: "u1",
          subdomain: "fresh-machine",
          credentialHash: "hash-fresh",
          lastSeenAt: now,
          createdAt: new Date(now.getTime() - 2000),
        },
        {
          id: "machine-stale",
          userId: "u1",
          subdomain: "stale-machine",
          credentialHash: "hash-stale",
          lastSeenAt: stale,
          createdAt: new Date(now.getTime() - 1000),
        },
        {
          id: "machine-unlabeled",
          userId: "u1",
          credentialHash: "hash-unlabeled",
          createdAt: now,
        },
      ])
      .run();

    const machines = (await getAccountState(deps, "u1")).machines;
    expect(machines.map((m) => [m.id, m.subdomain, m.online])).toEqual([
      ["machine-fresh", "fresh-machine", true],
      ["machine-stale", "stale-machine", false],
      ["machine-unlabeled", null, false],
    ]);
  });

  it("keeps a revoked label pinned when tunnel close fails", async () => {
    seedUser("u1");
    seedUser("u2");
    const now = new Date();
    db.insert(machine)
      .values([
        {
          id: "machine-a",
          userId: "u1",
          subdomain: "shared-machine",
          credentialHash: "hash-a",
          createdAt: now,
        },
        {
          id: "machine-b",
          userId: "u2",
          credentialHash: "hash-b",
          createdAt: now,
        },
      ])
      .run();
    db.update(labelClaim)
      .set({ generation: "generation-a" })
      .where(eq(labelClaim.label, "shared-machine"))
      .run();
    closeTunnel.mockRejectedValueOnce(new Error("close unavailable"));

    await expect(revokeMachine(deps, "u1", "machine-a")).resolves.toEqual({
      error: "tunnel-close-failed",
    });
    expect(
      db.select().from(machine).where(eq(machine.id, "machine-a")).get()
        ?.subdomain,
    ).toBe("shared-machine");
    expect(() =>
      db
        .update(machine)
        .set({ subdomain: "shared-machine" })
        .where(eq(machine.id, "machine-b"))
        .run(),
    ).toThrow(/unique constraint/iu);
  });

  it("retries a failed machine close during the reachable account-state sweep", async () => {
    seedUser("u1");
    seedUser("u2");
    const now = new Date();
    db.insert(machine)
      .values([
        {
          id: "machine-retry",
          userId: "u1",
          subdomain: "retry-machine",
          credentialHash: "hash-a",
          createdAt: now,
        },
        {
          id: "machine-new",
          userId: "u2",
          credentialHash: "hash-b",
          createdAt: now,
        },
      ])
      .run();
    db.update(labelClaim)
      .set({ generation: "generation-a" })
      .where(eq(labelClaim.label, "retry-machine"))
      .run();
    closeTunnel.mockRejectedValueOnce(new Error("close unavailable"));

    await expect(revokeMachine(deps, "u1", "machine-retry")).resolves.toEqual({
      error: "tunnel-close-failed",
    });
    expect(closeTunnel).toHaveBeenCalledTimes(1);
    await getAccountState(deps, "u1");
    expect(closeTunnel).toHaveBeenCalledTimes(2);
    expect(
      db
        .select()
        .from(labelClaim)
        .where(eq(labelClaim.label, "retry-machine"))
        .get(),
    ).toBeUndefined();
    expect(() =>
      db
        .update(machine)
        .set({ subdomain: "retry-machine" })
        .where(eq(machine.id, "machine-new"))
        .run(),
    ).not.toThrow();
  });

  it("does not release a label until delayed close confirms, then gives the new owner a new generation", async () => {
    seedUser("u1");
    seedUser("u2");
    const now = new Date();
    db.insert(machine)
      .values([
        {
          id: "machine-a",
          userId: "u1",
          subdomain: "shared-machine",
          credentialHash: "hash-a",
          createdAt: now,
        },
        {
          id: "machine-b",
          userId: "u2",
          credentialHash: "hash-b",
          createdAt: now,
        },
      ])
      .run();
    db.update(labelClaim)
      .set({ generation: "generation-a" })
      .where(eq(labelClaim.label, "shared-machine"))
      .run();
    let confirmClose: (() => void) | undefined;
    closeTunnel.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          confirmClose = resolve;
        }),
    );

    const revocation = revokeMachine(deps, "u1", "machine-a");
    await vi.waitFor(() => expect(closeTunnel).toHaveBeenCalledTimes(1));
    expect(() =>
      db
        .update(machine)
        .set({ subdomain: "shared-machine" })
        .where(eq(machine.id, "machine-b"))
        .run(),
    ).toThrow(/unique constraint/iu);

    confirmClose?.();
    await expect(revocation).resolves.toEqual({ ok: true });
    expect(() =>
      db
        .update(machine)
        .set({ subdomain: "shared-machine" })
        .where(eq(machine.id, "machine-b"))
        .run(),
    ).not.toThrow();
    expect(db.select().from(labelClaim).get()).toMatchObject({
      ownerId: "machine-b",
      generation: expect.stringMatching(/^[a-f0-9]{32}$/u),
    });
  });
});
