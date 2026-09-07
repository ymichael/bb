// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { makeThread } from "@bb/test-helpers/domain-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadActionsMenu } from "./ThreadActionsMenu";

const mocks = vi.hoisted(() => ({
  copyToClipboardWithToast: vi.fn(),
}));

vi.mock("@/lib/clipboard", () => ({
  copyToClipboardWithToast: mocks.copyToClipboardWithToast,
}));

vi.mock("./ThreadActionsProvider", () => ({
  useThreadActions: () => ({
    archiveThreadAndChildren: vi.fn(),
    requestRename: vi.fn(),
    requestDelete: vi.fn(),
    togglePin: vi.fn(),
    toggleRead: vi.fn(),
    unarchiveThread: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  mocks.copyToClipboardWithToast.mockReset();
});

describe("ThreadActionsMenu", () => {
  it("copies the canonical thread URL from every menu instance", () => {
    render(<ThreadActionsMenu thread={makeThread()} />);

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Thread actions" }),
      { button: 0 },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy thread link" }));

    expect(mocks.copyToClipboardWithToast).toHaveBeenCalledWith(
      `${window.location.origin}/projects/proj_test/threads/thr_test`,
      {
        successMessage: "Thread link copied",
        errorMessage: "Failed to copy thread link",
      },
    );
  });
});
