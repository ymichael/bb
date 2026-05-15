// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadMetadataContent } from "./ThreadMetadataContent";
import { baseProps, makeEnvironment } from "./ThreadMetadataContent.fixtures";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";

type ClipboardWriteText = (text: string) => Promise<void>;

const WORKTREE_PATH = "/Users/michael/.bb-dev/worktrees/env_demo/bb";

function installClipboardWriteTextMock() {
  const writeText = vi.fn<ClipboardWriteText>();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ThreadMetadataContent", () => {
  it("renders a copyable worktree path for worktree environments", async () => {
    const writeText = installClipboardWriteTextMock();
    const { wrapper } = createQueryClientTestHarness();

    render(
      <ThreadMetadataContent
        {...baseProps}
        environment={makeEnvironment({ path: WORKTREE_PATH })}
      />,
      { wrapper },
    );

    expect(screen.getByText(WORKTREE_PATH)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Copy worktree path" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(WORKTREE_PATH);
    });
  });
});
