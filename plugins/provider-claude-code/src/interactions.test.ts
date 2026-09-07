import { describe, expect, it } from "vitest";
import { providerInteractionOutcomeSchema } from "@bb/domain";
import type {
  PendingInteractionResolution,
  UserQuestionPendingInteractionPayload,
  UserQuestionPendingInteractionResolution,
} from "@bb/domain";
import {
  buildClaudeApprovalInteractionPayload,
  buildClaudeInteractiveResponse,
  buildClaudeUserQuestionPayload,
} from "./interactions.js";
import {
  claudePermissionRequestApprovalParamsSchema,
  claudeUserQuestionRequestParamsSchema,
} from "./interactive-contract.js";

function decodeApproval(params: unknown) {
  return buildClaudeApprovalInteractionPayload(
    claudePermissionRequestApprovalParamsSchema.parse(params),
  );
}

function decodeUserQuestion(params: unknown) {
  return buildClaudeUserQuestionPayload(
    claudeUserQuestionRequestParamsSchema.parse(params),
  );
}

function createClaudeUserQuestionPayload(): UserQuestionPendingInteractionPayload {
  return {
    kind: "user_question",
    questions: [
      {
        id: "toolu_question:question-1",
        prompt: "Which deployment target should I use?",
        shortLabel: "Target",
        multiSelect: false,
        options: [
          {
            value: "toolu_question:question-1:option-1",
            label: "Staging",
            description: "Deploy to the staging environment.",
          },
          {
            value: "toolu_question:question-1:option-2",
            label: "Production",
            description: "Deploy to production.",
          },
        ],
        allowFreeText: true,
      },
    ],
  };
}

interface InvalidClaudeUserQuestionAnswerCase {
  expectedMessage: string;
  name: string;
  resolution: UserQuestionPendingInteractionResolution;
}

const invalidClaudeUserQuestionAnswerCases: InvalidClaudeUserQuestionAnswerCase[] =
  [
    {
      name: "missing answer",
      resolution: {
        kind: "user_answer",
        answers: {},
      },
      expectedMessage: "Missing answer for user question",
    },
    {
      name: "unknown selected option",
      resolution: {
        kind: "user_answer",
        answers: {
          "toolu_question:question-1": {
            selected: ["toolu_question:question-1:option-missing"],
          },
        },
      },
      expectedMessage: "Unknown selected option",
    },
    {
      name: "empty answer",
      resolution: {
        kind: "user_answer",
        answers: {
          "toolu_question:question-1": {
            selected: [],
          },
        },
      },
      expectedMessage: "Answer for user question",
    },
  ];

describe("claude-code interactive requests", () => {
  it("decodes Claude permission approval requests into pending interactions", () => {
    expect(
      decodeApproval({
        threadId: "thr_1",
        providerThreadId: "claude-session-1",
        turnId: "turn-provider",
        itemId: "toolu_1",
        toolName: "WebFetch",
        input: { url: "https://example.com" },
        reason: "Needs approval",
        permissions: {
          network: { enabled: true },
          fileSystem: null,
        },
      }),
    ).toEqual({
      kind: "approval",
      subject: {
        kind: "permission_grant",
        itemId: "toolu_1",
        toolName: "WebFetch",
        permissions: {
          network: { enabled: true },
          fileSystem: null,
        },
      },
      reason: "Needs approval",
      availableDecisions: ["allow_once", "allow_for_session", "deny"],
    });
  });

  it("decodes Claude Bash approvals with command execution scope", () => {
    expect(
      decodeApproval({
        threadId: "thr_1",
        providerThreadId: "claude-session-1",
        turnId: "turn-bash",
        itemId: "toolu_bash",
        toolName: "Bash",
        input: { command: "git status", cwd: "/tmp/project" },
        reason: "Needs approval",
        permissions: {
          network: null,
          fileSystem: {
            read: ["/tmp/project"],
            write: ["/tmp/project"],
          },
        },
      }),
    ).toMatchObject({
      kind: "approval",
      subject: {
        kind: "command",
        itemId: "toolu_bash",
        command: "git status",
        cwd: "/tmp/project",
        actions: [{ type: "unknown", command: "git status" }],
        sessionGrant: {
          network: null,
          fileSystem: {
            read: ["/tmp/project"],
            write: ["/tmp/project"],
          },
        },
      },
    });
  });

  it("decodes ExitPlanMode approvals into a plan review the user can judge", () => {
    expect(
      decodeApproval({
        threadId: "thr_1",
        providerThreadId: "claude-session-1",
        turnId: "turn-plan",
        itemId: "toolu_plan",
        toolName: "ExitPlanMode",
        input: {
          plan: "# Plan\n\nShip it.",
          planFilePath: "/tmp/plans/ship-it.md",
        },
        reason: null,
        permissions: { network: null, fileSystem: null },
      }),
    ).toMatchObject({
      kind: "approval",
      availableDecisions: ["allow_once", "deny"],
      subject: {
        kind: "plan",
        itemId: "toolu_plan",
        plan: "# Plan\n\nShip it.",
        planFilePath: "/tmp/plans/ship-it.md",
      },
    });
  });

  it("tells the model to gather feedback when the user rejects a plan", () => {
    const response = buildClaudeInteractiveResponse({
      payload: {
        kind: "approval",
        reason: null,
        availableDecisions: ["allow_once", "deny"],
        subject: {
          kind: "plan",
          itemId: "toolu_plan",
          plan: "# Plan",
          planFilePath: null,
        },
      },
      resolution: { decision: "deny" },
    });

    expect(response).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("AskUserQuestion"),
    });
  });

  it("decodes Claude Edit approvals with file-change execution scope", () => {
    expect(
      decodeApproval({
        threadId: "thr_1",
        providerThreadId: "claude-session-1",
        turnId: "turn-edit",
        itemId: "toolu_edit",
        toolName: "Edit",
        input: {
          file_path: "/tmp/project/README.md",
          old_string: "before",
          new_string: "after",
        },
        reason: "Needs approval",
        permissions: {
          network: null,
          fileSystem: {
            read: [],
            write: ["/tmp/project"],
          },
        },
      }),
    ).toMatchObject({
      kind: "approval",
      subject: {
        kind: "file_change",
        itemId: "toolu_edit",
        writeScope: null,
        sessionGrant: {
          network: null,
          fileSystem: {
            read: [],
            write: ["/tmp/project"],
          },
        },
      },
    });
  });

  it("rejects malformed Claude permission approval payloads", () => {
    expect(
      claudePermissionRequestApprovalParamsSchema.safeParse({
        threadId: "thr_1",
        providerThreadId: "claude-session-1",
        turnId: null,
        itemId: "toolu_1",
        toolName: "WebFetch",
        input: { url: "https://example.com" },
        reason: "Needs approval",
        permissions: {
          network: { enabled: "yes" },
          fileSystem: null,
        },
      }).success,
    ).toBe(false);
  });

  it("decodes Claude AskUserQuestion requests into user-question interactions", () => {
    expect(
      decodeUserQuestion({
        threadId: "thr_1",
        providerThreadId: "claude-session-1",
        turnId: "turn-question",
        itemId: "toolu_question",
        questions: [
          {
            question: "Which deployment target should I use?",
            header: "Target",
            options: [
              {
                label: "Staging",
                description: "Deploy to the staging environment.",
              },
              {
                label: "Production",
                description: "Deploy to production.",
                preview: "prod",
              },
            ],
            multiSelect: false,
          },
        ],
      }),
    ).toEqual({
      kind: "user_question",
      questions: [
        {
          id: "toolu_question:question-1",
          prompt: "Which deployment target should I use?",
          shortLabel: "Target",
          multiSelect: false,
          options: [
            {
              value: "toolu_question:question-1:option-1",
              label: "Staging",
              description: "Deploy to the staging environment.",
            },
            {
              value: "toolu_question:question-1:option-2",
              label: "Production",
              description: "Deploy to production.",
            },
          ],
          allowFreeText: true,
        },
      ],
    });
  });

  it("rejects Claude AskUserQuestion requests with duplicate prompts", () => {
    expect(
      claudeUserQuestionRequestParamsSchema.safeParse({
        threadId: "thr_1",
        providerThreadId: "claude-session-1",
        turnId: "turn-question",
        itemId: "toolu_question",
        questions: [
          {
            question: "Which deployment target should I use?",
            header: "Target",
            options: [
              {
                label: "Staging",
                description: "Deploy to the staging environment.",
              },
              {
                label: "Production",
                description: "Deploy to production.",
              },
            ],
            multiSelect: false,
          },
          {
            question: "Which deployment target should I use?",
            header: "Fallback",
            options: [
              {
                label: "Rollback",
                description: "Rollback to the previous release.",
              },
              {
                label: "Pause",
                description: "Pause deployment.",
              },
            ],
            multiSelect: false,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("builds Claude permission approval responses", () => {
    expect(
      buildClaudeInteractiveResponse({
        payload: {
          kind: "approval",
          subject: {
            kind: "permission_grant",
            itemId: "toolu_3",
            toolName: "WebFetch",
            permissions: {
              network: { enabled: true },
              fileSystem: null,
            },
          },
          reason: "Needs network",
          availableDecisions: ["allow_once", "allow_for_session", "deny"],
        },
        resolution: {
          decision: "allow_for_session",
          grantedPermissions: {
            network: { enabled: true },
            fileSystem: null,
          },
        },
      }),
    ).toEqual({
      kind: "permission_request",
      behavior: "allow",
      decisionClassification: "user_permanent",
      updatedPermissions: [
        {
          type: "addRules",
          rules: [{ toolName: "WebFetch" }],
          behavior: "allow",
          destination: "session",
        },
      ],
    });
  });

  it("builds Claude AskUserQuestion answer responses", () => {
    expect(
      buildClaudeInteractiveResponse({
        payload: {
          kind: "user_question",
          questions: [
            {
              id: "toolu_question:question-1",
              prompt: "Which deployment target should I use?",
              shortLabel: "Target",
              multiSelect: false,
              options: [
                {
                  value: "toolu_question:question-1:option-1",
                  label: "Staging",
                  description: "Deploy to the staging environment.",
                },
                {
                  value: "toolu_question:question-1:option-2",
                  label: "Production",
                  description: "Deploy to production.",
                },
              ],
              allowFreeText: true,
            },
          ],
        },
        resolution: {
          kind: "user_answer",
          answers: {
            "toolu_question:question-1": {
              selected: ["toolu_question:question-1:option-1"],
              freeText: "Use staging until QA signs off.",
            },
          },
        },
      }),
    ).toEqual({
      kind: "user_question",
      behavior: "allow",
      updatedInput: {
        questions: [
          {
            question: "Which deployment target should I use?",
            header: "Target",
            options: [
              {
                label: "Staging",
                description: "Deploy to the staging environment.",
              },
              {
                label: "Production",
                description: "Deploy to production.",
              },
            ],
            multiSelect: false,
          },
        ],
        answers: {
          "Which deployment target should I use?":
            "Staging; Use staging until QA signs off.",
        },
        annotations: {
          "Which deployment target should I use?": {
            notes: "Use staging until QA signs off.",
          },
        },
      },
    });
  });

  it("keeps free-text-only Claude AskUserQuestion answers in the primary answer text", () => {
    expect(
      buildClaudeInteractiveResponse({
        payload: {
          kind: "user_question",
          questions: [
            {
              id: "toolu_question:question-1",
              prompt: "Which deployment target should I use?",
              shortLabel: "Target",
              multiSelect: false,
              options: [
                {
                  value: "toolu_question:question-1:option-1",
                  label: "Staging",
                  description: "Deploy to the staging environment.",
                },
              ],
              allowFreeText: true,
            },
          ],
        },
        resolution: {
          kind: "user_answer",
          answers: {
            "toolu_question:question-1": {
              selected: [],
              freeText: "Use the target from the release ticket.",
            },
          },
        },
      }),
    ).toMatchObject({
      updatedInput: {
        answers: {
          "Which deployment target should I use?":
            "Use the target from the release ticket.",
        },
      },
    });
  });

  it("combines multi-select and free-text Claude AskUserQuestion answers", () => {
    expect(
      buildClaudeInteractiveResponse({
        payload: {
          kind: "user_question",
          questions: [
            {
              id: "toolu_question:question-1",
              prompt: "Which deployment targets should I use?",
              shortLabel: "Targets",
              multiSelect: true,
              options: [
                {
                  value: "toolu_question:question-1:option-1",
                  label: "Staging",
                  description: "Deploy to the staging environment.",
                },
                {
                  value: "toolu_question:question-1:option-2",
                  label: "Production",
                  description: "Deploy to production.",
                },
              ],
              allowFreeText: true,
            },
          ],
        },
        resolution: {
          kind: "user_answer",
          answers: {
            "toolu_question:question-1": {
              selected: [
                "toolu_question:question-1:option-1",
                "toolu_question:question-1:option-2",
              ],
              freeText: "Use staging first.",
            },
          },
        },
      }),
    ).toMatchObject({
      updatedInput: {
        answers: {
          "Which deployment targets should I use?":
            "Staging, Production; Use staging first.",
        },
        annotations: {
          "Which deployment targets should I use?": {
            notes: "Use staging first.",
          },
        },
      },
    });
  });

  it("rejects Claude AskUserQuestion responses with duplicate prompts", () => {
    const payload = createClaudeUserQuestionPayload();
    const firstQuestion = payload.questions[0];
    if (!firstQuestion) {
      throw new Error("Expected user-question helper to create a question");
    }
    const duplicatePromptPayload: UserQuestionPendingInteractionPayload = {
      ...payload,
      questions: [
        firstQuestion,
        {
          ...firstQuestion,
          id: "toolu_question:question-2",
        },
      ],
    };

    expect(() =>
      buildClaudeInteractiveResponse({
        payload: duplicatePromptPayload,
        resolution: {
          kind: "user_answer",
          answers: {
            "toolu_question:question-1": {
              selected: ["toolu_question:question-1:option-1"],
            },
            "toolu_question:question-2": {
              selected: ["toolu_question:question-1:option-2"],
            },
          },
        },
      }),
    ).toThrow(
      "Claude user-question prompts must be unique; duplicate prompt 'Which deployment target should I use?'",
    );
  });

  it.each(invalidClaudeUserQuestionAnswerCases)(
    "rejects invalid Claude AskUserQuestion answers: $name",
    (testCase) => {
      expect(() =>
        buildClaudeInteractiveResponse({
          payload: createClaudeUserQuestionPayload(),
          resolution: testCase.resolution,
        }),
      ).toThrow(testCase.expectedMessage);
    },
  );

  it("cannot pair an AskUserQuestion payload with an approval decision: the wire parse rejects it", () => {
    const resolution: PendingInteractionResolution = {
      decision: "deny",
    };

    expect(
      providerInteractionOutcomeSchema.safeParse({
        payload: createClaudeUserQuestionPayload(),
        resolution,
      }).success,
    ).toBe(false);
  });

  it("rejects Claude AskUserQuestion response payloads without returnable options", () => {
    const payload: UserQuestionPendingInteractionPayload = {
      kind: "user_question",
      questions: [
        {
          id: "toolu_question:question-1",
          prompt: "Which deployment target should I use?",
          shortLabel: "Target",
          multiSelect: false,
          allowFreeText: true,
        },
      ],
    };

    expect(() =>
      buildClaudeInteractiveResponse({
        payload,
        resolution: {
          kind: "user_answer",
          answers: {
            "toolu_question:question-1": {
              selected: [],
              freeText: "Use the target from the release ticket.",
            },
          },
        },
      }),
    ).toThrow("has no options to return to Claude");
  });

  it("fills missing Claude AskUserQuestion option descriptions with option labels", () => {
    const payload: UserQuestionPendingInteractionPayload = {
      kind: "user_question",
      questions: [
        {
          id: "toolu_question:question-1",
          prompt: "Which deployment target should I use?",
          shortLabel: "Target",
          multiSelect: false,
          options: [
            {
              value: "toolu_question:question-1:option-1",
              label: "Staging",
            },
            {
              value: "toolu_question:question-1:option-2",
              label: "Production",
            },
          ],
          allowFreeText: true,
        },
      ],
    };

    expect(
      buildClaudeInteractiveResponse({
        payload,
        resolution: {
          kind: "user_answer",
          answers: {
            "toolu_question:question-1": {
              selected: ["toolu_question:question-1:option-1"],
            },
          },
        },
      }),
    ).toMatchObject({
      kind: "user_question",
      updatedInput: {
        questions: [
          {
            options: [
              {
                label: "Staging",
                description: "Staging",
              },
              {
                label: "Production",
                description: "Production",
              },
            ],
          },
        ],
      },
    });
  });

  it("builds Claude session permission updates for command approvals", () => {
    expect(
      buildClaudeInteractiveResponse({
        payload: {
          kind: "approval",
          subject: {
            kind: "command",
            itemId: "toolu_3b",
            command: "pwd",
            cwd: null,
            actions: [],
            sessionGrant: {
              network: null,
              fileSystem: {
                read: ["/tmp/project"],
                write: ["/tmp/project"],
              },
            },
          },
          reason: "Needs approval",
          availableDecisions: ["allow_once", "allow_for_session", "deny"],
        },
        resolution: {
          decision: "allow_for_session",
          grantedPermissions: {
            network: null,
            fileSystem: {
              read: ["/tmp/project"],
              write: ["/tmp/project"],
            },
          },
        },
      }),
    ).toEqual({
      kind: "permission_request",
      behavior: "allow",
      decisionClassification: "user_permanent",
      updatedPermissions: [
        {
          type: "addDirectories",
          directories: ["/tmp/project"],
          destination: "session",
        },
      ],
    });
  });

  it("builds Claude session directory updates for file-change approvals", () => {
    expect(
      buildClaudeInteractiveResponse({
        payload: {
          kind: "approval",
          subject: {
            kind: "file_change",
            itemId: "toolu_3d",
            writeScope: null,
            sessionGrant: {
              network: null,
              fileSystem: {
                read: [],
                write: ["/tmp/project"],
              },
            },
          },
          reason: "Needs file access",
          availableDecisions: ["allow_once", "allow_for_session", "deny"],
        },
        resolution: {
          decision: "allow_for_session",
          grantedPermissions: {
            network: null,
            fileSystem: {
              read: [],
              write: ["/tmp/project"],
            },
          },
        },
      }),
    ).toEqual({
      kind: "permission_request",
      behavior: "allow",
      decisionClassification: "user_permanent",
      updatedPermissions: [
        {
          type: "addDirectories",
          directories: ["/tmp/project"],
          destination: "session",
        },
      ],
    });
  });

  it("rejects session-scoped Claude approvals without an explicit resolution grant", () => {
    expect(() =>
      buildClaudeInteractiveResponse({
        payload: {
          kind: "approval",
          subject: {
            kind: "file_change",
            itemId: "toolu_3e",
            writeScope: null,
            sessionGrant: null,
          },
          reason: "Needs file access",
          availableDecisions: ["allow_once", "allow_for_session", "deny"],
        },
        resolution: {
          decision: "allow_for_session",
          grantedPermissions: null,
        },
      }),
    ).toThrow("Session approval resolution must include granted permissions");
  });

  it("keeps turn-scoped Claude permission approvals scoped to the current tool request", () => {
    expect(
      buildClaudeInteractiveResponse({
        payload: {
          kind: "approval",
          subject: {
            kind: "command",
            itemId: "toolu_3c",
            command: "pwd",
            cwd: null,
            actions: [],
            sessionGrant: null,
          },
          reason: "Needs approval",
          availableDecisions: ["allow_once", "deny"],
        },
        resolution: {
          decision: "allow_once",
          grantedPermissions: null,
        },
      }),
    ).toEqual({
      kind: "permission_request",
      behavior: "allow",
      decisionClassification: "user_temporary",
    });
  });
});
