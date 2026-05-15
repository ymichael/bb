import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createConnection,
  type SlowDbQueryLogger,
  type SlowDbQueryLogFields,
} from "../src/connection.js";
import { migrate } from "../src/migrate.js";
import { hosts } from "../src/schema.js";

interface LoggedDebug {
  fields: SlowDbQueryLogFields;
  message: string;
}

class CapturingSlowQueryLogger implements SlowDbQueryLogger {
  readonly debugLogs: LoggedDebug[] = [];

  debug(fields: SlowDbQueryLogFields, message: string): void {
    this.debugLogs.push({ fields, message });
  }

  clear(): void {
    this.debugLogs.length = 0;
  }
}

function getOnlyDebugLog(logger: CapturingSlowQueryLogger): LoggedDebug {
  expect(logger.debugLogs).toHaveLength(1);
  const debugLog = logger.debugLogs[0];
  if (!debugLog) {
    throw new Error("Expected slow query debug log");
  }
  return debugLog;
}

describe("createConnection", () => {
  it("logs slow prepared statement executions without parameter values", () => {
    const logger = new CapturingSlowQueryLogger();
    const db = createConnection(":memory:", {
      slowQueryLogger: logger,
      slowQueryThresholdMs: 0,
    });

    db.$client.prepare("SELECT ? AS value").get("sensitive-value");

    const debugLog = getOnlyDebugLog(logger);
    expect(debugLog.message).toBe("Slow DB query");
    expect(debugLog.fields.operation).toBe("get");
    expect(debugLog.fields.bindingArgumentCount).toBe(1);
    expect(debugLog.fields.sql).toBe("SELECT ? AS value");
    expect(debugLog.fields.sql).not.toContain("sensitive-value");

    db.$client.close();
  });

  it("redacts SQL string literals in slow query logs", () => {
    const logger = new CapturingSlowQueryLogger();
    const db = createConnection(":memory:", {
      slowQueryLogger: logger,
      slowQueryThresholdMs: 0,
    });

    db.$client.prepare("SELECT 'sensitive-literal' AS value").get();

    const debugLog = getOnlyDebugLog(logger);
    expect(debugLog.fields.sql).toBe("SELECT '?' AS value");
    expect(debugLog.fields.sql).not.toContain("sensitive-literal");

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
    const debugLog = getOnlyDebugLog(logger);
    expect(debugLog.message).toBe("Slow DB query");
    expect(debugLog.fields.operation).toBe("get");
    expect(debugLog.fields.bindingArgumentCount).toBe(1);
    expect(debugLog.fields.sql).toContain("from");
    expect(debugLog.fields.sql).toContain("hosts");
    expect(debugLog.fields.sql).not.toContain("host-drizzle");

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

    const debugLog = getOnlyDebugLog(logger);
    expect(debugLog.fields.sql).toHaveLength(1_000);
    expect(debugLog.fields.sql.endsWith("...")).toBe(true);

    db.$client.close();
  });
});
