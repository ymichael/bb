// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { WorkspaceOpenTarget } from "@bb/host-daemon-contract";
import { ThreadWorkspaceOpenButton } from "./ThreadWorkspaceOpenButton";

const TARGETS: WorkspaceOpenTarget[] = [
  {
    id: "vscode",
    kind: "editor",
    label: "VS Code",
  },
  {
    id: "finder",
    kind: "file-browser",
    label: "Finder",
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
  vi.restoreAllMocks();
});

describe("ThreadWorkspaceOpenButton", () => {
  it("opens the preferred target from the primary button", async () => {
    const onOpenPreferredTarget = vi.fn(async () => undefined);

    render(
      <ThreadWorkspaceOpenButton
        onOpenPreferredTarget={onOpenPreferredTarget}
        onOpenTarget={vi.fn(async () => undefined)}
        preferredTarget={TARGETS[0]}
        targets={TARGETS}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open workspace in VS Code" }),
    );

    await waitFor(() => {
      expect(onOpenPreferredTarget).toHaveBeenCalledTimes(1);
    });
  });

  it("opens the selected menu target", async () => {
    const onOpenTarget = vi.fn(async () => undefined);

    render(
      <ThreadWorkspaceOpenButton
        onOpenPreferredTarget={vi.fn(async () => undefined)}
        onOpenTarget={onOpenTarget}
        preferredTarget={TARGETS[0]}
        targets={TARGETS}
      />,
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Choose workspace open target" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Finder" }));

    await waitFor(() => {
      expect(onOpenTarget).toHaveBeenCalledWith("finder");
    });
  });

  it("renders nothing when no preferred target is available", () => {
    const { container } = render(
      <ThreadWorkspaceOpenButton
        onOpenPreferredTarget={vi.fn(async () => undefined)}
        onOpenTarget={vi.fn(async () => undefined)}
        preferredTarget={null}
        targets={TARGETS}
      />,
    );

    expect(container.firstChild).toBeNull();
  });
});
