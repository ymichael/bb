import { describe, expect, it } from "vitest";
import type { AgentProviderId } from "@bb/agent-providers";
import { getLatestThreadSequence } from "@bb/db";
import type { PromptInput, ResolvedThreadExecutionOptions } from "@bb/domain";
import type { ThreadType } from "@bb/domain";
import type { TurnSubmitTarget } from "@bb/host-daemon-contract";
import type { PreparedTurnSubmitCommandPayload } from "../../src/services/threads/thread-commands.js";
import {
  buildManagerToolReminderText,
  resolveManagerUserMessageToolName,
  type ManagerUserMessageToolName,
} from "../../src/services/threads/manager-tool-reminder.js";
import { prepareTurnSubmitCommandPayload } from "../../src/services/threads/thread-commands.js";
import { findThreadEvent } from "../../src/services/threads/thread-data.js";
import { sendThreadMessage } from "../../src/services/threads/thread-send.js";
import {
  listQueuedThreadCommands,
  reportQueuedCommandError,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

interface ProviderReminderCase {
  providerId: AgentProviderId;
  toolName: ManagerUserMessageToolName;
}

interface PrepareTurnSubmitPayloadForThreadArgs {
  input: PromptInput[];
  providerId: AgentProviderId;
  targetMode?: "auto" | "start" | "steer";
  threadType: ThreadType;
}

interface PrepareTurnSubmitPayloadForThreadResult {
  payload: PreparedTurnSubmitCommandPayload;
}

const providerReminderCases: ProviderReminderCase[] = [
  {
    providerId: "claude-code",
    toolName: "mcp__bb-bridge__message_user",
  },
  {
    providerId: "codex",
    toolName: "message_user",
  },
  {
    providerId: "pi",
    toolName: "message_user",
  },
];

const testExecution: ResolvedThreadExecutionOptions = {
  model: "test-model",
  serviceTier: "default",
  reasoningLevel: "medium",
  permissionMode: "full",
  source: "client/turn/requested",
};

function buildTurnSubmitTarget(
  mode: PrepareTurnSubmitPayloadForThreadArgs["targetMode"],
): TurnSubmitTarget {
  switch (mode) {
    case "auto":
      return { mode: "auto", expectedTurnId: null };
    case "steer":
      return { mode: "steer", expectedTurnId: null };
    case "start":
    case undefined:
      return { mode: "start" };
  }
}

async function respondToManagerPreferencesRead(
  harness: TestAppHarness,
  hostId: string,
  threadId: string,
): Promise<void> {
  const preferencesPath = `/tmp/bb-host-data/${hostId}/thread-storage/${threadId}/PREFERENCES.md`;
  const readPreferences = await waitForQueuedCommand(
    harness,
    ({ command, row }) =>
      row.state === "pending" &&
      command.type === "host.read_file" && command.path === preferencesPath,
  );
  const response = await reportQueuedCommandError(harness, readPreferences, {
    errorCode: "ENOENT",
    errorMessage: "File not found",
  });
  expect(response.status).toBe(200);
}

async function prepareTurnSubmitPayloadForThread(
  args: PrepareTurnSubmitPayloadForThreadArgs,
): Promise<PrepareTurnSubmitPayloadForThreadResult> {
  const harness = await createTestAppHarness();
  try {
    const hostId = `host-manager-reminder-${args.threadType}-${args.providerId}`;
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
      providerId: args.providerId,
      type: args.threadType,
    });

    const payload = await prepareTurnSubmitCommandPayload(harness.deps, {
      environment,
      execution: testExecution,
      input: args.input,
      permissionEscalation: "deny",
      providerThreadId: "provider-thread-manager-reminder",
      target: buildTurnSubmitTarget(args.targetMode),
      thread,
    });

    return {
      payload,
    };
  } finally {
    await harness.cleanup();
  }
}

function expectedReminderInput(providerId: AgentProviderId): PromptInput {
  return {
    type: "text",
    text: buildManagerToolReminderText(providerId),
  };
}

describe("manager tool reminders", () => {
  it.each(providerReminderCases)(
    "resolves $providerId manager user-message tool name",
    ({ providerId, toolName }) => {
      expect(resolveManagerUserMessageToolName(providerId)).toBe(toolName);
    },
  );

  it.each(providerReminderCases)(
    "appends a $providerId manager turn reminder with the provider-specific tool name",
    async ({ providerId }) => {
      const input: PromptInput[] = [{ type: "text", text: "continue work" }];

      const { payload } = await prepareTurnSubmitPayloadForThread({
        input,
        providerId,
        threadType: "manager",
      });

      expect(payload.input).toEqual([
        ...input,
        expectedReminderInput(providerId),
      ]);
    },
  );

  it("leaves standard thread input unchanged", async () => {
    const input: PromptInput[] = [{ type: "text", text: "standard turn" }];

    const { payload } = await prepareTurnSubmitPayloadForThread({
      input,
      providerId: "codex",
      threadType: "standard",
    });

    expect(payload.input).toEqual(input);
  });

  it("does not double-append when input already ends with the exact reminder", async () => {
    const input: PromptInput[] = [
      { type: "text", text: "continue work" },
      expectedReminderInput("codex"),
    ];

    const { payload } = await prepareTurnSubmitPayloadForThread({
      input,
      providerId: "codex",
      threadType: "manager",
    });

    expect(payload.input).toEqual(input);
  });

  it("appends the reminder to empty manager input", async () => {
    const { payload } = await prepareTurnSubmitPayloadForThread({
      input: [],
      providerId: "pi",
      threadType: "manager",
    });

    expect(payload.input).toEqual([expectedReminderInput("pi")]);
  });

  it("appends the reminder on active manager steers without persisting it to the client turn event", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-manager-reminder-steer",
      });
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
        status: "active",
        type: "manager",
      });
      const providerThreadId = "provider-thread-manager-reminder-steer";
      seedThreadRuntimeState(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId,
      });
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId,
        turnId: "turn-manager-reminder-steer",
      });
      const input: PromptInput[] = [{ type: "text", text: "adjust course" }];
      const eventSequenceBeforeSend = getLatestThreadSequence(harness.db, {
        threadId: thread.id,
      });

      const sendPromise = sendThreadMessage(harness.deps, {
        environment,
        payload: {
          input,
          mode: "steer",
          model: "gpt-5.4",
          permissionMode: "full",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
        thread,
        trigger: "user",
      });

      await respondToManagerPreferencesRead(harness, host.id, thread.id);
      await sendPromise;

      const commands = listQueuedThreadCommands(
        harness,
        "turn.submit",
        thread.id,
      );
      expect(commands).toHaveLength(1);
      const command = commands[0];
      if (command?.type !== "turn.submit") {
        throw new Error("Expected turn.submit command");
      }
      expect(command.target.mode).toBe("steer");
      expect(command.input).toEqual([...input, expectedReminderInput("codex")]);

      const turnRequestEvent = findThreadEvent(harness.db, {
        afterSeq: eventSequenceBeforeSend,
        threadId: thread.id,
        type: "client/turn/requested",
      });
      if (turnRequestEvent?.type !== "client/turn/requested") {
        throw new Error("Expected client turn requested event");
      }
      expect(turnRequestEvent.data.input).toEqual(input);
    } finally {
      await harness.cleanup();
    }
  });
});
