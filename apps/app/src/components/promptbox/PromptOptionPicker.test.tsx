// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptOptionPicker } from "./PromptOptionPicker";

function createMatchMediaResult(query: string): MediaQueryList {
  return {
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  };
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(createMatchMediaResult),
  });
});

afterEach(() => {
  cleanup();
});

describe("PromptOptionPicker", () => {
  it("renders option descriptions in the existing prompt control menu", () => {
    const onChange = vi.fn();
    render(
      <PromptOptionPicker
        label="Permissions"
        value="full"
        onChange={onChange}
        options={[
          {
            value: "full",
            label: "Full",
            description: "No permission prompts. The agent can use full provider permissions.",
            tone: "warning",
          },
          {
            value: "workspace-write",
            label: "Workspace Write",
            description: "Can edit and run safely inside the workspace.",
          },
        ]}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Permissions" });
    expect(trigger.getAttribute("title")).toBe(
      "Permissions: Full - No permission prompts. The agent can use full provider permissions.",
    );

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });

    expect(screen.getByText("Workspace Write")).not.toBeNull();
    expect(screen.getByText("Can edit and run safely inside the workspace.")).not.toBeNull();
  });
});
