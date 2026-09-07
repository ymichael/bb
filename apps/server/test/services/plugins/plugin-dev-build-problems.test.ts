import { mkdtemp } from "node:fs/promises";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createConnection, migrate } from "@bb/db";
import type { Logger } from "@bb/logger";
import { createPluginRuntime } from "../../../src/services/plugins/plugin-runtime.js";
import { testLogger } from "../../helpers/test-app.js";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";

async function createRuntime() {
  const db = createConnection(":memory:");
  migrate(db);
  return createPluginRuntime({
    deps: {
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger: testLogger as unknown as Logger,
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      dataDir: await mkdtemp(join(tmpdir(), "bb-dev-build-problems-")),
      appVersion: "0.9.0",
    },
    nextCronRunAt: () => Number.MAX_SAFE_INTEGER,
    settledWithin: async () => true,
  });
}

describe("plugin dev build problems", () => {
  it("labels problems by build target and clears each target independently", async () => {
    const runtime = await createRuntime();
    runtime.setStatus("demo", "running", null);

    runtime.setDevBuildProblem("demo", "host", "boom in host entry");
    expect(runtime.statuses.get("demo")?.detail).toBe(
      "host bundle build failed: boom in host entry",
    );

    runtime.setDevBuildProblem("demo", "frontend", "boom in app entry");
    expect(runtime.statuses.get("demo")?.detail).toBe(
      "frontend bundle build failed: boom in app entry; host bundle build failed: boom in host entry",
    );

    runtime.setDevBuildProblem("demo", "frontend", null);
    expect(runtime.statuses.get("demo")?.detail).toBe(
      "host bundle build failed: boom in host entry",
    );

    runtime.setDevBuildProblem("demo", "host", null);
    expect(runtime.statuses.get("demo")?.detail).toBeNull();
    expect(runtime.statuses.get("demo")?.status).toBe("running");
  });

  it("keeps build problems appended to later status updates until cleared", async () => {
    const runtime = await createRuntime();
    runtime.setStatus("demo", "running", null);
    runtime.setDevBuildProblem("demo", "host", "boom");

    runtime.setStatus("demo", "degraded", "service crashed");
    expect(runtime.statuses.get("demo")?.detail).toBe(
      "service crashed; host bundle build failed: boom",
    );

    runtime.setDevBuildProblem("demo", "host", null);
    expect(runtime.statuses.get("demo")?.detail).toBe("service crashed");
  });
});
