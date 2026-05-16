import { describe, expect, it } from "vitest";
import {
  pendingInteractionMacOsPermissionsSchema,
  pendingInteractionCreateSchema,
  pendingInteractionSchema,
  USER_QUESTION_MAX_FREE_TEXT_LENGTH,
  USER_QUESTION_MAX_OPTIONS,
  USER_QUESTION_MAX_QUESTIONS,
  USER_QUESTION_MAX_SELECTED,
} from "../src/index.js";

describe("pending interaction schemas", () => {
  it("parses semantic command approval interactions", () => {
    expect(
      pendingInteractionCreateSchema.parse({
        threadId: "thr_123",
        turnId: "turn_123",
        providerId: "codex",
        providerThreadId: "provider-thread-123",
        providerRequestId: "request-123",
        payload: {
          kind: "approval",
          subject: {
            kind: "command",
            itemId: "item_123",
            command: "npm install",
            cwd: "/tmp/project",
            actions: [],
            sessionGrant: {
              network: { enabled: true },
              fileSystem: null,
            },
          },
          reason: "Needs network access",
          availableDecisions: ["allow_once", "allow_for_session", "deny"],
        },
      }),
    ).toMatchObject({
      providerId: "codex",
      payload: {
        kind: "approval",
        subject: {
          kind: "command",
        },
        availableDecisions: ["allow_once", "allow_for_session", "deny"],
      },
    });
  });

  it("parses semantic file-change approvals without diff fields", () => {
    expect(
      pendingInteractionCreateSchema.parse({
        threadId: "thr_124",
        turnId: "turn_124",
        providerId: "codex",
        providerThreadId: "provider-thread-124",
        providerRequestId: "request-124",
        payload: {
          kind: "approval",
          subject: {
            kind: "file_change",
            itemId: "item_124",
            writeScope: "/tmp/project",
            sessionGrant: null,
          },
          reason: "Review file edits",
          availableDecisions: ["allow_once", "deny"],
        },
      }),
    ).toMatchObject({
      payload: {
        subject: {
          kind: "file_change",
          itemId: "item_124",
        },
      },
    });
  });

  it("parses semantic permission grant approval resolutions", () => {
    expect(
      pendingInteractionSchema.parse({
        id: "pi_125",
        threadId: "thr_125",
        turnId: "turn_125",
        providerId: "claude-code",
        providerThreadId: "provider-thread-125",
        providerRequestId: "request-125",
        status: "resolved",
        payload: {
          kind: "approval",
          subject: {
            kind: "permission_grant",
            itemId: "item_125",
            toolName: "WebFetch",
            permissions: {
              network: {
                enabled: true,
              },
              fileSystem: null,
            },
          },
          reason: null,
          availableDecisions: ["allow_once", "allow_for_session", "deny"],
        },
        resolution: {
          decision: "allow_for_session",
          grantedPermissions: {
            network: {
              enabled: true,
            },
            fileSystem: null,
          },
        },
        statusReason: null,
        createdAt: 1,
        resolvedAt: 2,
      }),
    ).toMatchObject({
      resolution: {
        decision: "allow_for_session",
      },
    });
  });

  it("parses provider-agnostic user questions and answers", () => {
    expect(
      pendingInteractionSchema.parse({
        id: "pi_question_1",
        threadId: "thr_question_1",
        turnId: "turn_question_1",
        providerId: "claude-code",
        providerThreadId: "provider-thread-question-1",
        providerRequestId: "request-question-1",
        status: "resolved",
        payload: {
          kind: "user_question",
          questions: [
            {
              id: "q1",
              prompt: "Which branch should I update?",
              shortLabel: "Branch",
              multiSelect: false,
              options: [
                {
                  value: "main",
                  label: "main",
                  description: "Current default branch",
                },
                { value: "feature", label: "feature/user-question" },
              ],
              allowFreeText: true,
            },
          ],
        },
        resolution: {
          kind: "user_answer",
          answers: {
            q1: {
              selected: ["feature"],
              freeText: "Use the feature branch.",
            },
          },
        },
        statusReason: null,
        createdAt: 1,
        resolvedAt: 2,
      }),
    ).toMatchObject({
      payload: {
        kind: "user_question",
        questions: [
          {
            id: "q1",
            prompt: "Which branch should I update?",
          },
        ],
      },
      resolution: {
        kind: "user_answer",
        answers: {
          q1: {
            selected: ["feature"],
          },
        },
      },
    });
  });

  it("rejects malformed user question payloads and answer shapes", () => {
    expect(() =>
      pendingInteractionCreateSchema.parse({
        threadId: "thr_question_invalid",
        turnId: "turn_question_invalid",
        providerId: "claude-code",
        providerThreadId: "provider-thread-question-invalid",
        providerRequestId: "request-question-invalid",
        payload: {
          kind: "user_question",
          questions: [
            {
              id: "q1",
              prompt: "",
              multiSelect: false,
              allowFreeText: true,
            },
          ],
        },
      }),
    ).toThrow();

    expect(() =>
      pendingInteractionCreateSchema.parse({
        threadId: "thr_question_empty",
        turnId: "turn_question_empty",
        providerId: "claude-code",
        providerThreadId: "provider-thread-question-empty",
        providerRequestId: "request-question-empty",
        payload: {
          kind: "user_question",
          questions: [],
        },
      }),
    ).toThrow();

    expect(() =>
      pendingInteractionCreateSchema.parse({
        threadId: "thr_question_unanswerable",
        turnId: "turn_question_unanswerable",
        providerId: "claude-code",
        providerThreadId: "provider-thread-question-unanswerable",
        providerRequestId: "request-question-unanswerable",
        payload: {
          kind: "user_question",
          questions: [
            {
              id: "q1",
              prompt: "Which branch should I update?",
              multiSelect: false,
              options: [],
              allowFreeText: false,
            },
          ],
        },
      }),
    ).toThrow();

    expect(() =>
      pendingInteractionCreateSchema.parse({
        threadId: "thr_question_duplicate",
        turnId: "turn_question_duplicate",
        providerId: "claude-code",
        providerThreadId: "provider-thread-question-duplicate",
        providerRequestId: "request-question-duplicate",
        payload: {
          kind: "user_question",
          questions: [
            {
              id: "q1",
              prompt: "Which branch should I update?",
              multiSelect: false,
              allowFreeText: true,
            },
            {
              id: "q1",
              prompt: "Should I run tests?",
              multiSelect: false,
              allowFreeText: true,
            },
          ],
        },
      }),
    ).toThrow("User question ids must be unique");

    expect(() =>
      pendingInteractionSchema.parse({
        id: "pi_question_invalid",
        threadId: "thr_question_invalid",
        turnId: "turn_question_invalid",
        providerId: "claude-code",
        providerThreadId: "provider-thread-question-invalid",
        providerRequestId: "request-question-invalid",
        status: "resolved",
        payload: {
          kind: "user_question",
          questions: [
            {
              id: "q1",
              prompt: "Which branch should I update?",
              multiSelect: false,
              allowFreeText: true,
            },
          ],
        },
        resolution: {
          kind: "user_answer",
          answers: {
            q1: {
              freeText: "Use the feature branch.",
            },
          },
        },
        statusReason: null,
        createdAt: 1,
        resolvedAt: 2,
      }),
    ).toThrow();

    expect(() =>
      pendingInteractionSchema.parse({
        id: "pi_question_blank_text",
        threadId: "thr_question_blank_text",
        turnId: "turn_question_blank_text",
        providerId: "claude-code",
        providerThreadId: "provider-thread-question-blank-text",
        providerRequestId: "request-question-blank-text",
        status: "resolved",
        payload: {
          kind: "user_question",
          questions: [
            {
              id: "q1",
              prompt: "Which branch should I update?",
              multiSelect: false,
              allowFreeText: true,
            },
          ],
        },
        resolution: {
          kind: "user_answer",
          answers: {
            q1: {
              selected: [],
              freeText: "   ",
            },
          },
        },
        statusReason: null,
        createdAt: 1,
        resolvedAt: 2,
      }),
    ).toThrow("User question free text cannot be blank");
  });

  it("rejects bounded or ambiguous user question shapes", () => {
    const validQuestion = {
      id: "q1",
      prompt: "Which branch should I update?",
      shortLabel: "Branch",
      multiSelect: true,
      options: [
        { value: "main", label: "main" },
        { value: "feature", label: "feature/user-question" },
      ],
      allowFreeText: true,
    };

    expect(() =>
      pendingInteractionCreateSchema.parse({
        threadId: "thr_question_too_many_questions",
        turnId: "turn_question_too_many_questions",
        providerId: "claude-code",
        providerThreadId: "provider-thread-question-too-many-questions",
        providerRequestId: "request-question-too-many-questions",
        payload: {
          kind: "user_question",
          questions: Array.from(
            { length: USER_QUESTION_MAX_QUESTIONS + 1 },
            (_, index) => ({
              ...validQuestion,
              id: `q${index}`,
              prompt: `Question ${index}`,
            }),
          ),
        },
      }),
    ).toThrow(
      `User questions cannot include more than ${USER_QUESTION_MAX_QUESTIONS} questions`,
    );

    expect(() =>
      pendingInteractionCreateSchema.parse({
        threadId: "thr_question_too_many_options",
        turnId: "turn_question_too_many_options",
        providerId: "claude-code",
        providerThreadId: "provider-thread-question-too-many-options",
        providerRequestId: "request-question-too-many-options",
        payload: {
          kind: "user_question",
          questions: [
            {
              ...validQuestion,
              options: Array.from(
                { length: USER_QUESTION_MAX_OPTIONS + 1 },
                (_, index) => ({
                  value: `option-${index}`,
                  label: `Option ${index}`,
                }),
              ),
            },
          ],
        },
      }),
    ).toThrow(
      `User questions cannot include more than ${USER_QUESTION_MAX_OPTIONS} options`,
    );

    expect(() =>
      pendingInteractionSchema.parse({
        id: "pi_question_too_many_selected",
        threadId: "thr_question_too_many_selected",
        turnId: "turn_question_too_many_selected",
        providerId: "claude-code",
        providerThreadId: "provider-thread-question-too-many-selected",
        providerRequestId: "request-question-too-many-selected",
        status: "resolved",
        payload: {
          kind: "user_question",
          questions: [validQuestion],
        },
        resolution: {
          kind: "user_answer",
          answers: {
            q1: {
              selected: Array.from(
                { length: USER_QUESTION_MAX_SELECTED + 1 },
                (_, index) => `option-${index}`,
              ),
            },
          },
        },
        statusReason: null,
        createdAt: 1,
        resolvedAt: 2,
      }),
    ).toThrow(
      `User question selected choices cannot exceed ${USER_QUESTION_MAX_SELECTED}`,
    );

    expect(() =>
      pendingInteractionSchema.parse({
        id: "pi_question_oversized_text",
        threadId: "thr_question_oversized_text",
        turnId: "turn_question_oversized_text",
        providerId: "claude-code",
        providerThreadId: "provider-thread-question-oversized-text",
        providerRequestId: "request-question-oversized-text",
        status: "resolved",
        payload: {
          kind: "user_question",
          questions: [validQuestion],
        },
        resolution: {
          kind: "user_answer",
          answers: {
            q1: {
              selected: [],
              freeText: "x".repeat(USER_QUESTION_MAX_FREE_TEXT_LENGTH + 1),
            },
          },
        },
        statusReason: null,
        createdAt: 1,
        resolvedAt: 2,
      }),
    ).toThrow(
      `User question free text cannot exceed ${USER_QUESTION_MAX_FREE_TEXT_LENGTH} characters`,
    );

    expect(() =>
      pendingInteractionCreateSchema.parse({
        threadId: "thr_question_duplicate_option",
        turnId: "turn_question_duplicate_option",
        providerId: "claude-code",
        providerThreadId: "provider-thread-question-duplicate-option",
        providerRequestId: "request-question-duplicate-option",
        payload: {
          kind: "user_question",
          questions: [
            {
              ...validQuestion,
              options: [
                { value: "main", label: "main" },
                { value: "main", label: "Duplicate main" },
              ],
            },
          ],
        },
      }),
    ).toThrow("User question option values must be unique");

    const blankPayloadCases = [
      {
        payload: { ...validQuestion, id: "   " },
        message: "User question ids cannot be blank",
      },
      {
        payload: { ...validQuestion, prompt: "   " },
        message: "User question prompts cannot be blank",
      },
      {
        payload: { ...validQuestion, shortLabel: "   " },
        message: "User question short labels cannot be blank",
      },
      {
        payload: {
          ...validQuestion,
          options: [{ value: "   ", label: "main" }],
        },
        message: "User question option values cannot be blank",
      },
      {
        payload: {
          ...validQuestion,
          options: [{ value: "main", label: "   " }],
        },
        message: "User question option labels cannot be blank",
      },
      {
        payload: {
          ...validQuestion,
          options: [
            {
              value: "main",
              label: "main",
              description: "   ",
            },
          ],
        },
        message: "User question option descriptions cannot be blank",
      },
    ];

    for (const testCase of blankPayloadCases) {
      expect(() =>
        pendingInteractionCreateSchema.parse({
          threadId: `thr_question_blank_${testCase.message}`,
          turnId: `turn_question_blank_${testCase.message}`,
          providerId: "claude-code",
          providerThreadId: `provider-thread-question-blank-${testCase.message}`,
          providerRequestId: `request-question-blank-${testCase.message}`,
          payload: {
            kind: "user_question",
            questions: [testCase.payload],
          },
        }),
      ).toThrow(testCase.message);
    }
  });

  it("rejects invalid macOS automation permission values", () => {
    expect(() =>
      pendingInteractionMacOsPermissionsSchema.parse({
        preferences: "none",
        automations: "invalid",
        launchServices: false,
        accessibility: false,
        calendar: false,
        reminders: false,
        contacts: "none",
      }),
    ).toThrow();
  });
});
