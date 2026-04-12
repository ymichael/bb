// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { WorkspaceOpenTarget } from "@bb/host-daemon-contract";
import {
  WORKSPACE_OPEN_TARGET_STORAGE_KEY,
} from "@/lib/workspace-open-target-preference";
import { ThreadWorkspaceOpenButton } from "./ThreadWorkspaceOpenButton";

const TARGETS: WorkspaceOpenTarget[] = [
  {
    id: "vscode",
    label: "VS Code",
    kind: "editor",
  },
  {
    id: "finder",
    label: "Finder",
    kind: "file-manager",
  },
];

function installMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

beforeEach(() => {
  installMatchMedia();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("ThreadWorkspaceOpenButton", () => {
  it("opens the resolved preferred target from the primary button", async () => {
    const onOpenWorkspace = vi.fn(async () => undefined);

    render(
      <ThreadWorkspaceOpenButton
        onOpenWorkspace={onOpenWorkspace}
        targets={TARGETS}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open workspace in VS Code" }));

    await waitFor(() => {
      expect(onOpenWorkspace).toHaveBeenCalledWith("vscode");
    });
  });

  it("opens a menu target and stores it as the next preference", async () => {
    const onOpenWorkspace = vi.fn(async () => undefined);

    render(
      <ThreadWorkspaceOpenButton
        onOpenWorkspace={onOpenWorkspace}
        targets={TARGETS}
      />,
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Choose workspace open target" }),
    );
    expect(await screen.findByText("Editors")).toBeTruthy();
    expect(screen.getByText("File Managers")).toBeTruthy();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Finder" }));

    await waitFor(() => {
      expect(onOpenWorkspace).toHaveBeenCalledWith("finder");
    });
    expect(window.localStorage.getItem(WORKSPACE_OPEN_TARGET_STORAGE_KEY)).toBe("finder");
  });

  it("falls back when the stored preference is unavailable without rewriting it", async () => {
    window.localStorage.setItem(WORKSPACE_OPEN_TARGET_STORAGE_KEY, "cursor");
    const onOpenWorkspace = vi.fn(async () => undefined);

    render(
      <ThreadWorkspaceOpenButton
        onOpenWorkspace={onOpenWorkspace}
        targets={[TARGETS[0]]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open workspace in VS Code" }));

    await waitFor(() => {
      expect(onOpenWorkspace).toHaveBeenCalledWith("vscode");
    });
    expect(window.localStorage.getItem(WORKSPACE_OPEN_TARGET_STORAGE_KEY)).toBe("cursor");
  });
});
