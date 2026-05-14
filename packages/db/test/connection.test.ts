import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createConnection,
  type SlowDbQueryLogger,
  type SlowDbQueryLogFields,
} from "../src/connection.js";
import { migrate } from "../src/migrate.js";
import { hosts } from "../src/schema.js";

interface LoggedWarning {
  fields: SlowDbQueryLogFields;
  message: string;
}

class CapturingSlowQueryLogger implements SlowDbQueryLogger {
  readonly warnings: LoggedWarning[] = [];

  warn(fields: SlowDbQueryLogFields, message: string): void {
    this.warnings.push({ fields, message });
  }

  clear(): void {
    this.warnings.length = 0;
  }
}

function getOnlyWarning(logger: CapturingSlowQueryLogger): LoggedWarning {
  expect(logger.warnings).toHaveLength(1);
  const warning = logger.warnings[0];
  if (!warning) {
    throw new Error("Expected slow query warning");
  }
  return warning;
}

describe("createConnection", () => {
  it("logs slow prepared statement executions without parameter values", () => {
    const logger = new CapturingSlowQueryLogger();
    const db = createConnection(":memory:", {
      slowQueryLogger: logger,
      slowQueryThresholdMs: 0,
    });

    db.$client.prepare("SELECT ? AS value").get("sensitive-value");

    const warning = getOnlyWarning(logger);
    expect(warning.message).toBe("Slow DB query");
    expect(warning.fields.operation).toBe("get");
    expect(warning.fields.bindingArgumentCount).toBe(1);
    expect(warning.fields.sql).toBe("SELECT ? AS value");
    expect(warning.fields.sql).not.toContain("sensitive-value");

    db.$client.close();
  });

  it("redacts SQL string literals in slow query logs", () => {
    const logger = new CapturingSlowQueryLogger();
    const db = createConnection(":memory:", {
      slowQueryLogger: logger,
      slowQueryThresholdMs: 0,
    });

    db.$client.prepare("SELECT 'sensitive-literal' AS value").get();

    const warning = getOnlyWarning(logger);
    expect(warning.fields.sql).toBe("SELECT '?' AS value");
    expect(warning.fields.sql).not.toContain("sensitive-literal");

    db.$client.close();
  });

  it("logs slow drizzle ORM statement executions", () => {
    const logger = new CapturingSlowQueryLogger();
    const db = createConnection(":memory:", {
      slowQueryLogger: logger,
      slowQueryThresholdMs: 0,
    });
    migrate(db);
    db.insert(hosts)
      .values({
        createdAt: 1,
        id: "host-drizzle",
        name: "Drizzle Host",
        type: "persistent",
        updatedAt: 1,
      })
      .run();
    logger.clear();

    const row = db
      .select()
      .from(hosts)
      .where(eq(hosts.id, "host-drizzle"))
      .get();

    expect(row?.name).toBe("Drizzle Host");
    const warning = getOnlyWarning(logger);
    expect(warning.message).toBe("Slow DB query");
    expect(warning.fields.operation).toBe("get");
    expect(warning.fields.bindingArgumentCount).toBe(1);
    expect(warning.fields.sql).toContain("from");
    expect(warning.fields.sql).toContain("hosts");
    expect(warning.fields.sql).not.toContain("host-drizzle");

    db.$client.close();
  });

  it("keeps truncated slow query SQL within the logged length limit", () => {
    const logger = new CapturingSlowQueryLogger();
    const db = createConnection(":memory:", {
      slowQueryLogger: logger,
      slowQueryThresholdMs: 0,
    });
    const longSql = `SELECT '${"x".repeat(1_200)}' AS value, ${"1 OR ".repeat(
      300,
    )} 1`;

    db.$client.prepare(longSql).get();

    const warning = getOnlyWarning(logger);
    expect(warning.fields.sql).toHaveLength(1_000);
    expect(warning.fields.sql.endsWith("...")).toBe(true);

    db.$client.close();
  });
});
