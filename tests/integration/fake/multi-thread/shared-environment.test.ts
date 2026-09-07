import { describe, expect, it } from "vitest";
import {
  archiveThread,
  getEnvironment,
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
import {
  ACTIVE_TIMEOUT_MS,
  assertEventsBelongToThread,
  CONCURRENT_DELAY_TEXT,
  countTurnEvents,
  DEFAULT_TIMEOUT_MS,
  TURN_TIMEOUT_MS,
} from "./shared.js";

describe.sequential("fake provider shared-environment multi-thread integration", () => {
  it("runs two threads in the same environment without cross-contaminating events", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(harness, {
        name: "Shared Environment Same Provider",
      });
      const threadA = await createReadyHostThread(harness, {
        projectId: project.id,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });
      const threadB = await createReadyReuseThread(harness, {
        environmentId: threadA.environment.id,
        projectId: project.id,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      const baselineEventsA = await getThreadEvents(
        harness.api,
        threadA.thread.id,
      );
      const baselineEventsB = await getThreadEvents(
        harness.api,
        threadB.thread.id,
      );
      const baselineCompletedA = countTurnEvents(
        baselineEventsA,
        "turn/completed",
      );
      const baselineCompletedB = countTurnEvents(
        baselineEventsB,
        "turn/completed",
      );

      await Promise.all([
        sendTextMessage(harness.api, threadA.thread.id, {
          text: `${CONCURRENT_DELAY_TEXT} shared-a`,
        }),
        sendTextMessage(harness.api, threadB.thread.id, {
          text: `${CONCURRENT_DELAY_TEXT} shared-b`,
        }),
      ]);

      await Promise.all([
        waitForThreadStatus(
          harness.api,
          threadA.thread.id,
          "active",
          ACTIVE_TIMEOUT_MS,
        ),
        waitForThreadStatus(
          harness.api,
          threadB.thread.id,
          "active",
          ACTIVE_TIMEOUT_MS,
        ),
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

      const eventsA = await getThreadEvents(harness.api, threadA.thread.id);
      const eventsB = await getThreadEvents(harness.api, threadB.thread.id);
      assertEventsBelongToThread(eventsA, threadA.thread.id);
      assertEventsBelongToThread(eventsB, threadB.thread.id);
      expect(countTurnEvents(eventsA, "turn/completed")).toBe(
        baselineCompletedA + 1,
      );
      expect(countTurnEvents(eventsB, "turn/completed")).toBe(
        baselineCompletedB + 1,
      );

      const outputA = await getThreadOutput(harness.api, threadA.thread.id);
      const outputB = await getThreadOutput(harness.api, threadB.thread.id);
      expect(outputA).toContain("shared-a");
      expect(outputB).toContain("shared-b");
    }));

  it("supports sequential follow-ups for two sibling threads in one environment", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(harness, {
        name: "Shared Environment Follow Ups",
      });
      const threadA = await createReadyHostThread(harness, {
        projectId: project.id,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });
      const threadB = await createReadyReuseThread(harness, {
        environmentId: threadA.environment.id,
        projectId: project.id,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      const baselineEventsA = await getThreadEvents(
        harness.api,
        threadA.thread.id,
      );
      const baselineEventsB = await getThreadEvents(
        harness.api,
        threadB.thread.id,
      );
      const baselineStartedA = countTurnEvents(baselineEventsA, "turn/started");
      const baselineCompletedA = countTurnEvents(
        baselineEventsA,
        "turn/completed",
      );
      const baselineStartedB = countTurnEvents(baselineEventsB, "turn/started");
      const baselineCompletedB = countTurnEvents(
        baselineEventsB,
        "turn/completed",
      );

      await sendTextMessage(harness.api, threadA.thread.id, {
        text: "thread-a first",
      });
      await waitForThreadStatus(
        harness.api,
        threadA.thread.id,
        "idle",
        TURN_TIMEOUT_MS,
      );

      await sendTextMessage(harness.api, threadB.thread.id, {
        text: "thread-b first",
      });
      await waitForThreadStatus(
        harness.api,
        threadB.thread.id,
        "idle",
        TURN_TIMEOUT_MS,
      );

      await sendTextMessage(harness.api, threadA.thread.id, {
        mode: "auto",
        text: "thread-a second",
      });
      await waitForThreadStatus(
        harness.api,
        threadA.thread.id,
        "idle",
        TURN_TIMEOUT_MS,
      );

      await sendTextMessage(harness.api, threadB.thread.id, {
        mode: "auto",
        text: "thread-b second",
      });
      await waitForThreadStatus(
        harness.api,
        threadB.thread.id,
        "idle",
        TURN_TIMEOUT_MS,
      );

      const eventsA = await getThreadEvents(harness.api, threadA.thread.id);
      const eventsB = await getThreadEvents(harness.api, threadB.thread.id);
      assertEventsBelongToThread(eventsA, threadA.thread.id);
      assertEventsBelongToThread(eventsB, threadB.thread.id);
      expect(countTurnEvents(eventsA, "turn/started")).toBe(
        baselineStartedA + 2,
      );
      expect(countTurnEvents(eventsA, "turn/completed")).toBe(
        baselineCompletedA + 2,
      );
      expect(countTurnEvents(eventsB, "turn/started")).toBe(
        baselineStartedB + 2,
      );
      expect(countTurnEvents(eventsB, "turn/completed")).toBe(
        baselineCompletedB + 2,
      );
    }));

  it("keeps a shared environment alive while one sibling remains unarchived", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(harness, {
        name: "Archive One Sibling",
      });
      const threadA = await createReadyHostThread(harness, {
        projectId: project.id,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });
      const threadB = await createReadyReuseThread(harness, {
        environmentId: threadA.environment.id,
        projectId: project.id,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });

      await Promise.all([
        sendTextMessage(harness.api, threadA.thread.id, {
          text: "archive-a seed",
        }),
        sendTextMessage(harness.api, threadB.thread.id, {
          text: "archive-b seed",
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

      await archiveThread(harness.api, threadA.thread.id);
      await sendTextMessage(harness.api, threadB.thread.id, {
        text: "thread-b still works",
      });
      await waitForThreadStatus(
        harness.api,
        threadB.thread.id,
        "idle",
        TURN_TIMEOUT_MS,
      );

      const environment = await getEnvironment(
        harness.api,
        threadA.environment.id,
      );
      expect(environment.status).toBe("ready");
      expect(await getThreadOutput(harness.api, threadB.thread.id)).toContain(
        "thread-b still works",
      );
    }));
});
