import { describe, expect, it } from "vitest";
import {
  createBuiltinPlanCommandTextInput,
  permissionModeInputSchema,
  permissionModeSchema,
  promptInputHasCommandMention,
  promptMentionCommandTriggerSchema,
  promptMentionCommandTriggerValues,
  promptMentionResourceSchema,
  removeCommandMentionsFromPromptInput,
  runtimePermissionPolicySchema,
} from "../src/shared-types.js";

describe("permission modes", () => {
  it("exposes only the three current public presets", () => {
    expect(permissionModeSchema.options).toEqual([
      "accept-edits",
      "auto",
      "full",
    ]);
    expect(permissionModeSchema.safeParse("workspace-write").success).toBe(
      false,
    );
    expect(permissionModeSchema.safeParse("readonly").success).toBe(false);
  });

  it("normalizes only the deprecated workspace-write input alias", () => {
    expect(permissionModeInputSchema.parse("workspace-write")).toBe(
      "accept-edits",
    );
    expect(permissionModeInputSchema.safeParse("readonly").success).toBe(false);
  });

  it("keeps runtime sandbox scope and reviewer behavior explicit", () => {
    expect(
      runtimePermissionPolicySchema.parse({
        permissionMode: "accept-edits",
        permissionScope: "workspace",
        approvalReviewer: "user",
        permissionEscalation: "ask",
      }),
    ).toEqual({
      permissionMode: "accept-edits",
      permissionScope: "workspace",
      approvalReviewer: "user",
      permissionEscalation: "ask",
    });
    expect(
      runtimePermissionPolicySchema.parse({
        permissionMode: "auto",
        permissionScope: "workspace",
        approvalReviewer: "automatic",
        permissionEscalation: "deny",
      }),
    ).toEqual({
      permissionMode: "auto",
      permissionScope: "workspace",
      approvalReviewer: "automatic",
      permissionEscalation: "deny",
    });
    expect(
      runtimePermissionPolicySchema.parse({
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      }),
    ).toEqual({
      permissionMode: "full",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
    });
    expect(
      runtimePermissionPolicySchema.safeParse({
        permissionMode: "auto",
        permissionScope: "full",
        approvalReviewer: "automatic",
        permissionEscalation: "ask",
      }).success,
    ).toBe(false);
  });
});

describe("prompt mention command triggers", () => {
  it("accepts slash as the only command trigger", () => {
    expect(promptMentionCommandTriggerValues).toEqual(["/"]);
    expect(promptMentionCommandTriggerSchema.safeParse("/").success).toBe(true);
    expect(promptMentionCommandTriggerSchema.safeParse("$").success).toBe(
      false,
    );
  });

  it("accepts built-in command mention resources", () => {
    expect(
      promptMentionResourceSchema.safeParse({
        kind: "command",
        trigger: "/",
        name: "compact",
        source: "command",
        origin: "builtin",
        label: "compact",
        argumentHint: null,
      }).success,
    ).toBe(true);
  });

  it("accepts old plugin mentions without icons and requires identity fields", () => {
    const resource = {
      kind: "plugin",
      pluginId: "linear",
      itemId: "issues:ISS-42",
      label: "Fix login bug",
    };
    const parsed = promptMentionResourceSchema.safeParse(resource);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual(resource);
    }
    expect(
      promptMentionResourceSchema.safeParse({
        kind: "plugin",
        pluginId: "linear",
        label: "Fix login bug",
      }).success,
    ).toBe(false);
  });

  it("normalizes persisted pre-section mention resources", () => {
    expect(
      promptMentionResourceSchema.parse({
        kind: "folder",
        folderId: "sec_release_qa",
        label: "Release QA",
      }),
    ).toEqual({
      kind: "section",
      sectionId: "sec_release_qa",
      label: "Release QA",
    });
  });

  it("rejects legacy dollar command mention resources", () => {
    expect(
      promptMentionResourceSchema.safeParse({
        kind: "command",
        trigger: "$",
        name: "review",
        source: "skill",
        origin: "user",
        label: "review",
        argumentHint: null,
      }).success,
    ).toBe(false);
  });
});

describe("prompt command input helpers", () => {
  it("detects and removes command mentions while preserving ordinary text", () => {
    const input = [
      {
        type: "text" as const,
        text: "/plan review @thread",
        mentions: [
          {
            start: 0,
            end: 5,
            resource: {
              kind: "command" as const,
              trigger: "/" as const,
              name: "plan",
              source: "command" as const,
              origin: "user" as const,
              label: "plan",
              argumentHint: null,
            },
          },
          {
            start: 13,
            end: 20,
            resource: {
              kind: "thread" as const,
              threadId: "thr_123",
              label: "thread",
            },
          },
        ],
      },
    ];

    expect(
      promptInputHasCommandMention(input, { trigger: "/", name: "plan" }),
    ).toBe(true);
    expect(
      removeCommandMentionsFromPromptInput(input, {
        trigger: "/",
        name: "plan",
      }),
    ).toEqual([
      {
        type: "text",
        text: "review @thread",
        mentions: [
          {
            start: 7,
            end: 14,
            resource: {
              kind: "thread",
              threadId: "thr_123",
              label: "thread",
            },
          },
        ],
      },
    ]);
  });

  it("ignores plain text that looks like a command", () => {
    const input = [
      { type: "text" as const, text: "/plan review", mentions: [] },
    ];

    expect(
      promptInputHasCommandMention(input, { trigger: "/", name: "plan" }),
    ).toBe(false);
    expect(
      removeCommandMentionsFromPromptInput(input, {
        trigger: "/",
        name: "plan",
      }),
    ).toEqual(input);
  });

  it("builds plan command input the plan selector recognizes and strips", () => {
    const input = [createBuiltinPlanCommandTextInput("review the diff")];

    expect(input[0]?.text).toBe("/plan review the diff");
    expect(
      promptInputHasCommandMention(input, { trigger: "/", name: "plan" }),
    ).toBe(true);
    expect(
      removeCommandMentionsFromPromptInput(input, {
        trigger: "/",
        name: "plan",
      }),
    ).toEqual([{ type: "text", text: "review the diff", mentions: [] }]);
    expect(
      removeCommandMentionsFromPromptInput(
        [createBuiltinPlanCommandTextInput("")],
        { trigger: "/", name: "plan" },
      ),
    ).toEqual([{ type: "text", text: "", mentions: [] }]);
  });
});
