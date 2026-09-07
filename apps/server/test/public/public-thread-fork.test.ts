import {
  createProjectSource,
  ensurePersonalProject,
  getEnvironment,
  getThread,
  listEvents,
  setQueuedThreadMessageGroupBoundary,
} from "@bb/db";
import {
  PERSONAL_PROJECT_ID,
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnRequestEventDataSchema,
  turnScope,
  type ClientTurnRequestId,
  type PromptInput,
} from "@bb/domain";
import {
  threadResponseSchema,
  threadTimelineResponseSchema,
} from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { appendClientTurnEventInTransaction } from "../../src/services/threads/thread-events.js";
import { sendQueuedMessage } from "../../src/services/threads/queued-messages.js";
import { sendThreadMessage } from "../../src/services/threads/thread-send.js";
import {
  listQueuedCommands,
  listQueuedThreadCommands,
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
  waitForQueuedCommandAfter,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function seedForkSource(
  harness: TestAppHarness,
  args: {
    model?: string;
    permissionMode?: "accept-edits" | "auto" | "full";
    reasoningLevel?: string;
    serviceTier?: string;
  } = {},
) {
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/public-thread-fork",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/public-thread-fork",
  });
  const sourceThread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    ...(args.model === undefined ? {} : { model: args.model }),
    permissionMode: args.permissionMode ?? "full",
    providerThreadId: "provider-fork-source",
    ...(args.reasoningLevel === undefined
      ? {}
      : { reasoningLevel: args.reasoningLevel }),
    ...(args.serviceTier === undefined
      ? {}
      : { serviceTier: args.serviceTier }),
    threadId: sourceThread.id,
  });
  seedTurnStarted(harness.deps, {
    environmentId: environment.id,
    providerThreadId: "provider-fork-source",
    sequence: 3,
    threadId: sourceThread.id,
    turnId: "turn-fork-source",
  });
  return { environment, host, project, sourceThread };
}

function seedPersonalDirectoryForkSource(harness: TestAppHarness) {
  const { host } = seedHostSession(harness.deps);
  ensurePersonalProject(harness.db);
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    path: "/tmp/personal-switched-directory",
    projectId: PERSONAL_PROJECT_ID,
    workspaceProvisionType: "unmanaged",
  });
  const sourceThread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: PERSONAL_PROJECT_ID,
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    permissionMode: "full",
    providerThreadId: "provider-personal-directory-source",
    threadId: sourceThread.id,
  });
  seedTurnStarted(harness.deps, {
    environmentId: environment.id,
    providerThreadId: "provider-personal-directory-source",
    sequence: 3,
    threadId: sourceThread.id,
    turnId: "turn-personal-directory-source",
  });
  return { environment, sourceThread };
}

async function postFork(
  harness: TestAppHarness,
  body: Record<string, unknown>,
) {
  return harness.app.request("/api/v1/threads/fork", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createIdleSeededFork(
  harness: TestAppHarness,
  args: {
    providerThreadId: string;
    seed: PromptInput & { visibility: "agent-only" };
  },
) {
  const { sourceThread } = seedForkSource(harness);
  const response = await postFork(harness, {
    sourceThreadId: sourceThread.id,
    agentContextSeed: [args.seed],
  });
  expect(response.status).toBe(201);
  const fork = threadResponseSchema.parse(await readJson(response));
  const start = await waitForQueuedCommand(
    harness,
    ({ command }) =>
      command.type === "thread.start" && command.threadId === fork.id,
  );
  if (start.command.type !== "thread.start") {
    throw new Error("Expected thread.start");
  }
  expect(start.command.input).toEqual([]);
  await reportQueuedCommandSuccess(harness, start, {
    providerThreadId: args.providerThreadId,
  });
  const thread = getThread(harness.db, fork.id);
  const environment = thread?.environmentId
    ? getEnvironment(harness.db, thread.environmentId)
    : null;
  if (!thread || !environment) {
    throw new Error("Expected fork environment");
  }
  return { environment, fork, sourceThread, start, thread };
}

describe("public thread fork route", () => {
  it("rejects the removed workspace selector", async () => {
    await withTestHarness(async (harness) => {
      const { sourceThread } = seedForkSource(harness);

      const response = await postFork(harness, {
        sourceThreadId: sourceThread.id,
        workspace: "isolated",
      });

      expect(response.status).toBe(400);
    });
  });

  it("reuses a switched directory from a personal-project source", async () => {
    await withTestHarness(async (harness) => {
      const { environment, sourceThread } =
        seedPersonalDirectoryForkSource(harness);

      const response = await postFork(harness, {
        sourceThreadId: sourceThread.id,
      });

      expect(response.status).toBe(201);
      const fork = threadResponseSchema.parse(await readJson(response));
      expect(getThread(harness.db, fork.id)?.environmentId).toBe(
        environment.id,
      );
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === fork.id,
      );
      if (queued.command.type !== "thread.start") {
        throw new Error("Expected thread.start");
      }
      expect(queued.command.fork).toEqual({
        sourceProviderThreadId: "provider-personal-directory-source",
      });
    });
  });

  it("rejects a new environment on another host before provisioning", async () => {
    await withTestHarness(async (harness) => {
      const { environment, project, sourceThread } = seedForkSource(harness);
      const { host: otherHost } = seedHostSession(harness.deps, {
        id: "host-other",
        name: "Other Host",
      });
      createProjectSource(harness.db, harness.hub, {
        hostId: otherHost.id,
        path: "/tmp/public-thread-fork-other",
        projectId: project.id,
        type: "local_path",
      });

      const response = await postFork(harness, {
        sourceThreadId: sourceThread.id,
        environment: {
          type: "host",
          hostId: otherHost.id,
          workspace: {
            type: "managed-worktree",
            baseBranch: { kind: "default" },
          },
        },
      });

      expect(response.status).toBe(400);
      expect(await readJson(response)).toMatchObject({
        code: "invalid_request",
        message: `Fork environment must use the source thread's host (${environment.hostId}), not ${otherHost.id}`,
      });
      expect(listQueuedCommands(harness, "environment.provision")).toEqual([]);
    });
  });

  it("reuses a requested environment on the source host", async () => {
    await withTestHarness(async (harness) => {
      const { host, project, sourceThread } = seedForkSource(harness);
      const targetEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/tmp/public-thread-fork-target",
        projectId: project.id,
      });

      const response = await postFork(harness, {
        sourceThreadId: sourceThread.id,
        environment: {
          type: "reuse",
          environmentId: targetEnvironment.id,
        },
      });

      expect(response.status).toBe(201);
      const fork = threadResponseSchema.parse(await readJson(response));
      expect(getThread(harness.db, fork.id)?.environmentId).toBe(
        targetEnvironment.id,
      );
    });
  });

  it("creates a requested personal environment after a directory switch", async () => {
    await withTestHarness(async (harness) => {
      const { environment, sourceThread } =
        seedPersonalDirectoryForkSource(harness);

      const response = await postFork(harness, {
        sourceThreadId: sourceThread.id,
        environment: {
          type: "host",
          hostId: environment.hostId,
          workspace: { type: "personal" },
        },
      });

      expect(response.status).toBe(201);
      const fork = threadResponseSchema.parse(await readJson(response));
      expect(getThread(harness.db, fork.id)?.environmentId).not.toBe(
        environment.id,
      );
      const personalEnvironment = getThread(harness.db, fork.id)?.environmentId;
      expect(personalEnvironment).not.toBeNull();
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.provision" &&
          command.environmentId === personalEnvironment,
      );
      if (queued.command.type !== "environment.provision") {
        throw new Error("Expected personal environment.provision");
      }
      expect(queued.command.workspaceProvisionType).toBe("personal");
      if (queued.command.workspaceProvisionType !== "personal") {
        throw new Error("Expected personal environment.provision");
      }
      await reportQueuedCommandSuccess(harness, queued, {
        path: queued.command.targetPath,
        branchName: "main",
        defaultBranch: "main",
        isGitRepo: false,
        isWorktree: false,
        transcript: [],
      });

      const start = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === fork.id,
      );
      if (start.command.type !== "thread.start") {
        throw new Error("Expected thread.start");
      }
      expect(start.command.fork).toEqual({
        sourceProviderThreadId: "provider-personal-directory-source",
      });
    });
  });

  it("creates an idle fork at the source tip with no first run", async () => {
    await withTestHarness(async (harness) => {
      const { sourceThread } = seedForkSource(harness);

      const response = await postFork(harness, {
        sourceThreadId: sourceThread.id,
      });

      expect(response.status).toBe(201);
      const fork = threadResponseSchema.parse(await readJson(response));
      expect(fork).toMatchObject({
        originKind: "fork",
        sourceThreadId: sourceThread.id,
        visibility: "visible",
      });
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === fork.id,
      );
      if (queued.command.type !== "thread.start") {
        throw new Error("Expected thread.start");
      }
      expect(queued.command.input).toEqual([]);
      expect(queued.command.fork).toEqual({
        sourceProviderThreadId: "provider-fork-source",
      });
    });
  });

  it("runs optional input from the requested fork point", async () => {
    await withTestHarness(async (harness) => {
      const { environment, sourceThread } = seedForkSource(harness);
      seedEvent(harness.deps, {
        environmentId: environment.id,
        providerThreadId: "provider-fork-source",
        sequence: 4,
        threadId: sourceThread.id,
        type: "turn/completed",
        scope: turnScope("turn-fork-source"),
        data: {
          providerThreadId: "provider-fork-source",
          status: "completed",
          providerCheckpointId: "checkpoint-fork-source",
        },
      });
      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        providerThreadId: "provider-later-source",
        sequence: 8,
        threadId: sourceThread.id,
        turnId: "turn-later-source",
      });
      const input = [
        { type: "text" as const, text: "Continue here", mentions: [] },
      ];

      const response = await postFork(harness, {
        sourceThreadId: sourceThread.id,
        sourceSeqEnd: 3,
        input,
      });

      expect(response.status).toBe(201);
      const fork = threadResponseSchema.parse(await readJson(response));
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === fork.id,
      );
      if (queued.command.type !== "thread.start") {
        throw new Error("Expected thread.start");
      }
      expect(queued.command.input).toEqual(input);
      expect(queued.command.fork).toEqual({
        sourceProviderThreadId: "provider-fork-source",
        sourceProviderCheckpointId: "checkpoint-fork-source",
      });
    });
  });

  it("persists an agent-only seed while keeping an idle fork input empty", async () => {
    await withTestHarness(async (harness) => {
      const seed = {
        type: "text" as const,
        text: "Replying to the selected earlier message",
        mentions: [],
        visibility: "agent-only" as const,
      };
      const { fork, sourceThread, start } = await createIdleSeededFork(
        harness,
        {
          seed,
          providerThreadId: "provider-seeded-fork",
        },
      );
      const requested = listEvents(harness.db, { threadId: fork.id }).find(
        (event) => event.type === "client/turn/requested",
      );
      expect(requested).toBeDefined();
      const requestData = turnRequestEventDataSchema.parse(
        JSON.parse(requested?.data ?? "null"),
      );
      expect(requestData).toMatchObject({
        initiator: "agent",
        input: [seed],
        senderThreadId: sourceThread.id,
      });
      const firstInput = textInput("Explain the selected message");
      const sendResponse = await harness.app.request(
        `/api/v1/threads/${fork.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: firstInput,
            mode: "auto",
            permissionMode: "full",
          }),
        },
      );
      expect(sendResponse.status).toBe(200);
      const firstTurn = await waitForQueuedCommandAfter(
        harness,
        start.row.cursor,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === fork.id,
      );
      if (firstTurn.command.type !== "turn.submit") {
        throw new Error("Expected turn.submit");
      }
      expect(firstTurn.command.input).toEqual([seed, ...firstInput]);

      const requests = listEvents(harness.db, { threadId: fork.id }).filter(
        (event) => event.type === "client/turn/requested",
      );
      expect(requests).toHaveLength(2);
      expect(
        turnRequestEventDataSchema.parse(
          JSON.parse(requests[1]?.data ?? "null"),
        ).input,
      ).toEqual([seed, ...firstInput]);

      await reportQueuedCommandError(harness, firstTurn, {
        errorCode: "provider_error",
        errorMessage: "First real turn failed",
      });
      const secondInput = textInput("Try again");
      const secondResponse = await harness.app.request(
        `/api/v1/threads/${fork.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: secondInput,
            mode: "auto",
            permissionMode: "full",
          }),
        },
      );
      expect(secondResponse.status).toBe(200);
      const secondTurn = await waitForQueuedCommandAfter(
        harness,
        firstTurn.row.cursor,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === fork.id,
      );
      if (secondTurn.command.type !== "turn.submit") {
        throw new Error("Expected turn.submit");
      }
      expect(secondTurn.command.input).toEqual([seed, ...secondInput]);
    });
  });

  it("does not defer the seed to later accepted sends", async () => {
    await withTestHarness(async (harness) => {
      const seed = {
        type: "text" as const,
        text: "Replying to the selected earlier message",
        mentions: [],
        visibility: "agent-only" as const,
      };
      const { fork, start } = await createIdleSeededFork(harness, {
        seed,
        providerThreadId: "provider-started-seeded-fork",
      });
      const firstInput = textInput("Explain the selected message");
      const firstResponse = await harness.app.request(
        `/api/v1/threads/${fork.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: firstInput,
            mode: "auto",
            permissionMode: "full",
          }),
        },
      );
      expect(firstResponse.status).toBe(200);
      const firstTurn = await waitForQueuedCommandAfter(
        harness,
        start.row.cursor,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === fork.id,
      );
      if (firstTurn.command.type !== "turn.submit") {
        throw new Error("Expected turn.submit");
      }
      const lastSequence =
        listEvents(harness.db, { threadId: fork.id }).at(-1)?.sequence ?? 0;
      seedTurnStarted(harness.deps, {
        environmentId: fork.environmentId,
        providerThreadId: "provider-started-seeded-fork",
        sequence: lastSequence + 1,
        threadId: fork.id,
        turnId: "turn-started-seeded-fork",
      });
      const rapidInput = textInput("Rapid follow-up");
      const rapidResponse = await harness.app.request(
        `/api/v1/threads/${fork.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: rapidInput,
            mode: "auto",
            permissionMode: "full",
          }),
        },
      );
      expect(rapidResponse.status).toBe(200);
      const rapidTurn = await waitForQueuedCommandAfter(
        harness,
        firstTurn.row.cursor,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === fork.id,
      );
      expect(rapidTurn.command).toMatchObject({ input: rapidInput });
      await reportQueuedCommandError(harness, firstTurn, {
        errorCode: "provider_error",
        errorMessage: "Provider turn failed after starting",
      });

      const secondInput = textInput("Try again");
      const secondResponse = await harness.app.request(
        `/api/v1/threads/${fork.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: secondInput,
            mode: "auto",
            permissionMode: "full",
          }),
        },
      );
      expect(secondResponse.status).toBe(200);
      const secondTurn = await waitForQueuedCommandAfter(
        harness,
        rapidTurn.row.cursor,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === fork.id,
      );
      if (secondTurn.command.type !== "turn.submit") {
        throw new Error("Expected turn.submit");
      }
      expect(secondTurn.command.input).toEqual(secondInput);
    });
  });

  it("prepends the deferred seed to flat and grouped first-turn input", async () => {
    await withTestHarness(async (harness) => {
      const seed = {
        type: "text" as const,
        text: "Reply anchor",
        mentions: [],
        visibility: "agent-only" as const,
      };
      const { environment, fork, start, thread } = await createIdleSeededFork(
        harness,
        {
          seed,
          providerThreadId: "provider-grouped-seeded-fork",
        },
      );
      const inputGroups = [textInput("First group"), textInput("Second group")];

      await sendThreadMessage(harness.deps, {
        environment,
        payload: {
          input: [],
          inputGroups,
          mode: "start",
          permissionMode: "full",
        },
        thread,
        trigger: "user",
      });

      const turn = await waitForQueuedCommandAfter(
        harness,
        start.row.cursor,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === fork.id,
      );
      if (turn.command.type !== "turn.submit") {
        throw new Error("Expected turn.submit");
      }
      const expectedGroups = [[seed, ...inputGroups[0]!], inputGroups[1]!];
      expect(turn.command.inputGroups).toEqual(expectedGroups);
      expect(turn.command.input).toEqual([
        ...expectedGroups[0],
        { type: "text", text: "\n\n", mentions: [] },
        ...expectedGroups[1],
      ]);
      const request = listEvents(harness.db, { threadId: fork.id })
        .filter((event) => event.type === "client/turn/requested")
        .at(-1);
      const requestData = turnRequestEventDataSchema.parse(
        JSON.parse(request?.data ?? "null"),
      );
      expect(requestData.inputGroups).toEqual(expectedGroups);
      expect(requestData.input).toEqual(turn.command.input);
    });
  });

  it("prepends the deferred seed when an idle provider sends queued input", async () => {
    await withTestHarness(async (harness) => {
      const seed = {
        type: "text" as const,
        text: "Queued reply anchor",
        mentions: [],
        visibility: "agent-only" as const,
      };
      const { fork, start } = await createIdleSeededFork(harness, {
        seed,
        providerThreadId: "provider-queued-seeded-fork",
      });
      const first = seedQueuedMessage(harness.deps, {
        threadId: fork.id,
        content: textInput("First queued group"),
      });
      const second = seedQueuedMessage(harness.deps, {
        threadId: fork.id,
        content: textInput("Second queued group"),
      });
      expect(
        setQueuedThreadMessageGroupBoundary({
          db: harness.db,
          notifier: harness.hub,
          threadId: fork.id,
          expectedGroupedPrefixQueuedMessageIds: [first.id, second.id],
          groupBoundaryQueuedMessageId: second.id,
        }).kind,
      ).toBe("updated");

      await sendQueuedMessage(harness.deps, {
        claimPolicy: {
          kind: "automatic",
          isGroupEligible: () => true,
        },
        threadId: fork.id,
        queuedMessageId: first.id,
        mode: "auto",
      });

      const turn = await waitForQueuedCommandAfter(
        harness,
        start.row.cursor,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === fork.id,
      );
      if (turn.command.type !== "turn.submit") {
        throw new Error("Expected turn.submit");
      }
      expect(turn.command.inputGroups?.[0]).toEqual([
        seed,
        ...textInput("First queued group"),
      ]);
      expect(turn.command.input[0]).toEqual(seed);
      const request = listEvents(harness.db, { threadId: fork.id })
        .filter((event) => event.type === "client/turn/requested")
        .at(-1);
      const requestData = turnRequestEventDataSchema.parse(
        JSON.parse(request?.data ?? "null"),
      );
      expect(requestData.input).toEqual(turn.command.input);
      expect(requestData.inputGroups).toEqual(turn.command.inputGroups);
    });
  });

  it("rejects a stale prepared seed when another first turn wins the transaction", async () => {
    await withTestHarness(async (harness) => {
      const seed = {
        type: "text" as const,
        text: "Concurrent reply anchor",
        mentions: [],
        visibility: "agent-only" as const,
      };
      const { environment, fork, thread } = await createIdleSeededFork(
        harness,
        {
          seed,
          providerThreadId: "provider-concurrent-seeded-fork",
        },
      );

      await expect(
        sendThreadMessage(harness.deps, {
          beforeAppendInTransaction: ({ tx }) => {
            appendClientTurnEventInTransaction(tx, {
              environmentId: thread.environmentId,
              execution: {
                model: "gpt-5",
                permissionMode: "full",
                reasoningLevel: "medium",
                serviceTier: "default",
                source: "client/turn/requested",
              },
              initiator: "user",
              input: textInput("Winning concurrent turn"),
              requestMethod: "turn/start",
              senderThreadId: null,
              source: "tell",
              target: { kind: "new-turn" },
              threadId: thread.id,
              type: "client/turn/requested",
            });
          },
          environment,
          payload: {
            input: textInput("Losing concurrent turn"),
            mode: "start",
            permissionMode: "full",
          },
          thread,
          trigger: "user",
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        listQueuedThreadCommands(harness, "turn.submit", fork.id),
      ).toHaveLength(0);
    });
  });

  it("inherits the source thread effective permission mode by default", async () => {
    await withTestHarness(async (harness) => {
      const { sourceThread } = seedForkSource(harness, {
        permissionMode: "accept-edits",
      });

      const response = await postFork(harness, {
        sourceThreadId: sourceThread.id,
      });

      expect(response.status).toBe(201);
      const fork = threadResponseSchema.parse(await readJson(response));
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === fork.id,
      );
      if (queued.command.type !== "thread.start") {
        throw new Error("Expected thread.start");
      }
      expect(queued.command.options.permissionMode).toBe("accept-edits");
    });
  });

  it("inherits the source's recorded model, reasoning level, and service tier", async () => {
    await withTestHarness(async (harness) => {
      const { sourceThread } = seedForkSource(harness, {
        model: "gpt-5-mini",
        reasoningLevel: "high",
        serviceTier: "fast",
      });

      const response = await postFork(harness, {
        sourceThreadId: sourceThread.id,
      });

      expect(response.status).toBe(201);
      const fork = threadResponseSchema.parse(await readJson(response));
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === fork.id,
      );
      if (queued.command.type !== "thread.start") {
        throw new Error("Expected thread.start");
      }
      expect(queued.command.options).toMatchObject({
        model: "gpt-5-mini",
        reasoningLevel: "high",
        serviceTier: "fast",
      });
    });
  });

  it("forks an ACP provider that declares it and uses the returned child session", async () => {
    await withTestHarness({}, async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const sourceThread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        providerId: "acp-opencode",
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        model: "acp-default",
        providerThreadId: "provider-acp-source",
        threadId: sourceThread.id,
      });
      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        providerThreadId: "provider-acp-source",
        sequence: 3,
        threadId: sourceThread.id,
        turnId: "turn-acp-source",
      });

      const response = await postFork(harness, {
        sourceThreadId: sourceThread.id,
      });

      expect(response.status).toBe(201);
      const fork = threadResponseSchema.parse(await readJson(response));
      const start = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === fork.id,
      );
      if (start.command.type !== "thread.start") {
        throw new Error("Expected thread.start");
      }
      expect(start.command).toMatchObject({
        providerId: "acp-opencode",
        bridgeLaunch: {
          providerOptions: {
            acpLaunchSpec: { command: "opencode", args: ["acp"] },
          },
        },
        fork: {
          sourceProviderThreadId: "provider-acp-source",
        },
      });

      await reportQueuedCommandSuccess(harness, start, {
        providerThreadId: "provider-acp-child",
      });
      expect(
        listEvents(harness.db, { threadId: fork.id }).some(
          (event) => event.providerThreadId === "provider-acp-child",
        ),
      ).toBe(true);

      const sendResponse = await harness.app.request(
        `/api/v1/threads/${fork.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: [{ type: "text", text: "Continue the fork" }],
            mode: "auto",
            permissionMode: "full",
          }),
        },
      );
      expect(sendResponse.status).toBe(200);
      const turn = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === fork.id,
      );
      expect(turn.command).toMatchObject({
        resumeContext: { providerThreadId: "provider-acp-child" },
      });
    });
  });
});

const HISTORY_PROVIDER_THREAD_ID = "provider-history-source";

function seedHistoryUserRequest(
  harness: TestAppHarness,
  args: {
    environmentId: string;
    requestId: ClientTurnRequestId;
    sequence: number;
    text: string;
    threadId: string;
  },
): void {
  seedEvent(harness.deps, {
    environmentId: args.environmentId,
    sequence: args.sequence,
    threadId: args.threadId,
    type: "client/turn/requested",
    scope: threadScope(),
    data: {
      direction: "outbound",
      requestId: args.requestId,
      input: [{ type: "text", text: args.text }],
      target: { kind: "new-turn" },
      execution: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        permissionMode: "full",
        source: "client/turn/requested",
      },
      initiator: "user",
      senderThreadId: null,
      request: { method: "turn/start", params: {} },
      source: "tell",
    },
  });
}

function seedConversationForkSource(
  harness: TestAppHarness,
  args: { providerId?: string; runningThirdTurn?: boolean } = {},
) {
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/public-thread-fork-history",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/public-thread-fork-history",
  });
  const sourceThread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    ...(args.providerId === undefined ? {} : { providerId: args.providerId }),
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    inputText: "Reply only with ok.",
    permissionMode: "full",
    providerThreadId: HISTORY_PROVIDER_THREAD_ID,
    threadId: sourceThread.id,
  });
  const base = {
    environmentId: environment.id,
    providerThreadId: HISTORY_PROVIDER_THREAD_ID,
    threadId: sourceThread.id,
  };
  const firstRequestId = encodeClientTurnRequestIdNumber({ value: 1 });
  const secondRequestId = encodeClientTurnRequestIdNumber({ value: 2 });
  const thirdRequestId = encodeClientTurnRequestIdNumber({ value: 3 });
  seedTurnStarted(harness.deps, { ...base, sequence: 3, turnId: "turn-1" });
  seedEvent(harness.deps, {
    ...base,
    sequence: 4,
    type: "turn/input/accepted",
    scope: turnScope("turn-1"),
    data: {
      providerThreadId: HISTORY_PROVIDER_THREAD_ID,
      clientRequestId: firstRequestId,
    },
  });
  seedEvent(harness.deps, {
    ...base,
    createdAt: 1_000,
    sequence: 5,
    type: "item/completed",
    scope: turnScope("turn-1"),
    data: {
      providerThreadId: HISTORY_PROVIDER_THREAD_ID,
      item: { type: "agentMessage", id: "msg-1", text: "ok" },
    },
  });
  seedHistoryUserRequest(harness, {
    ...base,
    requestId: secondRequestId,
    sequence: 6,
    text: "Reply only with the word second.",
  });
  seedEvent(harness.deps, {
    ...base,
    sequence: 7,
    type: "turn/completed",
    scope: turnScope("turn-1"),
    data: {
      providerThreadId: HISTORY_PROVIDER_THREAD_ID,
      status: "completed",
      providerCheckpointId: "checkpoint-after-turn-1",
    },
  });
  seedTurnStarted(harness.deps, { ...base, sequence: 8, turnId: "turn-2" });
  seedEvent(harness.deps, {
    ...base,
    sequence: 9,
    type: "turn/input/accepted",
    scope: turnScope("turn-2"),
    data: {
      providerThreadId: HISTORY_PROVIDER_THREAD_ID,
      clientRequestId: secondRequestId,
    },
  });
  seedEvent(harness.deps, {
    ...base,
    sequence: 10,
    type: "item/completed",
    scope: turnScope("turn-2"),
    data: {
      providerThreadId: HISTORY_PROVIDER_THREAD_ID,
      item: { type: "agentMessage", id: "msg-2", text: "second" },
    },
  });
  seedEvent(harness.deps, {
    ...base,
    sequence: 11,
    type: "turn/completed",
    scope: turnScope("turn-2"),
    data: {
      providerThreadId: HISTORY_PROVIDER_THREAD_ID,
      status: "completed",
      providerCheckpointId: "checkpoint-after-turn-2",
    },
  });
  if (args.runningThirdTurn === false) {
    return { environment, sourceThread };
  }
  seedHistoryUserRequest(harness, {
    ...base,
    requestId: thirdRequestId,
    sequence: 12,
    text: "Reply only with the word third.",
  });
  seedTurnStarted(harness.deps, { ...base, sequence: 13, turnId: "turn-3" });
  seedEvent(harness.deps, {
    ...base,
    sequence: 14,
    type: "turn/input/accepted",
    scope: turnScope("turn-3"),
    data: {
      providerThreadId: HISTORY_PROVIDER_THREAD_ID,
      clientRequestId: thirdRequestId,
    },
  });
  return { environment, sourceThread };
}

async function readConversationTexts(
  harness: TestAppHarness,
  threadId: string,
): Promise<string[]> {
  const response = await harness.app.request(
    `/api/v1/threads/${threadId}/timeline`,
  );
  expect(response.status).toBe(200);
  const timeline = threadTimelineResponseSchema.parse(await readJson(response));
  return timeline.rows.flatMap((row) =>
    row.kind === "conversation" ? [row.text] : [],
  );
}

async function waitForForkStart(harness: TestAppHarness, forkId: string) {
  const queued = await waitForQueuedCommand(
    harness,
    ({ command }) =>
      command.type === "thread.start" && command.threadId === forkId,
  );
  if (queued.command.type !== "thread.start") {
    throw new Error("Expected thread.start");
  }
  return queued.command;
}

describe("fork branch point and inherited history", () => {
  it("clones through the anchor turn's checkpoint and inherits its conversation", async () => {
    await withTestHarness(async (harness) => {
      const { sourceThread } = seedConversationForkSource(harness);

      const response = await postFork(harness, {
        sourceThreadId: sourceThread.id,
        sourceSeqEnd: 5,
      });

      expect(response.status).toBe(201);
      const fork = threadResponseSchema.parse(await readJson(response));
      const start = await waitForForkStart(harness, fork.id);
      expect(start.fork).toEqual({
        sourceProviderThreadId: HISTORY_PROVIDER_THREAD_ID,
        sourceProviderCheckpointId: "checkpoint-after-turn-1",
      });
      expect(await readConversationTexts(harness, fork.id)).toEqual([
        "Reply only with ok.",
        "ok",
      ]);

      const forkEvents = listEvents(harness.db, { threadId: fork.id });
      const inherited = forkEvents.filter((event) => event.sequence <= 5);
      expect(inherited.map((event) => event.type)).toEqual([
        "client/turn/requested",
        "turn/started",
        "turn/input/accepted",
        "item/completed",
        "turn/completed",
      ]);
      expect(inherited.every((event) => event.providerThreadId === null)).toBe(
        true,
      );
      expect(inherited[3]?.createdAt).toBe(1_000);
      expect(
        forkEvents.filter((event) => event.type === "thread/identity"),
      ).toHaveLength(0);
      expect(forkEvents.at(5)?.type).toBe("client/turn/requested");
    });
  });

  it("anchors a user message before its own turn", async () => {
    await withTestHarness(async (harness) => {
      const { sourceThread } = seedConversationForkSource(harness);

      const response = await postFork(harness, {
        sourceThreadId: sourceThread.id,
        sourceSeqEnd: 6,
      });

      expect(response.status).toBe(201);
      const fork = threadResponseSchema.parse(await readJson(response));
      const start = await waitForForkStart(harness, fork.id);
      expect(start.fork?.sourceProviderCheckpointId).toBe(
        "checkpoint-after-turn-1",
      );
      expect(await readConversationTexts(harness, fork.id)).toEqual([
        "Reply only with ok.",
        "ok",
      ]);
    });
  });

  it("clones the tip of an idle source and inherits every completed turn", async () => {
    await withTestHarness(async (harness) => {
      const { sourceThread } = seedConversationForkSource(harness, {
        runningThirdTurn: false,
      });

      const response = await postFork(harness, {
        sourceThreadId: sourceThread.id,
      });

      expect(response.status).toBe(201);
      const fork = threadResponseSchema.parse(await readJson(response));
      const start = await waitForForkStart(harness, fork.id);
      expect(start.fork).toEqual({
        sourceProviderThreadId: HISTORY_PROVIDER_THREAD_ID,
      });
      expect(await readConversationTexts(harness, fork.id)).toEqual([
        "Reply only with ok.",
        "ok",
        "Reply only with the word second.",
        "second",
      ]);
    });
  });

  it("branches a mid-turn source at its last completed turn's checkpoint", async () => {
    await withTestHarness(async (harness) => {
      const { sourceThread } = seedConversationForkSource(harness);

      const response = await postFork(harness, {
        sourceThreadId: sourceThread.id,
      });

      expect(response.status).toBe(201);
      const fork = threadResponseSchema.parse(await readJson(response));
      const start = await waitForForkStart(harness, fork.id);
      expect(start.fork).toEqual({
        sourceProviderThreadId: HISTORY_PROVIDER_THREAD_ID,
        sourceProviderCheckpointId: "checkpoint-after-turn-2",
      });
      expect(await readConversationTexts(harness, fork.id)).toEqual([
        "Reply only with ok.",
        "ok",
        "Reply only with the word second.",
        "second",
      ]);
      expect(
        listEvents(harness.db, { threadId: fork.id }).some(
          (event) => event.turnId === "turn-3",
        ),
      ).toBe(false);
    });
  });

  it("keeps a hidden fork's timeline free of inherited history", async () => {
    await withTestHarness(async (harness) => {
      const { sourceThread } = seedConversationForkSource(harness);

      const response = await postFork(harness, {
        sourceThreadId: sourceThread.id,
        sourceSeqEnd: 5,
        visibility: "hidden",
      });

      expect(response.status).toBe(201);
      const fork = threadResponseSchema.parse(await readJson(response));
      const start = await waitForForkStart(harness, fork.id);
      expect(start.fork).toEqual({
        sourceProviderThreadId: HISTORY_PROVIDER_THREAD_ID,
        sourceProviderCheckpointId: "checkpoint-after-turn-1",
      });
      expect(await readConversationTexts(harness, fork.id)).toEqual([]);
      expect(
        listEvents(harness.db, { threadId: fork.id }).map(
          (event) => event.type,
        ),
      ).not.toContain("item/completed");
    });
  });

  it("rejects an anchor inside a running turn or before the first turn", async () => {
    await withTestHarness(async (harness) => {
      const { sourceThread } = seedConversationForkSource(harness);

      const running = await postFork(harness, {
        sourceThreadId: sourceThread.id,
        sourceSeqEnd: 14,
      });
      expect(running.status).toBe(400);
      expect(await readJson(running)).toMatchObject({
        code: "fork_source_session_unavailable",
        message:
          "Cannot fork at sequence 14: the turn containing it has not completed",
      });

      const beforeFirstTurn = await postFork(harness, {
        sourceThreadId: sourceThread.id,
        sourceSeqEnd: 2,
      });
      expect(beforeFirstTurn.status).toBe(400);
      expect(await readJson(beforeFirstTurn)).toMatchObject({
        code: "fork_source_session_unavailable",
        message:
          "Cannot fork at sequence 2: no turn has started at or before it",
      });
    });
  });

  const TIP_ONLY_PROVIDER_ID = "acp-opencode";

  it("clones the tip of a mid-turn source when the provider cannot branch at a checkpoint", async () => {
    await withTestHarness({}, async (harness) => {
      const { sourceThread } = seedConversationForkSource(harness, {
        providerId: TIP_ONLY_PROVIDER_ID,
      });

      const response = await postFork(harness, {
        sourceThreadId: sourceThread.id,
      });

      expect(response.status).toBe(201);
      const fork = threadResponseSchema.parse(await readJson(response));
      const start = await waitForForkStart(harness, fork.id);
      expect(start.fork).toEqual({
        sourceProviderThreadId: HISTORY_PROVIDER_THREAD_ID,
      });
      expect(await readConversationTexts(harness, fork.id)).toEqual([
        "Reply only with ok.",
        "ok",
        "Reply only with the word second.",
        "second",
      ]);
    });
  });

  it("lets a tip-only provider fork at its latest turn but not earlier", async () => {
    await withTestHarness({}, async (harness) => {
      const { sourceThread } = seedConversationForkSource(harness, {
        providerId: TIP_ONLY_PROVIDER_ID,
        runningThirdTurn: false,
      });

      const earlier = await postFork(harness, {
        sourceThreadId: sourceThread.id,
        sourceSeqEnd: 5,
      });
      expect(earlier.status).toBe(400);
      expect(await readJson(earlier)).toMatchObject({
        code: "fork_source_session_unavailable",
        message: `Provider ${TIP_ONLY_PROVIDER_ID} can only fork at the end of a session, not from an earlier point in it`,
      });

      const tip = await postFork(harness, {
        sourceThreadId: sourceThread.id,
        sourceSeqEnd: 10,
      });
      expect(tip.status).toBe(201);
      const fork = threadResponseSchema.parse(await readJson(tip));
      const start = await waitForForkStart(harness, fork.id);
      expect(start.fork).toEqual({
        sourceProviderThreadId: HISTORY_PROVIDER_THREAD_ID,
      });
      expect(await readConversationTexts(harness, fork.id)).toEqual([
        "Reply only with ok.",
        "ok",
        "Reply only with the word second.",
        "second",
      ]);
    });
  });
});
