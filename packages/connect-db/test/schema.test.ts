import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONNECT_CODE_TTL_MS,
  checkLabelAvailability,
  connectCode,
  labelClaim,
  machine,
  parseVisitorHost,
  profile,
  schema,
  server,
  user,
  validateHandle,
  validateSubdomain,
} from "../src/index.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));
const LABEL_CLAIM_TRIGGERS = [
  "machine_label_claim_delete",
  "machine_label_claim_insert",
  "machine_label_claim_update",
  "profile_label_claim_delete",
  "profile_label_claim_insert",
  "profile_label_claim_update",
  "server_label_claim_delete",
  "server_label_claim_insert",
  "server_label_claim_update",
] as const;

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function applyMigration(sqlite: Database.Database, file: string): void {
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
}

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
});

function seedUser(id = "u1"): void {
  const now = new Date();
  db.insert(user)
    .values({
      id,
      name: "Test",
      email: `${id}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

describe("migration matches the drizzle schema", () => {
  it("drizzle inserts/reads round-trip against the hand-written DDL", () => {
    seedUser();
    const now = new Date();
    db.insert(profile)
      .values({ userId: "u1", handle: "sawyer", createdAt: now })
      .run();
    db.insert(server)
      .values({
        id: "s1",
        userId: "u1",
        name: "default",
        subdomain: "sawyer",
        createdAt: now,
      })
      .run();

    const rows = db.select().from(server).where(eq(server.userId, "u1")).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("default");
    expect(rows[0].subdomain).toBe("sawyer");
    expect(rows[0].lastSeenAt).toBeNull();
    expect(rows[0].revokedAt).toBeNull();

    db.insert(machine)
      .values({
        id: "m1",
        userId: "u1",
        name: "laptop",
        subdomain: "sawyer-air",
        credentialHash: "machine-hash",
        createdAt: now,
      })
      .run();
    expect(db.select().from(machine).get()?.subdomain).toBe("sawyer-air");

    const p = db
      .select()
      .from(profile)
      .where(eq(profile.handle, "sawyer"))
      .get();
    expect(p?.userId).toBe("u1");
  });

  it("stores the github login on user (nullable for pre-migration rows)", () => {
    seedUser("u1");
    expect(
      db.select().from(user).where(eq(user.id, "u1")).get()?.githubLogin,
    ).toBeNull();

    db.update(user)
      .set({ githubLogin: "sawyerhood" })
      .where(eq(user.id, "u1"))
      .run();
    expect(
      db.select().from(user).where(eq(user.id, "u1")).get()?.githubLogin,
    ).toBe("sawyerhood");
  });

  it("atomically rejects claim-ignorant cross-namespace source writes", () => {
    seedUser("u1");
    seedUser("u2");
    const createdAt = new Date();
    db.insert(profile)
      .values({ userId: "u1", handle: "shared-label", createdAt })
      .run();
    expect(() =>
      db
        .insert(server)
        .values({
          id: "claim-ignorant-server",
          userId: "u2",
          name: "default",
          subdomain: "shared-label",
          createdAt,
        })
        .run(),
    ).toThrow(/unique constraint/iu);
    db.insert(machine)
      .values({
        id: "claim-ignorant-machine",
        userId: "u2",
        credentialHash: "hash",
        createdAt,
      })
      .run();
    expect(() =>
      db
        .update(machine)
        .set({ subdomain: "shared-label" })
        .where(eq(machine.id, "claim-ignorant-machine"))
        .run(),
    ).toThrow(/unique constraint/iu);
    expect(
      db
        .select()
        .from(labelClaim)
        .where(eq(labelClaim.label, "shared-label"))
        .all(),
    ).toHaveLength(1);
    expect(
      db
        .select()
        .from(server)
        .where(eq(server.id, "claim-ignorant-server"))
        .get(),
    ).toBeUndefined();
    expect(
      db
        .select()
        .from(machine)
        .where(eq(machine.id, "claim-ignorant-machine"))
        .get()?.subdomain,
    ).toBeNull();
  });

  it("rolls back claim-ignorant profile and server updates on global collisions", () => {
    seedUser("u1");
    seedUser("u2");
    const createdAt = Date.now();
    sqlite
      .prepare(
        "INSERT INTO profile (user_id, handle, created_at) VALUES (?, ?, ?)",
      )
      .run("u1", "owner-one", createdAt);
    sqlite
      .prepare(
        "INSERT INTO profile (user_id, handle, created_at) VALUES (?, ?, ?)",
      )
      .run("u2", "owner-two", createdAt);

    sqlite
      .prepare(
        "INSERT INTO server (id, user_id, name, subdomain, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("primary-one", "u1", "default", "owner-one", createdAt);
    sqlite
      .prepare(
        "INSERT INTO server (id, user_id, name, subdomain, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("secondary-two", "u2", "desktop", "server-two", createdAt);
    expect(
      sqlite
        .prepare("SELECT kind, owner_id FROM label_claim WHERE label = ?")
        .get("owner-one"),
    ).toEqual({ kind: "handle", owner_id: "u1" });

    expect(() =>
      sqlite
        .prepare("UPDATE profile SET handle = ? WHERE user_id = ?")
        .run("server-two", "u1"),
    ).toThrow(/unique constraint/iu);
    expect(() =>
      sqlite
        .prepare("UPDATE server SET subdomain = ? WHERE id = ?")
        .run("owner-one", "secondary-two"),
    ).toThrow(/unique constraint/iu);

    expect(
      sqlite.prepare("SELECT handle FROM profile WHERE user_id = ?").get("u1"),
    ).toEqual({ handle: "owner-one" });
    expect(
      sqlite
        .prepare("SELECT subdomain FROM server WHERE id = ?")
        .get("secondary-two"),
    ).toEqual({ subdomain: "server-two" });
    expect(
      sqlite
        .prepare(
          "SELECT label, kind FROM label_claim WHERE label IN (?, ?) ORDER BY label",
        )
        .all("owner-one", "server-two"),
    ).toEqual([
      { label: "owner-one", kind: "handle" },
      { label: "server-two", kind: "server" },
    ]);
  });
});

describe("constraints", () => {
  it("enforces unique handles", () => {
    seedUser("u1");
    seedUser("u2");
    const now = new Date();
    db.insert(profile)
      .values({ userId: "u1", handle: "taken", createdAt: now })
      .run();
    expect(() =>
      db
        .insert(profile)
        .values({ userId: "u2", handle: "taken", createdAt: now })
        .run(),
    ).toThrow(/UNIQUE/i);
  });

  it("allows nullable machine labels and enforces uniqueness when assigned", () => {
    seedUser("u1");
    const now = new Date();
    db.insert(machine)
      .values([
        {
          id: "m1",
          userId: "u1",
          subdomain: "sawyer-air",
          credentialHash: "h1",
          createdAt: now,
        },
        {
          id: "m2",
          userId: "u1",
          subdomain: null,
          credentialHash: "h2",
          createdAt: now,
        },
      ])
      .run();
    expect(() =>
      db
        .insert(machine)
        .values({
          id: "m3",
          userId: "u1",
          subdomain: "sawyer-air",
          credentialHash: "h3",
          createdAt: now,
        })
        .run(),
    ).toThrow(/UNIQUE/iu);
  });

  it("enforces one server name per user but allows the same name across users", () => {
    seedUser("u1");
    seedUser("u2");
    const now = new Date();
    db.insert(server)
      .values({
        id: "s1",
        userId: "u1",
        name: "default",
        subdomain: "u1-default",
        createdAt: now,
      })
      .run();
    expect(() =>
      db
        .insert(server)
        .values({
          id: "s2",
          userId: "u1",
          name: "default",
          subdomain: "u1-second",
          createdAt: now,
        })
        .run(),
    ).toThrow(/UNIQUE/i);
    expect(() =>
      db
        .insert(server)
        .values({
          id: "s3",
          userId: "u2",
          name: "default",
          subdomain: "u2-default",
          createdAt: now,
        })
        .run(),
    ).not.toThrow();
  });

  it("enforces globally-unique subdomains across servers", () => {
    seedUser("u1");
    seedUser("u2");
    const now = new Date();
    db.insert(server)
      .values({
        id: "s1",
        userId: "u1",
        name: "default",
        subdomain: "taken",
        createdAt: now,
      })
      .run();
    expect(() =>
      db
        .insert(server)
        .values({
          id: "s2",
          userId: "u2",
          name: "laptop",
          subdomain: "taken",
          createdAt: now,
        })
        .run(),
    ).toThrow(/UNIQUE/i);
  });

  it("lets one account own several servers, each with its own subdomain", () => {
    seedUser("u1");
    const now = new Date();
    db.insert(profile)
      .values({ userId: "u1", handle: "sawyer", createdAt: now })
      .run();
    db.insert(server)
      .values({
        id: "s1",
        userId: "u1",
        name: "default",
        subdomain: "sawyer",
        createdAt: now,
      })
      .run();
    expect(() =>
      db
        .insert(server)
        .values({
          id: "s2",
          userId: "u1",
          name: "desktop",
          subdomain: "sawyer-desktop",
          createdAt: now,
        })
        .run(),
    ).not.toThrow();
    expect(
      db.select().from(server).where(eq(server.userId, "u1")).all(),
    ).toHaveLength(2);
  });

  it("cascades connect codes and servers when a user is deleted", () => {
    seedUser();
    const now = new Date();
    db.insert(profile)
      .values({ userId: "u1", handle: "sawyer", createdAt: now })
      .run();
    db.insert(server)
      .values({
        id: "s1",
        userId: "u1",
        name: "default",
        subdomain: "sawyer",
        createdAt: now,
      })
      .run();
    db.insert(connectCode)
      .values({
        code: "abc",
        userId: "u1",
        serverId: "s1",
        purpose: "server-pair",
        expiresAt: new Date(now.getTime() + CONNECT_CODE_TTL_MS),
        createdAt: now,
      })
      .run();

    db.delete(user).where(eq(user.id, "u1")).run();
    expect(db.select().from(profile).all()).toHaveLength(0);
    expect(db.select().from(server).all()).toHaveLength(0);
    expect(db.select().from(connectCode).all()).toHaveLength(0);
    expect(db.select().from(labelClaim).all()).toHaveLength(0);
  });

  it("marks a connect code consumed exactly once (single-use redemption)", () => {
    seedUser();
    const now = new Date();
    db.insert(connectCode)
      .values({
        code: "one-time",
        userId: "u1",
        purpose: "manual-pair",
        expiresAt: new Date(now.getTime() + CONNECT_CODE_TTL_MS),
        createdAt: now,
      })
      .run();

    const redeem = () =>
      db
        .update(connectCode)
        .set({ consumedAt: new Date() })
        .where(
          and(eq(connectCode.code, "one-time"), isNull(connectCode.consumedAt)),
        )
        .run();

    const first = redeem();
    expect(first.changes).toBe(1);
    const second = redeem();
    expect(second.changes).toBe(0);
  });
});

describe("validateHandle", () => {
  it("accepts well-formed handles", () => {
    for (const h of ["sawyer", "abc", "a1b2", "my-server", "x".repeat(30)]) {
      expect(validateHandle(h)).toBeNull();
    }
  });

  it("rejects malformed and reserved handles", () => {
    expect(validateHandle("ab")).toBe("too-short");
    expect(validateHandle("x".repeat(31))).toBe("too-long");
    expect(validateHandle("-lead")).toBe("invalid-format");
    expect(validateHandle("Upper")).toBe("invalid-format");
    expect(validateHandle("has space")).toBe("invalid-format");
    expect(validateHandle("has_underscore")).toBe("invalid-format");
    expect(validateHandle("foo--bar")).toBe("invalid-format");
    expect(validateHandle("a--b")).toBe("invalid-format");
    for (const h of [
      "api",
      "www",
      "docs",
      "admin",
      "oauth",
      "origin",
      "production",
    ]) {
      expect(validateHandle(h)).toBe("reserved");
    }
  });
});

describe("parseVisitorHost", () => {
  it("extracts a bare handle", () => {
    expect(parseVisitorHost("sawyer.getbb.app", "getbb.app")).toEqual({
      handle: "sawyer",
      target: null,
    });
    expect(parseVisitorHost("Sawyer.getbb.app", "getbb.app")).toEqual({
      handle: "sawyer",
      target: null,
    });
  });

  it("extracts handle--port share hosts", () => {
    expect(parseVisitorHost("sawyer--8000.getbb.app", "getbb.app")).toEqual({
      handle: "sawyer",
      target: "8000",
    });
    expect(parseVisitorHost("Sawyer--5173.getbb.app", "getbb.app")).toEqual({
      handle: "sawyer",
      target: "5173",
    });
  });

  it("rejects invalid share targets as unroutable", () => {
    expect(parseVisitorHost("sawyer--0.getbb.app", "getbb.app")).toBeNull();
    expect(parseVisitorHost("sawyer--99999.getbb.app", "getbb.app")).toBeNull();
    expect(parseVisitorHost("sawyer--08000.getbb.app", "getbb.app")).toBeNull();
    expect(parseVisitorHost("sawyer--x.getbb.app", "getbb.app")).toBeNull();
    expect(parseVisitorHost("foo--80--00.getbb.app", "getbb.app")).toBeNull();
  });

  it("rejects the apex, multi-label, and foreign hosts", () => {
    expect(parseVisitorHost("getbb.app", "getbb.app")).toBeNull();
    expect(parseVisitorHost("a.b.getbb.app", "getbb.app")).toBeNull();
    expect(parseVisitorHost("evil.com", "getbb.app")).toBeNull();
    expect(parseVisitorHost("getbb.app.evil.com", "getbb.app")).toBeNull();
  });
});

describe("validateSubdomain (shares the handle grammar)", () => {
  it("rejects `--`, reserved words, and bad charset the same way handles do", () => {
    expect(validateSubdomain("sawyer-desktop")).toBeNull();
    expect(validateSubdomain("foo--bar")).toBe("invalid-format");
    expect(validateSubdomain("Upper")).toBe("invalid-format");
    expect(validateSubdomain("has_underscore")).toBe("invalid-format");
    expect(validateSubdomain("ab")).toBe("too-short");
    expect(validateSubdomain("admin")).toBe("reserved");
  });
});

describe("0003 backfill (staged application on real prior data)", () => {
  it("backfills server.subdomain from the owner's handle before enforcing NOT NULL/UNIQUE", () => {
    const staged = new Database(":memory:");
    staged.pragma("foreign_keys = ON");
    try {
      const files = migrationFiles();
      const subdomainMigration = "0003_server_subdomain.sql";
      const priorFiles = files.filter((f) => f < subdomainMigration);
      expect(priorFiles.length).toBeGreaterThan(0);
      for (const f of priorFiles) applyMigration(staged, f);

      const now = Date.now();
      staged
        .prepare(
          "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?,?,?,?,?,?)",
        )
        .run("u1", "Test", "u1@example.com", 1, now, now);
      staged
        .prepare(
          "INSERT INTO profile (user_id, handle, created_at) VALUES (?,?,?)",
        )
        .run("u1", "sawyer", now);
      staged
        .prepare(
          "INSERT INTO server (id, user_id, name, created_at) VALUES (?,?,?,?)",
        )
        .run("s1", "u1", "default", now);
      staged
        .prepare(
          "INSERT INTO connect_code (code, user_id, server_id, purpose, expires_at, created_at) VALUES (?,?,?,?,?,?)",
        )
        .run(
          "CODE1",
          "u1",
          "s1",
          "server-pair",
          now + CONNECT_CODE_TTL_MS,
          now,
        );

      applyMigration(staged, subdomainMigration);

      const row = staged
        .prepare("SELECT subdomain FROM server WHERE id = ?")
        .get("s1") as {
        subdomain: string;
      };
      expect(row.subdomain).toBe("sawyer");

      const codes = staged
        .prepare("SELECT server_id FROM connect_code")
        .all() as {
        server_id: string;
      }[];
      expect(codes).toHaveLength(1);
      expect(codes[0].server_id).toBe("s1");

      expect(() =>
        staged
          .prepare(
            "INSERT INTO server (id, user_id, name, created_at) VALUES (?,?,?,?)",
          )
          .run("s2", "u1", "laptop", now),
      ).toThrow(/NOT NULL/i);
    } finally {
      staged.close();
    }
  });

  it("applies the full migration chain from scratch cleanly", () => {
    const fresh = new Database(":memory:");
    fresh.pragma("foreign_keys = ON");
    try {
      for (const f of migrationFiles()) applyMigration(fresh, f);
      const cols = fresh.prepare("PRAGMA table_info(server)").all() as {
        name: string;
        notnull: number;
      }[];
      const subdomainCol = cols.find((c) => c.name === "subdomain");
      expect(subdomainCol).toBeDefined();
      expect(subdomainCol?.notnull).toBe(1);
      const machineCols = fresh.prepare("PRAGMA table_info(machine)").all() as {
        name: string;
        notnull: number;
      }[];
      const machineSubdomain = machineCols.find((c) => c.name === "subdomain");
      expect(machineSubdomain).toBeDefined();
      expect(machineSubdomain?.notnull).toBe(0);
      expect(
        fresh
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'label_claim'",
          )
          .get(),
      ).toBeDefined();
      expect(
        fresh
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
          )
          .all(),
      ).toEqual(LABEL_CLAIM_TRIGGERS.map((name) => ({ name })));
    } finally {
      fresh.close();
    }
  });
});

describe("0004 global label claims", () => {
  it("backfills handles and secondary servers without duplicating the primary label", () => {
    const staged = new Database(":memory:");
    staged.pragma("foreign_keys = ON");
    try {
      for (const file of migrationFiles().filter((name) => name < "0004")) {
        applyMigration(staged, file);
      }
      const now = Date.now();
      staged
        .prepare(
          "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?,?,?,?,?,?)",
        )
        .run("u1", "Test", "u1@example.com", 1, now, now);
      staged
        .prepare(
          "INSERT INTO profile (user_id, handle, created_at) VALUES (?,?,?)",
        )
        .run("u1", "sawyer", now);
      staged
        .prepare(
          "INSERT INTO server (id, user_id, name, subdomain, created_at) VALUES (?,?,?,?,?)",
        )
        .run("s1", "u1", "default", "sawyer", now);
      staged
        .prepare(
          "INSERT INTO server (id, user_id, name, subdomain, created_at) VALUES (?,?,?,?,?)",
        )
        .run("s2", "u1", "desktop", "sawyer-desktop", now);

      applyMigration(staged, "0004_machine_labels.sql");

      expect(
        staged
          .prepare(
            "SELECT label, kind, owner_id FROM label_claim ORDER BY label",
          )
          .all(),
      ).toEqual([
        { label: "sawyer", kind: "handle", owner_id: "u1" },
        {
          label: "sawyer-desktop",
          kind: "server",
          owner_id: "s2",
        },
      ]);
      expect(
        staged
          .prepare("SELECT generation FROM label_claim WHERE label = ?")
          .get("sawyer-desktop"),
      ).toEqual({
        generation: expect.stringMatching(/^[a-f0-9]{32}$/u),
      });
    } finally {
      staged.close();
    }
  });

  it("fails instead of silently orphaning a historical cross-tenant collision", () => {
    const staged = new Database(":memory:");
    staged.pragma("foreign_keys = ON");
    try {
      for (const file of migrationFiles().filter((name) => name < "0004")) {
        applyMigration(staged, file);
      }
      const now = Date.now();
      const insertUser = staged.prepare(
        "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      );
      insertUser.run("u1", "One", "u1@example.com", 1, now, now);
      insertUser.run("u2", "Two", "u2@example.com", 1, now, now);
      staged
        .prepare(
          "INSERT INTO profile (user_id, handle, created_at) VALUES (?,?,?)",
        )
        .run("u1", "shared-label", now);
      staged
        .prepare(
          "INSERT INTO profile (user_id, handle, created_at) VALUES (?,?,?)",
        )
        .run("u2", "other-label", now);
      staged
        .prepare(
          "INSERT INTO server (id, user_id, name, subdomain, created_at) VALUES (?,?,?,?,?)",
        )
        .run("s2", "u2", "collision", "shared-label", now);

      expect(() => applyMigration(staged, "0004_machine_labels.sql")).toThrow(
        /unique constraint/iu,
      );
    } finally {
      staged.close();
    }
  });
});

describe("0005 label-claim reconciliation", () => {
  it("claims an old-worker row written after 0004 and prevents cross-tenant reuse", () => {
    const staged = new Database(":memory:");
    staged.pragma("foreign_keys = ON");
    try {
      for (const file of migrationFiles().filter((name) => name < "0005")) {
        applyMigration(staged, file);
      }
      const now = Date.now();
      const insertUser = staged.prepare(
        "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      );
      insertUser.run("u1", "One", "u1@example.com", 1, now, now);
      insertUser.run("u2", "Two", "u2@example.com", 1, now, now);

      staged
        .prepare(
          "INSERT INTO profile (user_id, handle, created_at) VALUES (?,?,?)",
        )
        .run("u1", "gap-label", now);
      expect(
        staged
          .prepare("SELECT label FROM label_claim WHERE label = ?")
          .get("gap-label"),
      ).toBeUndefined();

      staged.transaction(() => {
        applyMigration(staged, "0005_label_claim_triggers.sql");
      })();
      expect(
        staged
          .prepare(
            "SELECT label, kind, owner_id, user_id FROM label_claim WHERE label = ?",
          )
          .get("gap-label"),
      ).toEqual({
        label: "gap-label",
        kind: "handle",
        owner_id: "u1",
        user_id: "u1",
      });

      expect(() =>
        staged
          .prepare(
            "INSERT INTO machine (id, user_id, subdomain, credential_hash, created_at) VALUES (?,?,?,?,?)",
          )
          .run("m2", "u2", "gap-label", "hash", now),
      ).toThrow(/unique constraint/iu);
      expect(
        staged.prepare("SELECT id FROM machine WHERE id = ?").get("m2"),
      ).toBeUndefined();
    } finally {
      staged.close();
    }
  });

  it("removes a claim orphaned by an old-worker delete and makes the label reusable", () => {
    const staged = new Database(":memory:");
    staged.pragma("foreign_keys = ON");
    try {
      for (const file of migrationFiles().filter((name) => name < "0004")) {
        applyMigration(staged, file);
      }
      const now = Date.now();
      const insertUser = staged.prepare(
        "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      );
      insertUser.run("u1", "One", "u1@example.com", 1, now, now);
      insertUser.run("u2", "Two", "u2@example.com", 1, now, now);
      staged
        .prepare(
          "INSERT INTO profile (user_id, handle, created_at) VALUES (?,?,?)",
        )
        .run("u1", "owner-one", now);
      staged
        .prepare(
          "INSERT INTO server (id, user_id, name, subdomain, created_at) VALUES (?,?,?,?,?)",
        )
        .run("s1", "u1", "desktop", "orphan-label", now);
      applyMigration(staged, "0004_machine_labels.sql");
      expect(
        staged
          .prepare("SELECT kind FROM label_claim WHERE label = ?")
          .get("orphan-label"),
      ).toEqual({ kind: "server" });

      staged.prepare("DELETE FROM server WHERE id = ?").run("s1");
      staged.transaction(() => {
        applyMigration(staged, "0005_label_claim_triggers.sql");
      })();
      expect(
        staged
          .prepare("SELECT label FROM label_claim WHERE label = ?")
          .get("orphan-label"),
      ).toBeUndefined();

      expect(() =>
        staged
          .prepare(
            "INSERT INTO machine (id, user_id, subdomain, credential_hash, created_at) VALUES (?,?,?,?,?)",
          )
          .run("m2", "u2", "orphan-label", "hash", now),
      ).not.toThrow();
      expect(
        staged
          .prepare(
            "SELECT kind, owner_id, user_id FROM label_claim WHERE label = ?",
          )
          .get("orphan-label"),
      ).toEqual({ kind: "machine", owner_id: "m2", user_id: "u2" });
    } finally {
      staged.close();
    }
  });

  it("reassigns a stale claim to the current owner after a gap ownership swap", () => {
    const staged = new Database(":memory:");
    staged.pragma("foreign_keys = ON");
    try {
      for (const file of migrationFiles().filter((name) => name < "0004")) {
        applyMigration(staged, file);
      }
      const now = Date.now();
      const insertUser = staged.prepare(
        "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      );
      insertUser.run("u1", "One", "u1@example.com", 1, now, now);
      insertUser.run("u2", "Two", "u2@example.com", 1, now, now);
      const insertProfile = staged.prepare(
        "INSERT INTO profile (user_id, handle, created_at) VALUES (?,?,?)",
      );
      insertProfile.run("u1", "owner-one", now);
      insertProfile.run("u2", "owner-two", now);
      const insertServer = staged.prepare(
        "INSERT INTO server (id, user_id, name, subdomain, created_at) VALUES (?,?,?,?,?)",
      );
      insertServer.run("old-server", "u1", "desktop", "reused-label", now);
      applyMigration(staged, "0004_machine_labels.sql");
      expect(
        staged
          .prepare(
            "SELECT kind, owner_id, user_id FROM label_claim WHERE label = ?",
          )
          .get("reused-label"),
      ).toEqual({ kind: "server", owner_id: "old-server", user_id: "u1" });

      staged.prepare("DELETE FROM server WHERE id = ?").run("old-server");
      insertServer.run("new-server", "u2", "desktop", "reused-label", now + 1);
      staged.transaction(() => {
        applyMigration(staged, "0005_label_claim_triggers.sql");
      })();
      expect(
        staged
          .prepare(
            "SELECT kind, owner_id, user_id FROM label_claim WHERE label = ?",
          )
          .get("reused-label"),
      ).toEqual({ kind: "server", owner_id: "new-server", user_id: "u2" });

      staged.prepare("DELETE FROM server WHERE id = ?").run("new-server");
      expect(
        staged
          .prepare("SELECT label FROM label_claim WHERE label = ?")
          .get("reused-label"),
      ).toBeUndefined();
      expect(() =>
        staged
          .prepare(
            "INSERT INTO machine (id, user_id, subdomain, credential_hash, created_at) VALUES (?,?,?,?,?)",
          )
          .run("replacement-machine", "u1", "reused-label", "hash", now + 2),
      ).not.toThrow();
    } finally {
      staged.close();
    }
  });

  it("moves a claim when an old worker updates a server label in the gap", () => {
    const staged = new Database(":memory:");
    staged.pragma("foreign_keys = ON");
    try {
      for (const file of migrationFiles().filter((name) => name < "0004")) {
        applyMigration(staged, file);
      }
      const now = Date.now();
      staged
        .prepare(
          "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?,?,?,?,?,?)",
        )
        .run("u1", "One", "u1@example.com", 1, now, now);
      staged
        .prepare(
          "INSERT INTO profile (user_id, handle, created_at) VALUES (?,?,?)",
        )
        .run("u1", "owner-one", now);
      staged
        .prepare(
          "INSERT INTO server (id, user_id, name, subdomain, created_at) VALUES (?,?,?,?,?)",
        )
        .run("s1", "u1", "desktop", "old-label", now);
      applyMigration(staged, "0004_machine_labels.sql");

      staged
        .prepare("UPDATE server SET subdomain = ? WHERE id = ?")
        .run("new-label", "s1");
      expect(
        staged
          .prepare("SELECT kind FROM label_claim WHERE label = ?")
          .get("old-label"),
      ).toEqual({ kind: "server" });
      expect(
        staged
          .prepare("SELECT label FROM label_claim WHERE label = ?")
          .get("new-label"),
      ).toBeUndefined();

      staged.transaction(() => {
        applyMigration(staged, "0005_label_claim_triggers.sql");
      })();
      expect(
        staged
          .prepare("SELECT label FROM label_claim WHERE label = ?")
          .get("old-label"),
      ).toBeUndefined();
      expect(
        staged
          .prepare(
            "SELECT kind, owner_id, user_id FROM label_claim WHERE label = ?",
          )
          .get("new-label"),
      ).toEqual({ kind: "server", owner_id: "s1", user_id: "u1" });
    } finally {
      staged.close();
    }
  });

  it("fails atomically when gap writes contain a genuine cross-source collision", () => {
    const staged = new Database(":memory:");
    staged.pragma("foreign_keys = ON");
    try {
      for (const file of migrationFiles().filter((name) => name < "0005")) {
        applyMigration(staged, file);
      }
      const now = Date.now();
      const insertUser = staged.prepare(
        "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      );
      insertUser.run("u1", "One", "u1@example.com", 1, now, now);
      insertUser.run("u2", "Two", "u2@example.com", 1, now, now);
      staged
        .prepare(
          "INSERT INTO profile (user_id, handle, created_at) VALUES (?,?,?)",
        )
        .run("u1", "conflict-label", now);
      staged
        .prepare(
          "INSERT INTO server (id, user_id, name, subdomain, created_at) VALUES (?,?,?,?,?)",
        )
        .run("s2", "u2", "default", "conflict-label", now);

      const apply = staged.transaction(() => {
        applyMigration(staged, "0005_label_claim_triggers.sql");
      });
      expect(apply).toThrow(/label_claim_reconciliation_conflict/iu);
      expect(staged.prepare("SELECT label FROM label_claim").all()).toEqual([]);
      expect(
        staged
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%_label_claim_%'",
          )
          .all(),
      ).toEqual([]);
    } finally {
      staged.close();
    }
  });
});

describe("checkLabelAvailability (all routing namespaces)", () => {
  it("reports a free, well-formed label available", async () => {
    seedUser();
    expect(await checkLabelAvailability(db, "sawyer-desktop")).toEqual({
      available: true,
      label: "sawyer-desktop",
    });
  });

  it("trigger-claims handle and server rows written by an old web worker", async () => {
    seedUser("u1");
    seedUser("u2");
    const now = new Date();
    db.insert(profile)
      .values({ userId: "u1", handle: "legacy-handle", createdAt: now })
      .run();
    db.insert(server)
      .values([
        {
          id: "legacy-primary",
          userId: "u1",
          name: "default",
          subdomain: "legacy-handle",
          createdAt: now,
        },
        {
          id: "legacy-secondary",
          userId: "u1",
          name: "desktop",
          subdomain: "legacy-server",
          createdAt: now,
        },
      ])
      .run();

    await expect(checkLabelAvailability(db, "legacy-handle")).resolves.toEqual({
      available: false,
      reason: "taken",
      namespace: "handle",
    });
    db.insert(machine)
      .values({
        id: "attacker-machine",
        userId: "u2",
        credentialHash: "hash",
        createdAt: now,
      })
      .run();
    expect(() =>
      db
        .update(machine)
        .set({ subdomain: "legacy-server" })
        .where(eq(machine.id, "attacker-machine"))
        .run(),
    ).toThrow(/unique constraint/iu);
    await expect(checkLabelAvailability(db, "legacy-server")).resolves.toEqual({
      available: false,
      reason: "taken",
      namespace: "subdomain",
    });
    expect(
      db
        .select({
          label: labelClaim.label,
          kind: labelClaim.kind,
          generation: labelClaim.generation,
        })
        .from(labelClaim)
        .where(eq(labelClaim.label, "legacy-server"))
        .get(),
    ).toEqual({
      label: "legacy-server",
      kind: "server",
      generation: expect.stringMatching(/^[a-f0-9]{32}$/u),
    });
  });

  it("normalizes case/whitespace before checking", async () => {
    const result = await checkLabelAvailability(db, "  Sawyer-Desktop  ");
    expect(result).toEqual({ available: true, label: "sawyer-desktop" });
  });

  it("rejects invalid labels with the grammar reason (reserved, `--`, charset)", async () => {
    expect(await checkLabelAvailability(db, "admin")).toEqual({
      available: false,
      reason: "invalid",
      error: "reserved",
    });
    expect(await checkLabelAvailability(db, "foo--bar")).toEqual({
      available: false,
      reason: "invalid",
      error: "invalid-format",
    });
    expect(await checkLabelAvailability(db, "ab")).toEqual({
      available: false,
      reason: "invalid",
      error: "too-short",
    });
  });

  it("reports a label taken by an existing handle", async () => {
    seedUser("u1");
    const now = new Date();
    db.insert(profile)
      .values({ userId: "u1", handle: "sawyer", createdAt: now })
      .run();
    expect(await checkLabelAvailability(db, "sawyer")).toEqual({
      available: false,
      reason: "taken",
      namespace: "handle",
    });
  });

  it("reports a label taken by an existing server subdomain", async () => {
    seedUser("u1");
    const now = new Date();
    db.insert(profile)
      .values({ userId: "u1", handle: "sawyer", createdAt: now })
      .run();
    db.insert(server)
      .values({
        id: "s1",
        userId: "u1",
        name: "desktop",
        subdomain: "sawyer-desktop",
        createdAt: now,
      })
      .run();
    expect(await checkLabelAvailability(db, "sawyer-desktop")).toEqual({
      available: false,
      reason: "taken",
      namespace: "subdomain",
    });
  });

  it("reports a label taken by an existing machine subdomain", async () => {
    seedUser("u1");
    const now = new Date();
    db.insert(machine)
      .values({
        id: "m1",
        userId: "u1",
        subdomain: "sawyer-air",
        credentialHash: "hash",
        createdAt: now,
      })
      .run();
    expect(await checkLabelAvailability(db, "sawyer-air")).toEqual({
      available: false,
      reason: "taken",
      namespace: "machine",
    });
  });
});
