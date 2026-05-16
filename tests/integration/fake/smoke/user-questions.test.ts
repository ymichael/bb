import { createFakeAdapter } from "@bb/agent-runtime/test";
import {
  isUserQuestionPendingInteractionPayload,
  type PendingInteraction,
  type PendingInteractionResolution,
  type UserQuestionPendingInteractionPayload,
} from "@bb/domain";
import type { TimelineQuestionWorkRow, TimelineRow } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import {
  getThreadOutput,
  getThreadTimeline,
  listThreadInteractions,
  resolveThreadInteraction,
  sendTextMessage,
} from "../../helpers/api.js";
import {
  waitForEventType,
  waitForThreadStatus,
} from "../../helpers/assertions.js";
import { withHarness } from "../../helpers/harness.js";
import {
  createProjectFixture,
  createReadyThread,
  TURN_TIMEOUT_MS,
} from "./shared.js";

interface UserQuestionInteraction extends PendingInteraction {
  payload: UserQuestionPendingInteractionPayload;
}

function isUserQuestionInteraction(
  interaction: PendingInteraction,
): interaction is UserQuestionInteraction {
  return isUserQuestionPendingInteractionPayload(interaction.payload);
}

function isQuestionWorkRow(row: TimelineRow): row is TimelineQuestionWorkRow {
  return row.kind === "work" && row.workKind === "question";
}

function collectQuestionRows(
  rows: readonly TimelineRow[],
): TimelineQuestionWorkRow[] {
  const questionRows: TimelineQuestionWorkRow[] = [];
  for (const row of rows) {
    if (isQuestionWorkRow(row)) {
      questionRows.push(row);
    }
    if (row.kind === "turn" && row.children) {
      questionRows.push(...collectQuestionRows(row.children));
    }
  }
  return questionRows;
}

describe.sequential("fake provider user-question integration", () => {
  it("pauses for a user question and resumes with the answer", () =>
    withHarness(
      {
        adapterFactory: (providerId) =>
          createFakeAdapter({
            displayName: providerId,
            id: providerId,
            supportsUserQuestion: true,
          }),
        featureFlags: {
          askUserQuestion: true,
        },
      },
      async (harness) => {
        const project = await createProjectFixture(
          harness,
          "User Question Smoke",
        );
        const { thread } = await createReadyThread(harness, {
          projectId: project.id,
          workspace: {
            type: "unmanaged",
            path: harness.repoDir,
          },
        });

        await sendTextMessage(harness.api, thread.id, {
          text: "ask_user",
        });
        await waitForEventType(
          harness.api,
          thread.id,
          "system/userQuestion/lifecycle",
          TURN_TIMEOUT_MS,
        );

        const interactions = await listThreadInteractions(
          harness.api,
          thread.id,
        );
        const interaction = interactions.find(isUserQuestionInteraction);
        if (!interaction) {
          throw new Error("Expected a pending user-question interaction");
        }
        expect(interaction.status).toBe("pending");

        const question = interaction.payload.questions[0];
        if (!question) {
          throw new Error("Expected a user-question payload question");
        }
        const stagingOption = question.options?.find(
          (option) => option.value === "staging",
        );
        if (!stagingOption) {
          throw new Error("Expected the fake provider staging option");
        }
        expect(question.prompt).toBe(
          "Which deployment path should the fake provider use?",
        );

        const resolution = {
          kind: "user_answer",
          answers: {
            [question.id]: {
              selected: [stagingOption.value],
              freeText: "Use staging first.",
            },
          },
        } satisfies PendingInteractionResolution;
        const resolvingInteraction = await resolveThreadInteraction({
          api: harness.api,
          threadId: thread.id,
          interactionId: interaction.id,
          resolution,
        });
        expect(resolvingInteraction.status).toBe("resolving");

        await waitForThreadStatus(
          harness.api,
          thread.id,
          "idle",
          TURN_TIMEOUT_MS,
        );

        await expect(
          listThreadInteractions(harness.api, thread.id),
        ).resolves.toEqual([]);
        await expect(
          getThreadOutput(harness.api, thread.id),
        ).resolves.toContain("Question answered: staging, Use staging first.");

        const timeline = await getThreadTimeline(harness.api, thread.id, {
          includeNestedRows: true,
        });
        const questionRow = collectQuestionRows(timeline.rows).find(
          (row) => row.interactionId === interaction.id,
        );
        expect(questionRow).toMatchObject({
          lifecycle: "answered",
          answers: resolution.answers,
        });
      },
    ));
});
