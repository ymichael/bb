import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SERVER_OFFLINE_AFTER_MS,
  labelClaim,
  machine,
  profile,
  schema,
  server,
  session,
  user,
} from "@bb/connect-db";

import {
  createDesktopSessionCookie,
  listAccountServers,
  resolveAccountUserId,
  revokeServerCredential,
  verifyDesktopSessionCookie,
  verifyServerCredential,
} from "./servers.js";
import {
  assignMachineLabel,
  assignMachineLabelForCredential,
  sanitizeMachineLabelBase,
} from "./machine-label.js";
import { SECURE_SESSION_COOKIE } from "./cloud-dev.js";
import { verifyMachineCredential } from "./session.js";

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../packages/connect-db/migrations", import.meta.url),
);

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    if (!file.endsWith(".sql")) continue;
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  db = drizzle(sqlite, { schema });
});

afterEach(() => {
  sqlite.close();
  vi.restoreAllMocks();
});

const now = new Date("2026-07-01T12:00:00.000Z");

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function seedUser(id: string): void {
  db.insert(user)
    .values({
      id,
      name: id,
      email: `${id}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function seedServer(over: {
  id: string;
  userId: string;
  name: string;
  subdomain: string;
  credentialHash?: string | null;
  revokedAt?: Date | null;
  lastSeenAt?: Date | null;
}): void {
  db.insert(server)
    .values({
      id: over.id,
      userId: over.userId,
      name: over.name,
      subdomain: over.subdomain,
      credentialHash: "credentialHash" in over ? over.credentialHash : "hash",
      revokedAt: over.revokedAt ?? null,
      lastSeenAt: over.lastSeenAt ?? null,
      createdAt: now,
    })
    .run();
}

describe("desktop session cookie", () => {
  it("round-trips account identity until expiry and rejects tampering", async () => {
    const expiresAt = now.getTime() + 60_000;
    const cookie = await createDesktopSessionCookie(
      "acct-a",
      "test-secret",
      expiresAt,
    );
    await expect(
      verifyDesktopSessionCookie(cookie, "test-secret", now.getTime()),
    ).resolves.toBe("acct-a");
    await expect(
      verifyDesktopSessionCookie(cookie, "test-secret", expiresAt),
    ).resolves.toBeNull();
    await expect(
      verifyDesktopSessionCookie(
        `${cookie.slice(0, -1)}x`,
        "test-secret",
        now.getTime(),
      ),
    ).resolves.toBeNull();
  });
});

describe("listAccountServers", () => {
  it("returns only the authenticated account's rows with live from last_seen_at", async () => {
    seedUser("acct-a");
    seedUser("acct-b");
    const liveAt = new Date(now.getTime() - 30_000);
    const staleAt = new Date(now.getTime() - SERVER_OFFLINE_AFTER_MS - 1_000);

    seedServer({
      id: "s1",
      userId: "acct-a",
      name: "default",
      subdomain: "sawyer",
      lastSeenAt: liveAt,
    });
    seedServer({
      id: "s2",
      userId: "acct-a",
      name: "desktop",
      subdomain: "sawyer-desktop",
      lastSeenAt: staleAt,
    });
    seedServer({
      id: "s3",
      userId: "acct-b",
      name: "default",
      subdomain: "other",
      lastSeenAt: liveAt,
    });

    const listed = await listAccountServers(db, "acct-a", now.getTime());
    expect(listed).toEqual(
      expect.arrayContaining([
        { handle: "sawyer", name: "default", live: true },
        { handle: "sawyer-desktop", name: "desktop", live: false },
      ]),
    );
    expect(listed).toHaveLength(2);
    expect(listed.find((s) => s.handle === "other")).toBeUndefined();
  });

  it("falls back name to handle and treats unpaired/revoked as not live", async () => {
    seedUser("acct-a");
    seedServer({
      id: "s1",
      userId: "acct-a",
      name: "   ",
      subdomain: "empty-name",
      credentialHash: "hash",
      lastSeenAt: now,
    });
    seedServer({
      id: "s2",
      userId: "acct-a",
      name: "revoked",
      subdomain: "revoked-box",
      credentialHash: "hash",
      revokedAt: now,
      lastSeenAt: now,
    });
    seedServer({
      id: "s3",
      userId: "acct-a",
      name: "never",
      subdomain: "never-paired",
      credentialHash: null,
      lastSeenAt: null,
    });

    const listed = await listAccountServers(db, "acct-a", now.getTime());
    expect(listed).toEqual(
      expect.arrayContaining([
        { handle: "empty-name", name: "empty-name", live: true },
        { handle: "revoked-box", name: "revoked", live: false },
        { handle: "never-paired", name: "never", live: false },
      ]),
    );
  });
});

describe("verifyServerCredential / resolveAccountUserId", () => {
  it("authenticates a non-revoked server tunnel credential to its owner", async () => {
    seedUser("acct-a");
    const plaintext = "bbcred_server_secret";
    seedServer({
      id: "s1",
      userId: "acct-a",
      name: "default",
      subdomain: "sawyer",
      credentialHash: await sha256Hex(plaintext),
    });

    expect(await verifyServerCredential(plaintext, db)).toBe("acct-a");
    expect(await verifyServerCredential("wrong", db)).toBeNull();
  });

  it("revokes only the row authenticated by the presenting server", async () => {
    seedUser("acct-a");
    const plaintext = "bbcred_revoke_this_server";
    seedServer({
      id: "s1",
      userId: "acct-a",
      name: "default",
      subdomain: "sawyer",
      credentialHash: await sha256Hex(plaintext),
    });
    seedServer({
      id: "s2",
      userId: "acct-a",
      name: "desktop",
      subdomain: "sawyer-desktop",
      credentialHash: await sha256Hex("bbcred_keep_this_server"),
    });

    expect(await verifyServerCredential(plaintext, db)).toBe("acct-a");
    await expect(revokeServerCredential(plaintext, db)).resolves.toEqual({
      subdomain: "sawyer",
    });

    const rows = await db
      .select({
        id: server.id,
        credentialHash: server.credentialHash,
        revokedAt: server.revokedAt,
      })
      .from(server)
      .all();
    expect(rows.find((row) => row.id === "s1")).toMatchObject({
      credentialHash: null,
      revokedAt: expect.any(Date),
    });
    expect(rows.find((row) => row.id === "s2")).toMatchObject({
      credentialHash: await sha256Hex("bbcred_keep_this_server"),
      revokedAt: null,
    });
    await expect(verifyServerCredential(plaintext, db)).resolves.toBeNull();
    await expect(revokeServerCredential(plaintext, db)).resolves.toBeNull();
  });

  it("authenticates a machine credential and isolates cross-account rows", async () => {
    seedUser("acct-a");
    seedUser("acct-b");
    const machinePlain = "bbcm_machine_a";
    db.insert(machine)
      .values({
        id: "m1",
        userId: "acct-a",
        name: "laptop",
        credentialHash: await sha256Hex(machinePlain),
        createdAt: now,
        revokedAt: null,
      })
      .run();
    seedServer({
      id: "s-a",
      userId: "acct-a",
      name: "default",
      subdomain: "sawyer",
      lastSeenAt: now,
    });
    seedServer({
      id: "s-b",
      userId: "acct-b",
      name: "default",
      subdomain: "other",
      lastSeenAt: now,
    });

    expect(await verifyMachineCredential(machinePlain, db)).toBe("acct-a");

    const req = new Request("https://sawyer.getbb.app/api/connect/servers", {
      headers: { "x-bb-connect-machine": machinePlain },
    });
    const userId = await resolveAccountUserId(
      req,
      "secret",
      db,
      SECURE_SESSION_COOKIE,
    );
    expect(userId).toBe("acct-a");
    const listed = await listAccountServers(db, userId!, now.getTime());
    expect(listed.map((s) => s.handle)).toEqual(["sawyer"]);
  });

  it("returns null (unauthorized) when no credential or session is presented", async () => {
    const req = new Request("https://sawyer.getbb.app/api/connect/servers");
    expect(
      await resolveAccountUserId(req, "secret", db, SECURE_SESSION_COOKIE),
    ).toBeNull();
  });

  it("accepts a valid owner session cookie", async () => {
    seedUser("acct-a");
    const token = "sess_token_abc";
    const secret = "test-better-auth-secret";
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
    const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
    const cookieValue = `${token}.${sig}`;

    db.insert(session)
      .values({
        id: "sess1",
        token,
        expiresAt: new Date(Date.now() + 60_000),
        userId: "acct-a",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const req = new Request("https://sawyer.getbb.app/api/connect/servers", {
      headers: {
        cookie: `__Secure-better-auth.session_token=${cookieValue}`,
      },
    });
    expect(
      await resolveAccountUserId(req, secret, db, SECURE_SESSION_COOKIE),
    ).toBe("acct-a");

    const localRequest = new Request(
      "http://sawyer.bb.localhost:8787/api/connect/servers",
      {
        headers: { cookie: `better-auth.session_token=${cookieValue}` },
      },
    );
    expect(
      await resolveAccountUserId(
        localRequest,
        secret,
        db,
        "better-auth.session_token",
      ),
    ).toBe("acct-a");
  });
});

describe("machine label assignment", () => {
  it("sanitizes a host name, suffixes across every namespace, and is idempotent", async () => {
    seedUser("acct-a");
    db.insert(profile)
      .values({ userId: "acct-a", handle: "sawyer-air", createdAt: now })
      .run();
    seedServer({
      id: "s2",
      userId: "acct-a",
      name: "second",
      subdomain: "sawyer-air-2",
    });
    db.insert(machine)
      .values([
        {
          id: "machine-existing",
          userId: "acct-a",
          subdomain: "sawyer-air-3",
          credentialHash: "existing-hash",
          createdAt: now,
        },
        {
          id: "machine-new",
          userId: "acct-a",
          credentialHash: "new-hash",
          createdAt: now,
        },
      ])
      .run();
    expect(sanitizeMachineLabelBase("  Sawyer Air!!!  ", "machine-new")).toBe(
      "sawyer-air",
    );
    await expect(
      assignMachineLabel(db, "machine-new", "  Sawyer Air!!!  "),
    ).resolves.toBe("sawyer-air-4");
    await expect(
      assignMachineLabel(db, "machine-new", "a totally different name"),
    ).resolves.toBe("sawyer-air-4");
  });

  it("uses machine-<id-prefix> when the desired name is empty or invalid", async () => {
    seedUser("acct-a");
    db.insert(machine)
      .values({
        id: "ABC-12345-rest",
        userId: "acct-a",
        credentialHash: "hash",
        createdAt: now,
      })
      .run();

    expect(sanitizeMachineLabelBase("", "ABC-12345-rest")).toBe(
      "machine-abc12345",
    );
    await expect(
      assignMachineLabel(db, "ABC-12345-rest", "admin"),
    ).resolves.toBe("machine-abc12345");
  });

  it("authenticates the assigning machine and refuses revoked credentials", async () => {
    seedUser("acct-a");
    const credential = "bbcm_assigning_machine";
    db.insert(machine)
      .values({
        id: "machine-auth",
        userId: "acct-a",
        credentialHash: await sha256Hex(credential),
        createdAt: now,
      })
      .run();

    await expect(
      assignMachineLabelForCredential(db, credential, "Sawyer Air"),
    ).resolves.toBe("sawyer-air");
    db.update(machine)
      .set({ revokedAt: now, subdomain: null })
      .where(eq(machine.id, "machine-auth"))
      .run();
    await expect(
      assignMachineLabelForCredential(db, credential, "Sawyer Air"),
    ).resolves.toBeNull();
  });

  it("keeps concurrent assignments on one atomic global claim", async () => {
    seedUser("acct-a");
    db.insert(machine)
      .values([
        {
          id: "machine-a",
          userId: "acct-a",
          credentialHash: "a",
          createdAt: now,
        },
        {
          id: "machine-b",
          userId: "acct-a",
          credentialHash: "b",
          createdAt: now,
        },
      ])
      .run();

    const [a, b] = await Promise.all([
      assignMachineLabel(db, "machine-a", "Shared Name"),
      assignMachineLabel(db, "machine-b", "Shared Name"),
    ]);
    expect(new Set([a, b])).toEqual(new Set(["shared-name", "shared-name-2"]));
    expect(db.select().from(labelClaim).all()).toHaveLength(2);
  });

  it("loses cleanly when revocation crosses the pre-attach barrier", async () => {
    seedUser("acct-a");
    db.insert(machine)
      .values({
        id: "machine-race",
        userId: "acct-a",
        credentialHash: "hash",
        createdAt: now,
      })
      .run();
    let releaseBarrier: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let attachReached: (() => void) | undefined;
    const attaching = new Promise<void>((resolve) => {
      attachReached = resolve;
    });
    const assignment = assignMachineLabel(db, "machine-race", "Race Box", {
      beforeAttach: async () => {
        attachReached?.();
        await barrier;
      },
    });

    await attaching;
    db.update(machine)
      .set({ revokedAt: now })
      .where(eq(machine.id, "machine-race"))
      .run();
    releaseBarrier?.();

    await expect(assignment).resolves.toBeNull();
    expect(
      db.select().from(machine).where(eq(machine.id, "machine-race")).get()
        ?.subdomain,
    ).toBeNull();
    expect(db.select().from(labelClaim).all()).toEqual([]);
  });

  it("has no pause-after-claim gap against a claim-ignorant server writer", async () => {
    seedUser("acct-a");
    seedUser("acct-b");
    db.insert(machine)
      .values({
        id: "machine-atomic",
        userId: "acct-a",
        credentialHash: "hash",
        createdAt: now,
      })
      .run();
    let resumeAttach: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      resumeAttach = resolve;
    });
    let attachReached: (() => void) | undefined;
    const attaching = new Promise<void>((resolve) => {
      attachReached = resolve;
    });
    let paused = false;
    const assignment = assignMachineLabel(
      db,
      "machine-atomic",
      "Shared Atomic",
      {
        beforeAttach: async (candidate) => {
          if (candidate !== "shared-atomic" || paused) return;
          paused = true;
          attachReached?.();
          await barrier;
        },
      },
    );

    await attaching;
    expect(db.select().from(labelClaim).all()).toEqual([]);
    seedServer({
      id: "old-writer-server",
      userId: "acct-b",
      name: "default",
      subdomain: "shared-atomic",
      credentialHash: null,
    });
    resumeAttach?.();

    await expect(assignment).resolves.toBe("shared-atomic-2");
    expect(
      db.select().from(server).where(eq(server.id, "old-writer-server")).get()
        ?.subdomain,
    ).toBe("shared-atomic");
    expect(
      db.select().from(machine).where(eq(machine.id, "machine-atomic")).get()
        ?.subdomain,
    ).toBe("shared-atomic-2");
    expect(
      db
        .select({ label: labelClaim.label })
        .from(labelClaim)
        .orderBy(labelClaim.label)
        .all(),
    ).toEqual([{ label: "shared-atomic" }, { label: "shared-atomic-2" }]);
  });
});
