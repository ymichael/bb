// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionModePicker } from "./PermissionModePicker";

const permissionOptions = [
  { value: "accept-edits", label: "Accept Edits" },
  { value: "auto", label: "Approve for me" },
  { value: "full", label: "Full Access", tone: "warning" },
] as const;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PermissionModePicker", () => {
  it("keeps the warning mode caret aligned with the other prompt box carets", () => {
    const { container } = render(
      <PermissionModePicker
        value="full"
        options={permissionOptions}
        onChange={vi.fn()}
        supported
      />,
    );

    const caret = container.querySelector('[data-icon="ChevronDown"]');
    expect(caret).not.toBeNull();
    expect(caret!.classList).toContain("text-subtle-foreground/75");
    expect(caret!.classList).not.toContain("text-warning-text");
  });

  it("can show an effective display override without changing the selected value", () => {
    const onChange = vi.fn();
    render(
      <PermissionModePicker
        value="full"
        options={permissionOptions}
        onChange={onChange}
        supported
        displayOverride={{
          label: "Plan Mode",
          compactLabel: "Plan",
          description:
            "Claude Code will plan without normal full-access execution.",
        }}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Permission mode" });
    expect(trigger.textContent).toContain("Plan Mode");
    expect(trigger.textContent).not.toContain("Full Access");
  });
});
