import { describe, expect, it } from "vitest";
import {
  isPlanModePrompt,
  permissionDisplayForActivePromptMode,
  permissionDisplayForPromptMode,
  shouldDisablePermissionPickerForActivePromptMode,
} from "../src/prompt/effective-prompt-mode.js";

const planCommandMention = {
  start: 0,
  end: 5,
  resource: {
    kind: "command",
    trigger: "/",
    name: "plan",
    source: "command",
    origin: "user",
    label: "plan",
    argumentHint: null,
  },
} as const;

const PLAN_MODE_COPY =
  "The agent will plan without normal full-access execution.";

describe("permissionDisplayForPromptMode", () => {
  it("shows plan mode for a plan command pill on a provider that declares plan-mode copy", () => {
    expect(
      permissionDisplayForPromptMode({
        planModeCopy: PLAN_MODE_COPY,
        value: "/plan inspect the failing test",
        mentionRanges: [planCommandMention],
      }),
    ).toMatchObject({
      label: "Plan Mode",
      compactLabel: "Plan",
      description: PLAN_MODE_COPY,
    });
  });

  it("does not show plan mode for plain text or a provider without plan-mode copy", () => {
    expect(
      permissionDisplayForPromptMode({
        planModeCopy: PLAN_MODE_COPY,
        value: "/plan inspect the failing test",
        mentionRanges: [],
      }),
    ).toBeUndefined();
    expect(
      permissionDisplayForPromptMode({
        planModeCopy: undefined,
        value: "/plan inspect the failing test",
        mentionRanges: [planCommandMention],
      }),
    ).toBeUndefined();
  });
});

describe("permissionDisplayForActivePromptMode", () => {
  it("shows Plan Mode while a copy-declaring provider is actively planning", () => {
    expect(
      permissionDisplayForActivePromptMode(
        {
          mode: "plan",
          providerId: "claude-code",
          prompt: "inspect the failing test",
        },
        PLAN_MODE_COPY,
      ),
    ).toMatchObject({ label: "Plan Mode", compactLabel: "Plan" });
  });

  it("does not relabel plan mode as a permission mode without declared copy", () => {
    expect(
      permissionDisplayForActivePromptMode(
        {
          mode: "plan",
          providerId: "codex",
          prompt: "inspect the failing test",
        },
        undefined,
      ),
    ).toBeUndefined();
  });
});

describe("isPlanModePrompt", () => {
  it("locks permissions for a plan command pill on a copy-declaring provider", () => {
    expect(
      isPlanModePrompt({
        planModeCopy: PLAN_MODE_COPY,
        value: "/plan inspect the failing test",
        mentionRanges: [planCommandMention],
      }),
    ).toBe(true);
  });

  it("does not lock permissions for plain text or a provider without plan-mode copy", () => {
    expect(
      isPlanModePrompt({
        planModeCopy: PLAN_MODE_COPY,
        value: "/plan inspect the failing test",
        mentionRanges: [],
      }),
    ).toBe(false);
    expect(
      isPlanModePrompt({
        planModeCopy: undefined,
        value: "/plan inspect the failing test",
        mentionRanges: [planCommandMention],
      }),
    ).toBe(false);
  });
});

describe("shouldDisablePermissionPickerForActivePromptMode", () => {
  it("locks permissions for active plan mode across providers", () => {
    expect(
      shouldDisablePermissionPickerForActivePromptMode({
        mode: "plan",
        providerId: "claude-code",
        prompt: "inspect the failing test",
      }),
    ).toBe(true);
    expect(
      shouldDisablePermissionPickerForActivePromptMode({
        mode: "plan",
        providerId: "codex",
        prompt: "inspect the failing test",
      }),
    ).toBe(true);
  });

  it("does not lock permissions without an active prompt mode", () => {
    expect(shouldDisablePermissionPickerForActivePromptMode(null)).toBe(false);
  });
});
