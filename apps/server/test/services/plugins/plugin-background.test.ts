import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronExpressionParser } from "cron-parser";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimPluginScheduledRun,
  createConnection,
  listPluginSchedules,
  migrate,
  pluginSchedules,
  type DbConnection,
} from "@bb/db";
import type { Logger } from "@bb/logger";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import {
  createPluginService,
  type PluginService,
} from "../../../src/services/plugins/plugin-service.js";
import { testLogger } from "../../helpers/test-app.js";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";

const logger = testLogger as unknown as Logger;

async function writePlugin(
  dir: string,
  options: { name: string; serverSource: string },
): Promise<string> {
  const rootDir = join(dir, options.name);
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: options.name,
      version: "0.1.0",
      bb: {
        name: "Background fixture",
        description: "Background plugin fixture.",
        branding: { icon: "Zap" },
        server: "./server.ts",
      },
    }),
  );
  await writeFile(join(rootDir, "server.ts"), options.serverSource);
  return rootDir;
}

function setNextRunAt(
  db: DbConnection,
  pluginId: string,
  name: string,
  nextRunAt: number,
): void {
  db.update(pluginSchedules)
    .set({ nextRunAt })
    .where(
      and(
        eq(pluginSchedules.pluginId, pluginId),
        eq(pluginSchedules.name, name),
      ),
    )
    .run();
}

const globals = globalThis as Record<string, unknown>;

describe("plugin background services", () => {
  let db: DbConnection;
  let workDir: string;
  let service: PluginService;

  beforeEach(async () => {
    db = createConnection(":memory:");
    migrate(db);
    workDir = await mkdtemp(join(tmpdir(), "bb-plugin-bg-test-"));
    service = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger,
      dataDir: join(workDir, "data"),
      appVersion: "0.9.0",
      loadTimeoutMs: 2000,
      serviceStopTimeoutMs: 100,
      serviceRestartBaseMs: 5,
    });
  });

  afterEach(async () => {
    await service.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  it("starts services after load and aborts them on reload", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-connector",
      serverSource: `
        export default function plugin(bb: any) {
          const g = globalThis as any;
          g.__connStarts = (g.__connStarts ?? 0);
          g.__connAborts = (g.__connAborts ?? 0);
          bb.background.service("conn", {
            start(signal: any) {
              g.__connStarts += 1;
              return new Promise<void>((resolve) => {
                signal.addEventListener("abort", () => {
                  g.__connAborts += 1;
                  resolve();
                });
              });
            },
          });
        }
      `,
    });
    const entry = await service.installPath(rootDir);
    expect(entry.status).toBe("running");
    expect(entry.services).toEqual([{ name: "conn", state: "running" }]);
    expect(globals.__connStarts).toBe(1);

    await service.reload("connector");
    expect(globals.__connAborts).toBe(1);
    expect(globals.__connStarts).toBe(2);
    const reloaded = service.list().find((p) => p.id === "connector");
    expect(reloaded?.status).toBe("running");
    expect(reloaded?.services).toEqual([{ name: "conn", state: "running" }]);
  });

  it("rejects new interactions while a plugin is disposing", async () => {
    globals.__disposeRequestErrors = [];
    const requestPluginInteraction = vi.fn(async () => ({
      outcome: "cancelled" as const,
      reason: "plugin-disposed" as const,
    }));
    const interruptPluginInteractions = vi.fn(() => []);
    const local = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger,
      pendingInteractions: {
        requestPluginInteraction,
        interruptPluginInteractions,
        setPluginDirectory: () => {},
      },
      dataDir: join(workDir, "data-dispose-request"),
      appVersion: "0.9.0",
      loadTimeoutMs: 2000,
      serviceStopTimeoutMs: 2000,
    });
    try {
      const rootDir = await writePlugin(workDir, {
        name: "bb-plugin-dispose-request",
        serverSource: `
          export default function plugin(bb: any) {
            const g = globalThis as any;
            g.__disposeRequestErrors = g.__disposeRequestErrors ?? [];
            bb.background.service("request-on-stop", {
              start(signal: any) {
                return new Promise<void>((resolve) => {
                  signal.addEventListener("abort", () => {
                    void bb.ui.requestInput({
                      threadId: "thread-test",
                      rendererId: "form",
                      title: "Form",
                      payload: null,
                    }).then(
                      () => g.__disposeRequestErrors.push("unexpected success"),
                      (error: Error) => g.__disposeRequestErrors.push(error.message),
                    ).finally(resolve);
                  }, { once: true });
                });
              },
            });
          }
        `,
      });
      await local.installPath(rootDir);

      await local.reload("dispose-request");

      expect(requestPluginInteraction).not.toHaveBeenCalled();
      expect(globals.__disposeRequestErrors).toEqual([
        'plugin "dispose-request" is disposing',
      ]);
    } finally {
      await local.stop();
    }
  });

  it("serializes concurrent reloads so a slow-stopping service never double-starts", async () => {
    const local = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger,
      dataDir: join(workDir, "data-serialize"),
      appVersion: "0.9.0",
      loadTimeoutMs: 2000,
      serviceStopTimeoutMs: 2000,
    });
    try {
      const rootDir = await writePlugin(workDir, {
        name: "bb-plugin-slowstop",
        serverSource: `
          export default function plugin(bb: any) {
            const g = globalThis as any;
            g.__slowActive = g.__slowActive ?? 0;
            g.__slowMaxActive = g.__slowMaxActive ?? 0;
            g.__slowStarts = g.__slowStarts ?? 0;
            bb.background.service("slow", {
              start(signal: any) {
                g.__slowStarts += 1;
                g.__slowActive += 1;
                g.__slowMaxActive = Math.max(g.__slowMaxActive, g.__slowActive);
                return new Promise<void>((resolve) => {
                  signal.addEventListener("abort", () => {
                    // Slow-but-legitimate stop: the window in which an
                    // unserialized concurrent load would double-start.
                    setTimeout(() => {
                      g.__slowActive -= 1;
                      resolve();
                    }, 300);
                  });
                });
              },
            });
          }
        `,
      });
      const entry = await local.installPath(rootDir);
      expect(entry.status).toBe("running");
      await Promise.all([local.reload("slowstop"), local.reload("slowstop")]);
      const reloaded = local.list().find((p) => p.id === "slowstop");
      expect(reloaded?.status).toBe("running");
      expect(reloaded?.services).toEqual([{ name: "slow", state: "running" }]);
      expect(globals.__slowStarts).toBe(3);
      expect(globals.__slowMaxActive).toBe(1);
    } finally {
      await local.stop();
    }
  });

  it("marks the plugin degraded when a service ignores its abort", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-stubborn",
      serverSource: `
        export default function plugin(bb: any) {
          bb.background.service("socket", {
            start() {
              // Ignores the abort signal entirely.
              return new Promise(() => {});
            },
          });
        }
      `,
    });
    await service.installPath(rootDir);
    const outcome = await service.reload("stubborn");
    const entry = service.list().find((p) => p.id === "stubborn");
    expect(entry?.status).toBe("degraded");
    expect(entry?.statusDetail).toContain("service socket did not stop");
    expect(service.getApi("stubborn")).toBeUndefined();
    expect(outcome).toEqual({
      ok: false,
      error: 'plugin "stubborn" reload failed: service socket did not stop',
      plugins: service.list(),
    });

    const again = await service.reload("stubborn");
    expect(service.list().find((p) => p.id === "stubborn")?.status).toBe(
      "degraded",
    );
    expect(again.ok).toBe(false);
  });

  it("reports a failed reload that kept the previous instance", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-keeper",
      serverSource: `
        export default function plugin(bb: any) {
          bb.cli.register({ name: "keeper", summary: "keeper", run() { return { exitCode: 0, stdout: "ok" }; } });
        }
      `,
    });
    const installed = await service.installPath(rootDir);
    expect(installed.status).toBe("running");
    const healthy = await service.reload("keeper");
    expect(healthy.ok).toBe(true);

    await writeFile(
      join(rootDir, "server.ts"),
      `export default function plugin() { throw new Error("boom on load"); }`,
    );
    const outcome = await service.reload("keeper");
    const entry = service.list().find((p) => p.id === "keeper");
    expect(entry?.status).toBe("running");
    expect(entry?.statusDetail).toBe("reload failed: boom on load");
    expect(service.getApi("keeper")).toBeDefined();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error).toBe(
      'plugin "keeper" reload failed: boom on load (the previous instance is still running)',
    );

    expect((await service.reload()).ok).toBe(false);
    await writeFile(
      join(rootDir, "server.ts"),
      `export default function plugin(bb: any) { bb.cli.register({ name: "keeper", summary: "keeper", run() { return { exitCode: 0, stdout: "ok" }; } }); }`,
    );
    expect((await service.reload("keeper")).ok).toBe(true);
    expect(
      service.list().find((p) => p.id === "keeper")?.statusDetail,
    ).toBeNull();
  });

  it("restarts a crashed service with backoff", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-crashy",
      serverSource: `
        export default function plugin(bb: any) {
          const g = globalThis as any;
          g.__crashyStarts = 0;
          bb.background.service("flaky", {
            async start(signal: any) {
              g.__crashyStarts += 1;
              if (g.__crashyStarts < 3) throw new Error("crash " + g.__crashyStarts);
              await new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => resolve()));
            },
          });
        }
      `,
    });
    await service.installPath(rootDir);
    await vi.waitFor(
      () => {
        expect(globals.__crashyStarts).toBe(3);
      },
      { timeout: 2000 },
    );
    await vi.waitFor(() => {
      expect(service.list().find((p) => p.id === "crashy")?.services).toEqual([
        { name: "flaky", state: "running" },
      ]);
    });
  });

  it("routes an uncaught exception from a service's async context to the supervisor", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-emitter",
      serverSource: `
        import { EventEmitter } from "node:events";
        export default function plugin(bb: any) {
          const g = globalThis as any;
          g.__emitterStarts = 0;
          g.__emitterAborts = 0;
          bb.background.service("imap", {
            async start(signal: any) {
              g.__emitterStarts += 1;
              if (g.__emitterStarts === 1) {
                const client = new EventEmitter(); // no client.on("error")
                setTimeout(() => client.emit("error", new Error("Socket timeout")), 5);
              }
              await new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => {
                  g.__emitterAborts += 1;
                  resolve();
                }));
            },
          });
        }
      `,
    });
    const vitestListeners = process.listeners("uncaughtException");
    process.removeAllListeners("uncaughtException");
    const unclaimed: unknown[] = [];
    process.on("uncaughtException", (error) => {
      if (!service.handleUncaughtException(error)) unclaimed.push(error);
    });
    try {
      await service.installPath(rootDir);
      await vi.waitFor(
        () => {
          expect(globals.__emitterStarts).toBe(2);
        },
        { timeout: 2000 },
      );
      expect(globals.__emitterAborts).toBe(1);
      await vi.waitFor(() => {
        expect(
          service.list().find((p) => p.id === "emitter")?.services,
        ).toEqual([{ name: "imap", state: "running" }]);
      });
      expect(unclaimed).toEqual([]);
      expect(service.list().find((p) => p.id === "emitter")?.status).toBe(
        "running",
      );
    } finally {
      process.removeAllListeners("uncaughtException");
      for (const listener of vitestListeners) {
        process.on("uncaughtException", listener);
      }
    }
  });

  it("NeedsConfigurationError maps to needs-configuration and stops restarts", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-needy",
      serverSource: `
        export default function plugin(bb: any) {
          const g = globalThis as any;
          g.__needyStarts = (g.__needyStarts ?? 0);
          bb.background.service("bot", {
            async start() {
              g.__needyStarts += 1;
              const error = new Error("api key missing");
              error.name = "NeedsConfigurationError";
              throw error;
            },
          });
        }
      `,
    });
    await service.installPath(rootDir);
    await vi.waitFor(() => {
      expect(service.list().find((p) => p.id === "needy")?.status).toBe(
        "needs-configuration",
      );
    });
    const entry = service.list().find((p) => p.id === "needy");
    expect(entry?.statusDetail).toBe("api key missing");
    expect(entry?.services).toEqual([{ name: "bot", state: "stopped" }]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(globals.__needyStarts).toBe(1);

    await service.reload("needy");
    await vi.waitFor(() => {
      expect(globals.__needyStarts).toBe(2);
    });
  });

  it("bb.status.needsConfiguration from the factory wins over running", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-unconfigured",
      serverSource: `
        export default function plugin(bb: any) {
          bb.status.needsConfiguration("set the token first");
        }
      `,
    });
    const entry = await service.installPath(rootDir);
    expect(entry.status).toBe("needs-configuration");
    expect(entry.statusDetail).toBe("set the token first");
    expect(service.getApi("unconfigured")).toBeDefined();
  });

  it("rejects an invalid cron at registration", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-badcron",
      serverSource: `
        export default function plugin(bb: any) {
          bb.background.schedule("bad", "not a cron", async () => {});
        }
      `,
    });
    await service.installPath(rootDir);
    const entry = service.list().find((p) => p.id === "badcron");
    expect(entry?.status).toBe("error");
    expect(entry?.statusDetail).toContain('invalid cron "not a cron"');
  });
});

describe("plugin schedules", () => {
  let db: DbConnection;
  let workDir: string;
  let service: PluginService;

  beforeEach(async () => {
    db = createConnection(":memory:");
    migrate(db);
    workDir = await mkdtemp(join(tmpdir(), "bb-plugin-sched-test-"));
    service = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger,
      dataDir: join(workDir, "data"),
      appVersion: "0.9.0",
      loadTimeoutMs: 2000,
    });
  });

  afterEach(async () => {
    await service.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  async function installTicker(): Promise<void> {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-ticker",
      serverSource: `
        export default function plugin(bb: any) {
          const g = globalThis as any;
          g.__tickRuns = 0;
          bb.background.schedule("tick", "*/5 * * * *", async () => {
            g.__tickRuns += 1;
          });
        }
      `,
    });
    await service.installPath(rootDir);
  }

  it("registration upserts the row with a future next_run_at", async () => {
    const before = Date.now();
    await installTicker();
    const rows = listPluginSchedules(db, "ticker");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("tick");
    expect(rows[0]?.cron).toBe("*/5 * * * *");
    expect(rows[0]?.nextRunAt).toBeGreaterThan(before);
    expect(rows[0]?.lastStatus).toBeNull();
    const entry = service.list().find((p) => p.id === "ticker");
    expect(entry?.schedules).toHaveLength(1);
    expect(entry?.schedules[0]?.name).toBe("tick");
  });

  it("runs a due schedule and advances next_run_at per cron", async () => {
    await installTicker();
    setNextRunAt(db, "ticker", "tick", Date.now() - 60_000);
    const now = Date.now();
    await service.sweepDueSchedules(now);
    expect(globals.__tickRuns).toBe(1);
    const row = listPluginSchedules(db, "ticker")[0];
    const expectedNext = CronExpressionParser.parse("*/5 * * * *", {
      currentDate: new Date(now),
    })
      .next()
      .getTime();
    expect(row?.nextRunAt).toBe(expectedNext);
    expect(row?.lastStatus).toBe("ok");
    expect(row?.lastRunAt).toBe(now);
    expect(row?.lastError).toBeNull();
  });

  it("claims with CAS: parallel sweeps run the fn exactly once", async () => {
    await installTicker();
    const past = Date.now() - 60_000;
    setNextRunAt(db, "ticker", "tick", past);
    const now = Date.now();
    await Promise.all([
      service.sweepDueSchedules(now),
      service.sweepDueSchedules(now),
    ]);
    expect(globals.__tickRuns).toBe(1);
    const claimed = claimPluginScheduledRun(db, {
      pluginId: "ticker",
      name: "tick",
      expectedNextRunAt: past,
      newNextRunAt: now + 60_000,
      now,
    });
    expect(claimed).toBe(false);
  });

  it("records last_error on failure and still advances the schedule", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-boomer",
      serverSource: `
        export default function plugin(bb: any) {
          bb.background.schedule("boom", "*/5 * * * *", async () => {
            throw new Error("sync exploded");
          });
        }
      `,
    });
    await service.installPath(rootDir);
    setNextRunAt(db, "boomer", "boom", Date.now() - 60_000);
    const now = Date.now();
    await service.sweepDueSchedules(now);
    const row = listPluginSchedules(db, "boomer")[0];
    expect(row?.lastStatus).toBe("error");
    expect(row?.lastError).toContain("sync exploded");
    expect(row?.nextRunAt).toBeGreaterThan(now);
    const entry = service.list().find((p) => p.id === "boomer");
    expect(entry?.handlerStats.errorCount).toBe(1);
  });

  it("leaves rows unclaimed while the plugin is not loaded; remove deletes them", async () => {
    await installTicker();
    await service.setEnabled("ticker", false);
    expect(listPluginSchedules(db, "ticker")).toHaveLength(1);
    const past = Date.now() - 60_000;
    setNextRunAt(db, "ticker", "tick", past);
    await service.sweepDueSchedules(Date.now());
    expect(globals.__tickRuns).toBe(0);
    expect(listPluginSchedules(db, "ticker")[0]?.nextRunAt).toBe(past);

    await service.setEnabled("ticker", true);
    await service.remove("ticker");
    expect(listPluginSchedules(db, "ticker")).toHaveLength(0);
  });

  it("prunes rows for schedule names the plugin no longer registers", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-renamer",
      serverSource: `
        export default function plugin(bb: any) {
          bb.background.schedule("old-name", "*/5 * * * *", async () => {});
        }
      `,
    });
    await service.installPath(rootDir);
    expect(listPluginSchedules(db, "renamer").map((r) => r.name)).toEqual([
      "old-name",
    ]);
    await writeFile(
      join(rootDir, "server.ts"),
      `export default function plugin(bb: any) {
        bb.background.schedule("new-name", "*/5 * * * *", async () => {});
      }`,
    );
    await service.reload("renamer");
    expect(listPluginSchedules(db, "renamer").map((r) => r.name)).toEqual([
      "new-name",
    ]);
  });
});
