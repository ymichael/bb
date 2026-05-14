// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FollowUpPromptBox,
  type FollowUpPromptBoxProps,
} from "./FollowUpPromptBox";

function makeFollowUpPromptBoxProps(): FollowUpPromptBoxProps {
  return {
    attachments: {},
    stack: null,
    composer: {
      history: {
        currentDraft: { text: "", attachments: [] },
        entries: [],
        onSelectEntry: vi.fn(),
      },
      isFollowUpSubmitting: false,
      message: "Please continue",
      onChangeMessage: vi.fn(),
      onSteerSubmit: vi.fn(),
      onSubmit: vi.fn(),
      promptPlaceholder: "Stopping thread...",
      canSteerSubmit: false,
      submitMode: { kind: "blocked", reason: "stopping" },
      threadRuntimeDisplayStatus: "active",
    },
    environmentSummary: null,
    contextWindowUsage: null,
    execution: {
      provider: {},
      model: {
        selected: "gpt-5",
        options: [],
        onChange: vi.fn(),
      },
      reasoning: {
        value: "medium",
        options: [],
        onChange: vi.fn(),
      },
    },
    permission: {
      value: "full",
      options: [],
      onChange: vi.fn(),
      supported: false,
    },
    mentions: {
      suggestions: [],
      isLoading: false,
      isError: false,
      onQueryChange: vi.fn(),
    },
    zenModeResetKey: "thread-1",
  };
}

afterEach(() => {
  cleanup();
});

describe("FollowUpPromptBox", () => {
  it("shows a stopping submit state when the composer is blocked for stopping", () => {
    render(<FollowUpPromptBox {...makeFollowUpPromptBoxProps()} />);

    expect(screen.getByPlaceholderText("Stopping thread...")).toBeTruthy();
    expect(screen.queryByTitle("Stop run")).toBeNull();

    const stoppingButton = screen.getByTitle("Stopping run...");
    if (!(stoppingButton instanceof HTMLButtonElement)) {
      throw new Error("Expected stopping affordance to render as a button");
    }
    expect(stoppingButton.disabled).toBe(true);
  });

  it("sends steers with Cmd+Enter without invoking the normal submit", () => {
    const props = makeFollowUpPromptBoxProps();
    const onSteerSubmit = vi.fn();
    const onSubmit = vi.fn();
    props.composer = {
      ...props.composer,
      canSteerSubmit: true,
      onSteerSubmit,
      onSubmit,
      promptPlaceholder: "Ask for follow-up changes",
      submitMode: { kind: "queue", onStop: vi.fn() },
    };

    render(<FollowUpPromptBox {...props} />);

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    const wasNotCanceled = fireEvent.keyDown(textarea, {
      key: "Enter",
      metaKey: true,
    });

    expect(wasNotCanceled).toBe(false);
    expect(onSteerSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("uses the normal submit path for Cmd+Enter when steer is unavailable", () => {
    const props = makeFollowUpPromptBoxProps();
    const onSteerSubmit = vi.fn();
    const onSubmit = vi.fn();
    props.composer = {
      ...props.composer,
      canSteerSubmit: false,
      onSteerSubmit,
      onSubmit,
      promptPlaceholder: "Ask for follow-up changes",
      submitMode: { kind: "ready" },
    };

    render(<FollowUpPromptBox {...props} />);

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    const wasNotCanceled = fireEvent.keyDown(textarea, {
      key: "Enter",
      metaKey: true,
    });

    expect(wasNotCanceled).toBe(false);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSteerSubmit).not.toHaveBeenCalled();
  });

  it("preserves ordinary Enter submit behavior", () => {
    const props = makeFollowUpPromptBoxProps();
    const onSteerSubmit = vi.fn();
    const onSubmit = vi.fn();
    props.composer = {
      ...props.composer,
      canSteerSubmit: true,
      onSteerSubmit,
      onSubmit,
      promptPlaceholder: "Ask for follow-up changes",
      submitMode: { kind: "queue", onStop: vi.fn() },
    };

    render(<FollowUpPromptBox {...props} />);

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    const wasNotCanceled = fireEvent.keyDown(textarea, { key: "Enter" });

    expect(wasNotCanceled).toBe(false);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSteerSubmit).not.toHaveBeenCalled();
  });
});
