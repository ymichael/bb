import { describe, expect, it, vi } from "vitest";
import { desc, eq } from "drizzle-orm";
import { events, getThreadDynamicContextFileState } from "@bb/db";
import type { PromptInput, ThreadStatus } from "@bb/domain";
import { turnRequestEventDataSchema } from "@bb/domain";
import {
  MANAGER_PREFERENCES_FILE_KEY,
  MANAGER_PREFERENCES_INLINE_LIMIT_BYTES,
  prependManagerPreferencesSystemMessageIfChanged,
  recordManagerDynamicFileDelivery,
} from "../../src/services/threads/manager-dynamic-file-delivery.js";
import {
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";
import { sendThreadMessage } from "../../src/services/threads/thread-send.js";
import { queueManagerSystemMessage } from "../../src/services/threads/manager-system-messages.js";
import { sendNextQueuedMessageIfPresent } from "../../src/services/threads/queued-messages.js";

interface SetupManagerResult {
  environment: ReturnType<typeof seedEnvironment>;
  harness: TestAppHarness;
  hostId: string;
  input: PromptInput[];
  preferencesPath: string;
  thread: ReturnType<typeof seedThread>;
  threadStoragePath: string;
}

interface RespondToPreferencesMetadataSuccessArgs {
  harness: TestAppHarness;
  modifiedAtMs: number;
  preferencesPath: string;
  sizeBytes: number;
  threadStoragePath: string;
}

interface RespondToPreferencesReadSuccessArgs {
  content: string;
  contentEncoding?: "base64" | "utf8";
  harness: TestAppHarness;
  preferencesPath: string;
  sizeBytes?: number;
  threadStoragePath: string;
}

const baseInput: PromptInput[] = [{ type: "text", text: "inbound turn" }];

async function setupManager(
  hostId: string,
  threadStatus: ThreadStatus = "idle",
): Promise<SetupManagerResult> {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps, { id: hostId });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });
  const thread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    providerId: "codex",
    status: threadStatus,
    type: "manager",
  });
  const threadStoragePath = `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}`;
  return {
    environment,
    harness,
    hostId: host.id,
    input: baseInput,
    preferencesPath: `${threadStoragePath}/PREFERENCES.md`,
    thread,
    threadStoragePath,
  };
}

function getLatestTurnRequestInput(
  harness: TestAppHarness,
  threadId: string,
): PromptInput[] {
  const row = harness.db
    .select({ data: events.data, type: events.type })
    .from(events)
    .where(eq(events.threadId, threadId))
    .orderBy(desc(events.sequence))
    .all()
    .find((event) => event.type === "client/turn/requested");
  if (!row) {
    throw new Error("Expected client turn request event");
  }
  const eventData = turnRequestEventDataSchema.parse(JSON.parse(row.data));
  return eventData.input;
}

function listTurnRequestInputs(
  harness: TestAppHarness,
  threadId: string,
): PromptInput[][] {
  return harness.db
    .select({ data: events.data, type: events.type })
    .from(events)
    .where(eq(events.threadId, threadId))
    .orderBy(events.sequence)
    .all()
    .filter((event) => event.type === "client/turn/requested")
    .map((event) => turnRequestEventDataSchema.parse(JSON.parse(event.data)))
    .map((eventData) => eventData.input);
}

async function respondToPreferencesReadMissing(
  harness: TestAppHarness,
  preferencesPath: string,
): Promise<void> {
  const queued = await waitForQueuedCommand(
    harness,
    ({ command, row }) =>
      row.state === "pending" &&
      command.type === "host.read_file" &&
      command.path === preferencesPath,
  );
  const response = await reportQueuedCommandError(harness, queued, {
    errorCode: "ENOENT",
    errorMessage: "File not found",
  });
  expect(response.status).toBe(200);
}

async function respondToPreferencesReadTooLarge(
  harness: TestAppHarness,
  preferencesPath: string,
): Promise<void> {
  const queued = await waitForQueuedCommand(
    harness,
    ({ command, row }) =>
      row.state === "pending" &&
      command.type === "host.read_file" &&
      command.path === preferencesPath,
  );
  const response = await reportQueuedCommandError(harness, queued, {
    errorCode: "file_too_large",
    errorMessage: "File exceeds the host read cap",
  });
  expect(response.status).toBe(200);
}

async function respondToPreferencesReadSuccess(
  args: RespondToPreferencesReadSuccessArgs,
): Promise<void> {
  const queued = await waitForQueuedCommand(
    args.harness,
    ({ command, row }) =>
      row.state === "pending" &&
      command.type === "host.read_file" &&
      command.path === args.preferencesPath,
  );
  if (queued.command.type !== "host.read_file") {
    throw new Error(`Expected host.read_file, got ${queued.command.type}`);
  }
  expect(queued.command.rootPath).toBe(args.threadStoragePath);
  const response = await reportQueuedCommandSuccess(
    args.harness,
    { command: queued.command, row: queued.row },
    {
      path: args.preferencesPath,
      content: args.content,
      contentEncoding: args.contentEncoding ?? "utf8",
      mimeType: "text/markdown",
      sizeBytes: args.sizeBytes ?? Buffer.byteLength(args.content),
    },
  );
  expect(response.status).toBe(200);
}

async function respondToPreferencesMetadataSuccess(
  args: RespondToPreferencesMetadataSuccessArgs,
): Promise<void> {
  const queued = await waitForQueuedCommand(
    args.harness,
    ({ command, row }) =>
      row.state === "pending" &&
      command.type === "host.file_metadata" &&
      command.path === args.preferencesPath,
  );
  if (queued.command.type !== "host.file_metadata") {
    throw new Error(`Expected host.file_metadata, got ${queued.command.type}`);
  }
  expect(queued.command.rootPath).toBe(args.threadStoragePath);
  const response = await reportQueuedCommandSuccess(
    args.harness,
    { command: queued.command, row: queued.row },
    {
      path: args.preferencesPath,
      modifiedAtMs: args.modifiedAtMs,
      sizeBytes: args.sizeBytes,
    },
  );
  expect(response.status).toBe(200);
}

describe("manager dynamic file delivery", () => {
  it("stays silent when PREFERENCES.md has never existed", async () => {
    const setup = await setupManager("host-manager-dynamic-missing");
    try {
      const preparedPromise = prependManagerPreferencesSystemMessageIfChanged(
        setup.harness.deps,
        {
          hostId: setup.hostId,
          input: setup.input,
          mode: "first-boot",
          thread: setup.thread,
        },
      );
      await respondToPreferencesReadMissing(
        setup.harness,
        setup.preferencesPath,
      );
      const prepared = await preparedPromise;

      expect(prepared.input).toEqual(setup.input);
      expect(prepared.stateUpdate).toBeNull();
      expect(
        getThreadDynamicContextFileState(setup.harness.db, {
          threadId: setup.thread.id,
          fileKey: MANAGER_PREFERENCES_FILE_KEY,
        }),
      ).toBeNull();
    } finally {
      await setup.harness.cleanup();
    }
  });

  it("prepends the first-boot snapshot and suppresses repeats for the same hash", async () => {
    const setup = await setupManager("host-manager-dynamic-first-boot");
    try {
      const preparedPromise = prependManagerPreferencesSystemMessageIfChanged(
        setup.harness.deps,
        {
          hostId: setup.hostId,
          input: setup.input,
          mode: "first-boot",
          thread: setup.thread,
        },
      );
      await respondToPreferencesReadSuccess({
        harness: setup.harness,
        preferencesPath: setup.preferencesPath,
        threadStoragePath: setup.threadStoragePath,
        content: "# Preferences\n\n- terse updates\n",
      });
      const prepared = await preparedPromise;

      expect(prepared.input[0]).toEqual({
        type: "text",
        text: expect.stringContaining("Current PREFERENCES.md contents:"),
        visibility: "agent-only",
      });
      expect(prepared.input[0]).toEqual({
        type: "text",
        text: expect.stringContaining("terse updates"),
        visibility: "agent-only",
      });
      recordManagerDynamicFileDelivery(
        setup.harness.deps,
        prepared.stateUpdate,
      );

      const repeatPromise = prependManagerPreferencesSystemMessageIfChanged(
        setup.harness.deps,
        {
          hostId: setup.hostId,
          input: setup.input,
          mode: "change-detection",
          thread: setup.thread,
        },
      );
      await respondToPreferencesReadSuccess({
        harness: setup.harness,
        preferencesPath: setup.preferencesPath,
        threadStoragePath: setup.threadStoragePath,
        content: "# Preferences\n\n- terse updates\n",
      });
      const repeat = await repeatPromise;
      expect(repeat.input).toEqual(setup.input);
      expect(repeat.stateUpdate).toBeNull();
    } finally {
      await setup.harness.cleanup();
    }
  });

  it("prepends updated, warning, and removed messages on hash transitions", async () => {
    const setup = await setupManager("host-manager-dynamic-transitions");
    try {
      const firstPromise = prependManagerPreferencesSystemMessageIfChanged(
        setup.harness.deps,
        {
          hostId: setup.hostId,
          input: setup.input,
          mode: "first-boot",
          thread: setup.thread,
        },
      );
      await respondToPreferencesReadSuccess({
        harness: setup.harness,
        preferencesPath: setup.preferencesPath,
        threadStoragePath: setup.threadStoragePath,
        content: "initial prefs\n",
      });
      const first = await firstPromise;
      recordManagerDynamicFileDelivery(setup.harness.deps, first.stateUpdate);

      const updatedPromise = prependManagerPreferencesSystemMessageIfChanged(
        setup.harness.deps,
        {
          hostId: setup.hostId,
          input: setup.input,
          mode: "change-detection",
          thread: setup.thread,
        },
      );
      await respondToPreferencesReadSuccess({
        harness: setup.harness,
        preferencesPath: setup.preferencesPath,
        threadStoragePath: setup.threadStoragePath,
        content: "updated prefs\n",
      });
      const updated = await updatedPromise;
      expect(updated.input[0]).toEqual({
        type: "text",
        text: expect.stringContaining(
          "PREFERENCES.md has been updated. New contents:",
        ),
        visibility: "agent-only",
      });
      recordManagerDynamicFileDelivery(setup.harness.deps, updated.stateUpdate);

      const tooLargeContent = "x".repeat(
        MANAGER_PREFERENCES_INLINE_LIMIT_BYTES + 1,
      );
      const warningPromise = prependManagerPreferencesSystemMessageIfChanged(
        setup.harness.deps,
        {
          hostId: setup.hostId,
          input: setup.input,
          mode: "change-detection",
          thread: setup.thread,
        },
      );
      await respondToPreferencesReadSuccess({
        harness: setup.harness,
        preferencesPath: setup.preferencesPath,
        threadStoragePath: setup.threadStoragePath,
        content: tooLargeContent,
      });
      const warning = await warningPromise;
      expect(warning.input[0]).toEqual({
        type: "text",
        text: expect.stringContaining("larger than the 256 KiB inline limit"),
        visibility: "agent-only",
      });
      recordManagerDynamicFileDelivery(setup.harness.deps, warning.stateUpdate);

      const nonUtf8Promise = prependManagerPreferencesSystemMessageIfChanged(
        setup.harness.deps,
        {
          hostId: setup.hostId,
          input: setup.input,
          mode: "change-detection",
          thread: setup.thread,
        },
      );
      await respondToPreferencesReadSuccess({
        harness: setup.harness,
        preferencesPath: setup.preferencesPath,
        threadStoragePath: setup.threadStoragePath,
        content: "AAECAw==",
        contentEncoding: "base64",
        sizeBytes: 4,
      });
      const nonUtf8 = await nonUtf8Promise;
      expect(nonUtf8.input[0]).toEqual({
        type: "text",
        text: expect.stringContaining("not UTF-8 text"),
        visibility: "agent-only",
      });
      recordManagerDynamicFileDelivery(setup.harness.deps, nonUtf8.stateUpdate);

      const removedPromise = prependManagerPreferencesSystemMessageIfChanged(
        setup.harness.deps,
        {
          hostId: setup.hostId,
          input: setup.input,
          mode: "change-detection",
          thread: setup.thread,
        },
      );
      await respondToPreferencesReadMissing(
        setup.harness,
        setup.preferencesPath,
      );
      const removed = await removedPromise;
      expect(removed.input[0]).toEqual({
        type: "text",
        text: expect.stringContaining("PREFERENCES.md was removed."),
        visibility: "agent-only",
      });
      recordManagerDynamicFileDelivery(setup.harness.deps, removed.stateUpdate);

      expect(
        getThreadDynamicContextFileState(setup.harness.db, {
          threadId: setup.thread.id,
          fileKey: MANAGER_PREFERENCES_FILE_KEY,
        }),
      ).toMatchObject({
        contentStatus: "missing",
      });
    } finally {
      await setup.harness.cleanup();
    }
  });

  it("uses host-side metadata to hash files above the daemon read cap", async () => {
    const setup = await setupManager("host-manager-dynamic-metadata");
    try {
      const firstPromise = prependManagerPreferencesSystemMessageIfChanged(
        setup.harness.deps,
        {
          hostId: setup.hostId,
          input: setup.input,
          mode: "first-boot",
          thread: setup.thread,
        },
      );
      await respondToPreferencesReadTooLarge(
        setup.harness,
        setup.preferencesPath,
      );
      await respondToPreferencesMetadataSuccess({
        harness: setup.harness,
        preferencesPath: setup.preferencesPath,
        threadStoragePath: setup.threadStoragePath,
        modifiedAtMs: 1_000,
        sizeBytes: 26 * 1024 * 1024,
      });
      const first = await firstPromise;
      expect(first.input[0]).toEqual({
        type: "text",
        text: expect.stringContaining("larger than the 256 KiB inline limit"),
        visibility: "agent-only",
      });
      recordManagerDynamicFileDelivery(setup.harness.deps, first.stateUpdate);

      const repeatPromise = prependManagerPreferencesSystemMessageIfChanged(
        setup.harness.deps,
        {
          hostId: setup.hostId,
          input: setup.input,
          mode: "change-detection",
          thread: setup.thread,
        },
      );
      await respondToPreferencesReadTooLarge(
        setup.harness,
        setup.preferencesPath,
      );
      await respondToPreferencesMetadataSuccess({
        harness: setup.harness,
        preferencesPath: setup.preferencesPath,
        threadStoragePath: setup.threadStoragePath,
        modifiedAtMs: 1_000,
        sizeBytes: 26 * 1024 * 1024,
      });
      const repeat = await repeatPromise;
      expect(repeat.input).toEqual(setup.input);
      expect(repeat.stateUpdate).toBeNull();

      const changedPromise = prependManagerPreferencesSystemMessageIfChanged(
        setup.harness.deps,
        {
          hostId: setup.hostId,
          input: setup.input,
          mode: "change-detection",
          thread: setup.thread,
        },
      );
      await respondToPreferencesReadTooLarge(
        setup.harness,
        setup.preferencesPath,
      );
      await respondToPreferencesMetadataSuccess({
        harness: setup.harness,
        preferencesPath: setup.preferencesPath,
        threadStoragePath: setup.threadStoragePath,
        modifiedAtMs: 2_000,
        sizeBytes: 26 * 1024 * 1024,
      });
      const changed = await changedPromise;
      expect(changed.input[0]).toEqual({
        type: "text",
        text: expect.stringContaining("larger than the 256 KiB inline limit"),
        visibility: "agent-only",
      });
      expect(changed.stateUpdate).not.toBeNull();
    } finally {
      await setup.harness.cleanup();
    }
  });

  it("does not record the hash when command queueing fails after dynamic input preparation", async () => {
    const setup = await setupManager(
      "host-manager-dynamic-queue-failure",
      "active",
    );
    try {
      seedThreadRuntimeState(setup.harness.deps, {
        threadId: setup.thread.id,
        environmentId: setup.environment.id,
        providerThreadId: "provider-manager-dynamic-queue-failure",
        inputText: "previous active request",
      });
      seedTurnStarted(setup.harness.deps, {
        threadId: setup.thread.id,
        environmentId: setup.environment.id,
        providerThreadId: "provider-manager-dynamic-queue-failure",
        turnId: "turn-manager-dynamic-queue-failure",
      });
      const sendPromise = sendThreadMessage(setup.harness.deps, {
        environment: setup.environment,
        payload: {
          input: setup.input,
          mode: "auto",
        },
        thread: setup.thread,
        trigger: "user",
      });
      const preferencesReadCommand = await waitForQueuedCommand(
        setup.harness,
        ({ command, row }) =>
          row.state === "pending" &&
          command.type === "host.read_file" &&
          command.path === setup.preferencesPath,
      );
      if (preferencesReadCommand.command.type !== "host.read_file") {
        throw new Error(
          `Expected host.read_file, got ${preferencesReadCommand.command.type}`,
        );
      }
      const originalTransaction = setup.harness.deps.db.transaction.bind(
        setup.harness.deps.db,
      );
      const transactionSpy = vi.spyOn(setup.harness.deps.db, "transaction");
      try {
        let transactionCountAfterPreferences = 0;
        transactionSpy.mockImplementation((callback) => {
          transactionCountAfterPreferences += 1;
          if (transactionCountAfterPreferences === 2) {
            throw new Error("queued turn insert failed");
          }
          return originalTransaction(callback);
        });
        const preferencesContent = "# Preferences\n\n- retry me\n";
        setup.harness.hub.recordCommandResult(preferencesReadCommand.row.id, {
          commandId: preferencesReadCommand.row.id,
          ok: true,
          result: {
            path: setup.preferencesPath,
            content: preferencesContent,
            contentEncoding: "utf8",
            mimeType: "text/markdown",
            sizeBytes: Buffer.byteLength(preferencesContent),
          },
          type: "host.read_file",
        });

        await expect(sendPromise).rejects.toThrow("queued turn insert failed");
        expect(transactionCountAfterPreferences).toBe(2);
      } finally {
        transactionSpy.mockRestore();
      }
      expect(
        getThreadDynamicContextFileState(setup.harness.db, {
          threadId: setup.thread.id,
          fileKey: MANAGER_PREFERENCES_FILE_KEY,
        }),
      ).toBeNull();
      const eventInput = getLatestTurnRequestInput(
        setup.harness,
        setup.thread.id,
      );
      expect(eventInput[0]).toEqual({
        type: "text",
        text: expect.stringContaining("Current PREFERENCES.md contents:"),
        visibility: "agent-only",
      });
      expect(eventInput[1]).toEqual(setup.input[0]);
    } finally {
      await setup.harness.cleanup();
    }
  });

  it("serializes concurrent manager turns so only one preferences snapshot is injected", async () => {
    const setup = await setupManager(
      "host-manager-dynamic-concurrent",
      "active",
    );
    try {
      seedThreadRuntimeState(setup.harness.deps, {
        threadId: setup.thread.id,
        environmentId: setup.environment.id,
        providerThreadId: "provider-manager-dynamic-concurrent",
        inputText: "previous concurrent task",
      });
      seedTurnStarted(setup.harness.deps, {
        threadId: setup.thread.id,
        environmentId: setup.environment.id,
        providerThreadId: "provider-manager-dynamic-concurrent",
        turnId: "turn-manager-dynamic-concurrent",
      });

      const queuedMessages = Promise.all([
        queueManagerSystemMessage(setup.harness.deps, {
          managerThreadId: setup.thread.id,
          messageText: "[bb system]\n\nFirst concurrent inbound turn.",
        }),
        queueManagerSystemMessage(setup.harness.deps, {
          managerThreadId: setup.thread.id,
          messageText: "[bb system]\n\nSecond concurrent inbound turn.",
        }),
      ]);
      await respondToPreferencesReadSuccess({
        harness: setup.harness,
        preferencesPath: setup.preferencesPath,
        threadStoragePath: setup.threadStoragePath,
        content: "concurrent prefs\n",
      });
      await respondToPreferencesReadSuccess({
        harness: setup.harness,
        preferencesPath: setup.preferencesPath,
        threadStoragePath: setup.threadStoragePath,
        content: "concurrent prefs\n",
      });
      await expect(queuedMessages).resolves.toEqual([true, true]);

      const turnInputs = listTurnRequestInputs(
        setup.harness,
        setup.thread.id,
      ).slice(-2);
      expect(turnInputs).toHaveLength(2);
      const injectedPreferencesMessages = turnInputs
        .map((input) => input[0])
        .filter(
          (item) =>
            item.type === "text" &&
            item.text.includes("Current PREFERENCES.md contents:"),
        );
      expect(injectedPreferencesMessages).toHaveLength(1);
      expect(injectedPreferencesMessages[0]).toEqual({
        type: "text",
        text: expect.stringContaining("concurrent prefs"),
        visibility: "agent-only",
      });
      expect(
        turnInputs.some((input) =>
          input.some(
            (item) =>
              item.type === "text" &&
              item.text === "[bb system]\n\nFirst concurrent inbound turn.",
          ),
        ),
      ).toBe(true);
      expect(
        turnInputs.some((input) =>
          input.some(
            (item) =>
              item.type === "text" &&
              item.text === "[bb system]\n\nSecond concurrent inbound turn.",
          ),
        ),
      ).toBe(true);
    } finally {
      await setup.harness.cleanup();
    }
  });

  it("prepends changed preferences to manager system messages and persisted turn input", async () => {
    const setup = await setupManager("host-manager-dynamic-system-message");
    try {
      seedThreadRuntimeState(setup.harness.deps, {
        threadId: setup.thread.id,
        environmentId: setup.environment.id,
        providerThreadId: "provider-manager-dynamic-system-message",
      });
      const firstPromise = prependManagerPreferencesSystemMessageIfChanged(
        setup.harness.deps,
        {
          hostId: setup.hostId,
          input: setup.input,
          mode: "first-boot",
          thread: setup.thread,
        },
      );
      await respondToPreferencesReadSuccess({
        harness: setup.harness,
        preferencesPath: setup.preferencesPath,
        threadStoragePath: setup.threadStoragePath,
        content: "old prefs\n",
      });
      const first = await firstPromise;
      recordManagerDynamicFileDelivery(setup.harness.deps, first.stateUpdate);

      const queuedPromise = queueManagerSystemMessage(setup.harness.deps, {
        managerThreadId: setup.thread.id,
        messageText: "[bb system]\n\nThread complete: child finished.",
      });
      await respondToPreferencesReadSuccess({
        harness: setup.harness,
        preferencesPath: setup.preferencesPath,
        threadStoragePath: setup.threadStoragePath,
        content: "new prefs\n",
      });
      await expect(queuedPromise).resolves.toBe(true);

      const turnSubmit = await waitForQueuedCommand(
        setup.harness,
        ({ command, row }) =>
          row.state === "pending" &&
          command.type === "turn.submit" &&
          command.threadId === setup.thread.id,
      );
      if (turnSubmit.command.type !== "turn.submit") {
        throw new Error(`Expected turn.submit, got ${turnSubmit.command.type}`);
      }
      expect(turnSubmit.command.input[0]).toEqual({
        type: "text",
        text: expect.stringContaining(
          "PREFERENCES.md has been updated. New contents:",
        ),
        visibility: "agent-only",
      });
      expect(turnSubmit.command.input[1]).toEqual({
        type: "text",
        text: "[bb system]\n\nThread complete: child finished.",
      });

      const eventInput = getLatestTurnRequestInput(
        setup.harness,
        setup.thread.id,
      );
      expect(eventInput[0]).toEqual(turnSubmit.command.input[0]);
      expect(eventInput[1]).toEqual(turnSubmit.command.input[1]);
    } finally {
      await setup.harness.cleanup();
    }
  });

  it("prepends changed preferences to queued-message auto-send turns", async () => {
    const setup = await setupManager("host-manager-dynamic-queued-message");
    try {
      seedThreadRuntimeState(setup.harness.deps, {
        threadId: setup.thread.id,
        environmentId: setup.environment.id,
        providerThreadId: "provider-manager-dynamic-queued-message",
      });
      const firstPromise = prependManagerPreferencesSystemMessageIfChanged(
        setup.harness.deps,
        {
          hostId: setup.hostId,
          input: setup.input,
          mode: "first-boot",
          thread: setup.thread,
        },
      );
      await respondToPreferencesReadSuccess({
        harness: setup.harness,
        preferencesPath: setup.preferencesPath,
        threadStoragePath: setup.threadStoragePath,
        content: "queued old prefs\n",
      });
      const first = await firstPromise;
      recordManagerDynamicFileDelivery(setup.harness.deps, first.stateUpdate);
      seedQueuedMessage(setup.harness.deps, {
        threadId: setup.thread.id,
        content: [{ type: "text", text: "queued inbound" }],
      });

      const sentPromise = sendNextQueuedMessageIfPresent(setup.harness.deps, {
        threadId: setup.thread.id,
      });
      await respondToPreferencesReadSuccess({
        harness: setup.harness,
        preferencesPath: setup.preferencesPath,
        threadStoragePath: setup.threadStoragePath,
        content: "queued new prefs\n",
      });
      await expect(sentPromise).resolves.toBe(true);

      const turnSubmit = await waitForQueuedCommand(
        setup.harness,
        ({ command, row }) =>
          row.state === "pending" &&
          command.type === "turn.submit" &&
          command.threadId === setup.thread.id,
      );
      if (turnSubmit.command.type !== "turn.submit") {
        throw new Error(`Expected turn.submit, got ${turnSubmit.command.type}`);
      }
      expect(turnSubmit.command.input[0]).toEqual({
        type: "text",
        text: expect.stringContaining(
          "PREFERENCES.md has been updated. New contents:",
        ),
        visibility: "agent-only",
      });
      expect(turnSubmit.command.input[1]).toEqual({
        type: "text",
        text: "queued inbound",
      });

      const eventInput = getLatestTurnRequestInput(
        setup.harness,
        setup.thread.id,
      );
      expect(eventInput[0]).toEqual(turnSubmit.command.input[0]);
      expect(eventInput[1]).toEqual(turnSubmit.command.input[1]);
    } finally {
      await setup.harness.cleanup();
    }
  });
});
