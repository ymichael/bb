import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getThreadEvents,
  getThreadOutput,
  sendTextMessage,
} from "../../helpers/api.js";
import { waitForThreadStatus } from "../../helpers/assertions.js";
import {
  createProjectFixture,
  createReadyHostThread,
  createReadyReuseThread,
} from "../../helpers/fixtures.js";
import { withHarness } from "../../helpers/harness.js";
import { createTestGitRepo } from "../../helpers/seed.js";
import {
  assertEventsBelongToThread,
  CONCURRENT_DELAY_TEXT,
  DEFAULT_TIMEOUT_MS,
  TURN_TIMEOUT_MS,
} from "./shared.js";

describe.sequential("fake provider provider-isolation multi-thread integration", () => {
  it("keeps provider processes isolated for different providers in one environment", async () => {
    await withHarness(async (harness) => {
      const project = await createProjectFixture(harness, {
        name: "Shared Environment Different Providers",
      });
      const threadA = await createReadyHostThread(harness, {
        projectId: project.id,
        providerId: "fake-alpha",
        timeoutMs: DEFAULT_TIMEOUT_MS,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });
      const threadB = await createReadyReuseThread(harness, {
        environmentId: threadA.environment.id,
        projectId: project.id,
        providerId: "fake-beta",
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });

      await Promise.all([
        sendTextMessage(harness.api, threadA.thread.id, {
          text: `${CONCURRENT_DELAY_TEXT} alpha`,
        }),
        sendTextMessage(harness.api, threadB.thread.id, {
          text: `${CONCURRENT_DELAY_TEXT} beta`,
        }),
      ]);
      await Promise.all([
        waitForThreadStatus(
          harness.api,
          threadA.thread.id,
          "idle",
          TURN_TIMEOUT_MS,
        ),
        waitForThreadStatus(
          harness.api,
          threadB.thread.id,
          "idle",
          TURN_TIMEOUT_MS,
        ),
      ]);

      const runtimeEntry = harness.daemonApp.runtimeManager.get(
        threadA.environment.id,
      );
      const runningProviders =
        runtimeEntry?.runtime.listRunningProviders().sort() ?? [];
      expect(runningProviders).toEqual(["fake-alpha", "fake-beta"]);

      const eventsA = await getThreadEvents(harness.api, threadA.thread.id);
      const eventsB = await getThreadEvents(harness.api, threadB.thread.id);
      assertEventsBelongToThread(eventsA, threadA.thread.id);
      assertEventsBelongToThread(eventsB, threadB.thread.id);
      expect(await getThreadOutput(harness.api, threadA.thread.id)).toContain(
        "alpha",
      );
      expect(await getThreadOutput(harness.api, threadB.thread.id)).toContain(
        "beta",
      );
    });
  });

  it("handles three concurrent threads across shared and isolated environments", () =>
    withHarness(async (harness) => {
      const secondRepoDir = await createTestGitRepo({
        repoDir: path.join(path.dirname(harness.repoDir), "stress-project"),
      });
      const projectA = await createProjectFixture(harness, {
        name: "Stress Shared Environment",
      });
      const projectB = await createProjectFixture(harness, {
        name: "Stress Isolated Environment",
        path: secondRepoDir,
      });
      const threadA = await createReadyHostThread(harness, {
        projectId: projectA.id,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });
      const threadB = await createReadyReuseThread(harness, {
        environmentId: threadA.environment.id,
        projectId: projectA.id,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      const threadC = await createReadyHostThread(harness, {
        projectId: projectB.id,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        workspace: {
          type: "unmanaged",
          path: secondRepoDir,
        },
      });

      await Promise.all([
        sendTextMessage(harness.api, threadA.thread.id, {
          text: `${CONCURRENT_DELAY_TEXT} stress-a`,
        }),
        sendTextMessage(harness.api, threadB.thread.id, {
          text: `${CONCURRENT_DELAY_TEXT} stress-b`,
        }),
        sendTextMessage(harness.api, threadC.thread.id, {
          text: `${CONCURRENT_DELAY_TEXT} stress-c`,
        }),
      ]);
      await Promise.all([
        waitForThreadStatus(
          harness.api,
          threadA.thread.id,
          "idle",
          TURN_TIMEOUT_MS,
        ),
        waitForThreadStatus(
          harness.api,
          threadB.thread.id,
          "idle",
          TURN_TIMEOUT_MS,
        ),
        waitForThreadStatus(
          harness.api,
          threadC.thread.id,
          "idle",
          TURN_TIMEOUT_MS,
        ),
      ]);

      assertEventsBelongToThread(
        await getThreadEvents(harness.api, threadA.thread.id),
        threadA.thread.id,
      );
      assertEventsBelongToThread(
        await getThreadEvents(harness.api, threadB.thread.id),
        threadB.thread.id,
      );
      assertEventsBelongToThread(
        await getThreadEvents(harness.api, threadC.thread.id),
        threadC.thread.id,
      );
      expect(await getThreadOutput(harness.api, threadC.thread.id)).toContain(
        "stress-c",
      );
    }));
});
