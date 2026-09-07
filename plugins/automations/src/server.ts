import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { migrations } from "./data.js";
import { ingestLegacyImport } from "./legacy-import.js";
import { pluginDataDirFromDb } from "./path.js";
import { automationRpcContract, createRpcHandlers } from "./rpc.js";
import {
  closeAutomationRunForSettledThread,
  disableAutomationsForDeletedThreadEvent,
  reconcileRunningAutomationRuns,
} from "./run.js";
import { registerAutomationCli } from "./cli.js";
import { createAutomationService } from "./service.js";
import { sleep, sweepDueAutomations, SWEEP_INTERVAL_MS } from "./sweep.js";

function resolveServerUrl(): string {
  return process.env.BB_SERVER_URL?.trim() || "http://127.0.0.1:38886";
}

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  const pluginDataDir = pluginDataDirFromDb(db);
  await ingestLegacyImport({ bb, db, pluginDataDir });

  const service = createAutomationService({
    bb,
    db,
    pluginDataDir,
    serverUrl: resolveServerUrl(),
  });

  bb.rpc.register(automationRpcContract, createRpcHandlers(service));
  registerAutomationCli({ bb, service });

  bb.events.on("thread.idle", ({ thread }) => {
    closeAutomationRunForSettledThread(bb, db, {
      threadId: thread.id,
      status: "idle",
    });
  });
  bb.events.on("thread.failed", ({ thread, error }) => {
    closeAutomationRunForSettledThread(bb, db, {
      threadId: thread.id,
      status: "failed",
      error,
    });
  });

  bb.events.on("thread.deleted", ({ thread }) => {
    disableAutomationsForDeletedThreadEvent(bb, db, thread.id);
  });

  bb.background.service("automation-sweep", {
    async start(signal) {
      try {
        await reconcileRunningAutomationRuns(bb, db);
      } catch (error) {
        bb.log.error(
          `Automation startup reconciliation failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      while (!signal.aborted) {
        try {
          await sweepDueAutomations(bb, db, {
            pluginDataDir,
            serverUrl: resolveServerUrl(),
          });
        } catch (error) {
          bb.log.error(
            `Automation sweep failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        await sleep(SWEEP_INTERVAL_MS, signal);
      }
    },
  });
}
