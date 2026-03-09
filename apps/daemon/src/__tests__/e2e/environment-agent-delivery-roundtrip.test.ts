import { afterEach, describe, expect, it } from "vitest";
import type {
  EnvironmentAgentDeliveryRequest,
} from "@beanbag/environment-agent";
import {
  startDaemonE2eHarness,
  type DaemonE2eHarness,
} from "./harness.js";
import {
  createProject,
  createThread,
  deliverEnvironmentAgentEvents,
  listThreadEvents,
  readError,
  waitForThreadStatus,
} from "./environment-agent-api.js";

describe.sequential("e2e: environment-agent delivery", () => {
  let harness: DaemonE2eHarness | undefined;

  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
      harness = undefined;
    }
  });

  it(
    "accepts authenticated delivery, updates thread state, and ignores duplicate sequences",
    async () => {
      harness = await startDaemonE2eHarness();

      const project = await createProject(harness.baseUrl, harness.projectRoot);
      const thread = await createThread(harness.baseUrl, project.id);
      await waitForThreadStatus(harness.baseUrl, thread.id, "idle");

      const authorization = harness.getEnvironmentAgentAuthorization(thread.id);
      expect(authorization).toMatch(/^Bearer /);

      const nextSequence = harness.getEnvironmentAgentCursor(thread.id) + 1;
      const initialEvents = await listThreadEvents(harness.baseUrl, thread.id);
      const initialTurnStartedCount = initialEvents.filter(
        (event) => event.type === "turn/started",
      ).length;
      const initialTurnCompletedCount = initialEvents.filter(
        (event) => event.type === "turn/completed",
      ).length;

      const turnStartedDelivery: EnvironmentAgentDeliveryRequest = {
        protocolVersion: 1,
        threadId: thread.id,
        events: [
          {
            protocolVersion: 1,
            sequence: nextSequence,
            emittedAt: 1_000 + nextSequence,
            threadId: thread.id,
            event: {
              type: "provider.event",
              threadId: thread.id,
              method: "turn/started",
              payload: { turnId: "turn-e2e" },
            },
          },
        ],
      };

      const delivered = await deliverEnvironmentAgentEvents(
        harness.baseUrl,
        thread.id,
        authorization!,
        turnStartedDelivery,
      );
      expect(delivered.acknowledgedSequence).toBe(nextSequence);

      await waitForThreadStatus(harness.baseUrl, thread.id, "active");
      const afterStartedEvents = await listThreadEvents(harness.baseUrl, thread.id);
      expect(
        afterStartedEvents.filter((event) => event.type === "turn/started"),
      ).toHaveLength(initialTurnStartedCount + 1);

      const duplicate = await deliverEnvironmentAgentEvents(
        harness.baseUrl,
        thread.id,
        authorization!,
        turnStartedDelivery,
      );
      expect(duplicate.acknowledgedSequence).toBe(nextSequence);

      const afterDuplicateEvents = await listThreadEvents(harness.baseUrl, thread.id);
      expect(
        afterDuplicateEvents.filter((event) => event.type === "turn/started"),
      ).toHaveLength(initialTurnStartedCount + 1);

      const turnCompletedDelivery: EnvironmentAgentDeliveryRequest = {
        protocolVersion: 1,
        threadId: thread.id,
        events: [
          {
            protocolVersion: 1,
            sequence: nextSequence + 1,
            emittedAt: 1_001 + nextSequence,
            threadId: thread.id,
            event: {
              type: "provider.event",
              threadId: thread.id,
              method: "turn/completed",
              payload: { turnId: "turn-e2e" },
            },
          },
        ],
      };

      const completed = await deliverEnvironmentAgentEvents(
        harness.baseUrl,
        thread.id,
        authorization!,
        turnCompletedDelivery,
      );
      expect(completed.acknowledgedSequence).toBe(nextSequence + 1);

      await waitForThreadStatus(harness.baseUrl, thread.id, "idle");
      const finalEvents = await listThreadEvents(harness.baseUrl, thread.id);
      expect(
        finalEvents.filter((event) => event.type === "turn/completed"),
      ).toHaveLength(initialTurnCompletedCount + 1);
    },
    15_000,
  );

  it("rejects unauthorized or gapped delivery without mutating state", async () => {
    harness = await startDaemonE2eHarness();

    const project = await createProject(
      harness.baseUrl,
      harness.projectRoot,
      "e2e-env-agent-delivery-errors-project",
    );
    const thread = await createThread(
      harness.baseUrl,
      project.id,
      "Prepare a thread for environment-agent delivery failure cases.",
    );
    await waitForThreadStatus(harness.baseUrl, thread.id, "idle");

    const authorization = harness.getEnvironmentAgentAuthorization(thread.id);
    expect(authorization).toMatch(/^Bearer /);

    const initialCursor = harness.getEnvironmentAgentCursor(thread.id);
    const unauthorizedBody: EnvironmentAgentDeliveryRequest = {
      protocolVersion: 1,
      threadId: thread.id,
      events: [
        {
          protocolVersion: 1,
          sequence: initialCursor + 1,
          emittedAt: 2_000,
          threadId: thread.id,
          event: {
            type: "provider.event",
            threadId: thread.id,
            method: "turn/started",
            payload: { turnId: "turn-unauthorized" },
          },
        },
      ],
    };

    const unauthorized = await readError(
      `${harness.baseUrl}/api/v1/threads/${thread.id}/environment-agent/deliver`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: "Bearer wrong-token",
        },
        body: JSON.stringify(unauthorizedBody),
      },
    );
    expect(unauthorized.status).toBe(400);
    expect(unauthorized.body).toContain("Unauthorized environment-agent delivery");
    expect(harness.getEnvironmentAgentCursor(thread.id)).toBe(initialCursor);

    const gappedBody: EnvironmentAgentDeliveryRequest = {
      protocolVersion: 1,
      threadId: thread.id,
      events: [
        {
          protocolVersion: 1,
          sequence: initialCursor + 2,
          emittedAt: 2_001,
          threadId: thread.id,
          event: {
            type: "provider.event",
            threadId: thread.id,
            method: "turn/completed",
            payload: { turnId: "turn-gap" },
          },
        },
      ],
    };
    const gapped = await deliverEnvironmentAgentEvents(
      harness.baseUrl,
      thread.id,
      authorization!,
      gappedBody,
    );

    expect(gapped.acknowledgedSequence).toBe(initialCursor);
    expect(harness.getEnvironmentAgentCursor(thread.id)).toBe(initialCursor);
    await waitForThreadStatus(harness.baseUrl, thread.id, "idle");

    const events = await listThreadEvents(harness.baseUrl, thread.id);
    expect(
      events.some(
        (event) =>
          event.type === "turn/started" &&
          typeof (event.data as { turnId?: unknown } | undefined)?.turnId === "string" &&
          (event.data as { turnId?: string }).turnId === "turn-unauthorized",
      ),
    ).toBe(false);
  });
});
