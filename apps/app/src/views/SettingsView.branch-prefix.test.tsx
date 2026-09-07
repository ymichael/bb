// @vitest-environment jsdom
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeneralSettingsSection } from "./SettingsView";

afterEach(cleanup);

function renderSection(overrides?: {
  managedBranchPrefix?: string;
  onManagedBranchPrefixChange?: (prefix: string) => void;
}) {
  return render(
    <GeneralSettingsSection
      desktopBrowserAvailable={false}
      managedBranchPrefix={overrides?.managedBranchPrefix ?? "bb/"}
      managedBranchPrefixDisabled={false}
      navigateToThreadAfterCreate={false}
      onManagedBranchPrefixChange={
        overrides?.onManagedBranchPrefixChange ?? vi.fn()
      }
      onNavigateToThreadAfterCreateChange={vi.fn()}
      onOpenLinksInAppBrowserChange={vi.fn()}
      onRewriteLocalhostLinksChange={vi.fn()}
      onRichTextEditingChange={vi.fn()}
      onSteerActiveThreadOnEnterChange={vi.fn()}
      onStreamerModeChange={vi.fn()}
      openLinksInAppBrowser={false}
      rewriteLocalhostLinks={false}
      richTextEditing={false}
      steerActiveThreadOnEnter={false}
      steerActiveThreadOnEnterDisabled={false}
      streamerMode={false}
      streamerModeDisabled={false}
    />,
  );
}

function branchPrefixInput() {
  const input = screen.getByLabelText("Worktree branch prefix");
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("Worktree branch prefix control is not an input");
  }
  return input;
}

describe("worktree branch prefix setting", () => {
  it("saves a valid prefix on Enter", () => {
    const onChange = vi.fn();
    renderSection({ onManagedBranchPrefixChange: onChange });
    const input = branchPrefixInput();
    fireEvent.change(input, { target: { value: "sawyer/wt-" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("sawyer/wt-");
  });

  it("saves an empty prefix", () => {
    const onChange = vi.fn();
    renderSection({ onManagedBranchPrefixChange: onChange });
    const input = branchPrefixInput();
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("restores the saved value when saving fails", async () => {
    const failedSave = Promise.reject(new Error("write failed"));
    void failedSave.catch(() => undefined);
    const onChange = vi.fn(() => failedSave);
    renderSection({ onManagedBranchPrefixChange: onChange });
    const input = branchPrefixInput();
    fireEvent.change(input, { target: { value: "team/" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(input.value).toBe("bb/"));
  });

  it("refuses an invalid prefix and restores the saved value", () => {
    const onChange = vi.fn();
    renderSection({ onManagedBranchPrefixChange: onChange });
    const input = branchPrefixInput();
    fireEvent.change(input, { target: { value: "bad prefix/" } });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("bb/");
  });

  it("reverts the draft on Escape", () => {
    const onChange = vi.fn();
    renderSection({ onManagedBranchPrefixChange: onChange });
    const input = branchPrefixInput();
    fireEvent.change(input, { target: { value: "sawyer/" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("bb/");
    expect(onChange).not.toHaveBeenCalled();
  });
});
