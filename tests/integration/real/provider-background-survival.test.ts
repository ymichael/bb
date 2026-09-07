import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scaleTimeoutMs } from "../helpers/time.js";
import {
  createRealThread,
  pathExists,
  REAL_POLL_INTERVAL_MS,
  sendAndWaitForIdle,
} from "./provider-smoke-harness.js";

const PROVIDER_ID = "claude-code";
const BACKGROUND_SURVIVAL_TEST_TIMEOUT_MS = scaleTimeoutMs(240_000);

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, REAL_POLL_INTERVAL_MS));
  }
  throw new Error(message);
}

describe("real Claude background process integration", () => {
  it(
    "survives a same-daemon session reconnect and follow-up",
    async () => {
      const { environment, harness, thread } = await createRealThread({
        providerId: PROVIDER_ID,
        workspace: { path: null, type: "unmanaged" },
      });

      try {
        if (!environment.path) {
          throw new Error("Expected an unmanaged workspace path");
        }
        const markerPath = path.join(
          environment.path,
          "background-survived-reconnect.txt",
        );

        await sendAndWaitForIdle({
          harness,
          providerId: PROVIDER_ID,
          threadId: thread.id,
          text: `Use the Bash tool exactly once to execute this exact command: sleep 40; printf survived > ${JSON.stringify(markerPath)}. Set Bash's run_in_background parameter to true. As soon as Bash accepts it, reply exactly STARTED. Do not poll it, wait for it, or use another tool.`,
        });
        expect(await pathExists(markerPath)).toBe(false);

        await new Promise((resolve) => setTimeout(resolve, 12_000));
        expect(await pathExists(markerPath)).toBe(false);

        const runtimeBeforeReconnect = harness.daemonApp.runtimeManager.get(
          environment.id,
        )?.runtime;
        const previousSessionId = harness.daemonApp.connection.sessionId;
        if (!runtimeBeforeReconnect || !previousSessionId) {
          throw new Error("Expected a live runtime and daemon session");
        }

        harness.daemonApp.connection.handleSessionInvalidated({
          code: "inactive_session",
          observedSessionId: previousSessionId,
          source: "postEvents",
        });
        await waitForCondition(
          () => {
            const sessionId = harness.daemonApp.connection.sessionId;
            return (
              sessionId !== null &&
              sessionId !== previousSessionId &&
              harness.hub.getDaemonSessionIdForHost(harness.hostId) ===
                sessionId
            );
          },
          10_000,
          "Daemon did not register the replacement session socket",
        );

        expect(
          harness.daemonApp.runtimeManager.get(environment.id)?.runtime,
        ).toBe(runtimeBeforeReconnect);

        await sendAndWaitForIdle({
          harness,
          providerId: PROVIDER_ID,
          threadId: thread.id,
          text: "Reply exactly FOLLOWUP. Do not use any tools.",
        });
        await waitForCondition(
          () => pathExists(markerPath),
          45_000,
          "Background command did not write its marker after reconnect",
        );

        expect(await fs.readFile(markerPath, "utf8")).toBe("survived");
      } finally {
        await harness.cleanup();
      }
    },
    BACKGROUND_SURVIVAL_TEST_TIMEOUT_MS,
  );
});
