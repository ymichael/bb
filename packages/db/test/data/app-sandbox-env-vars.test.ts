import { beforeEach, describe, expect, it } from "vitest";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import {
  deleteAppSandboxEnvVar,
  getAppSandboxEnvVar,
  listAppSandboxEnvVars,
  upsertAppSandboxEnvVar,
} from "../../src/data/app-sandbox-env-vars.js";

describe("app sandbox env vars", () => {
  let db = createConnection(":memory:");

  beforeEach(() => {
    db = createConnection(":memory:");
    migrate(db);
  });

  it("upserts rows by name while preserving createdAt", () => {
    const first = upsertAppSandboxEnvVar(db, {
      encryptedValue: "ciphertext-1",
      name: "OPENAI_API_KEY",
      updatedAt: 10,
    });
    const second = upsertAppSandboxEnvVar(db, {
      encryptedValue: "ciphertext-2",
      name: "OPENAI_API_KEY",
      updatedAt: 20,
    });

    expect(first.createdAt).toBe(10);
    expect(second.createdAt).toBe(10);
    expect(second.updatedAt).toBe(20);
    expect(second.encryptedValue).toBe("ciphertext-2");
    expect(listAppSandboxEnvVars(db)).toHaveLength(1);
  });

  it("lists and deletes env vars", () => {
    upsertAppSandboxEnvVar(db, {
      encryptedValue: "ciphertext-a",
      name: "ANTHROPIC_API_KEY",
      updatedAt: 10,
    });
    upsertAppSandboxEnvVar(db, {
      encryptedValue: "ciphertext-b",
      name: "PI_API_TOKEN",
      updatedAt: 20,
    });

    expect(getAppSandboxEnvVar(db, "ANTHROPIC_API_KEY")).toMatchObject({
      encryptedValue: "ciphertext-a",
      name: "ANTHROPIC_API_KEY",
    });
    expect(listAppSandboxEnvVars(db).map((record) => record.name).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "PI_API_TOKEN",
    ]);

    expect(deleteAppSandboxEnvVar(db, "ANTHROPIC_API_KEY")).toBe(true);
    expect(deleteAppSandboxEnvVar(db, "ANTHROPIC_API_KEY")).toBe(false);
    expect(listAppSandboxEnvVars(db)).toHaveLength(1);
  });
});
