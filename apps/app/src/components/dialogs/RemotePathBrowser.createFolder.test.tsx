// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { HostDirectoryListing } from "@bb/server-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  RemotePathBrowser,
  getFolderNameValidationMessage,
  joinHostPath,
} from "./RemotePathBrowser";

vi.mock("@/lib/sdk", () => ({
  BbHttpError: class BbHttpError extends Error {},
  sdk: {
    files: { mkdir: vi.fn() },
    hosts: { directory: vi.fn() },
  },
}));

const directory = vi.mocked(sdk.hosts.directory);
const mkdir = vi.mocked(sdk.files.mkdir);

function listing(path: string, entries: string[]): HostDirectoryListing {
  return {
    directory: path,
    parent: "/home",
    entries: entries.map((name) => ({
      kind: "directory" as const,
      name,
      path: `${path}/${name}`,
    })),
  };
}

const ENTRY_TEST_ROW_HEIGHT_PX = 28;
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.tagName === "LI" ? ENTRY_TEST_ROW_HEIGHT_PX : 224;
    },
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("joinHostPath", () => {
  it("joins with the separator implied by the directory", () => {
    expect(joinHostPath("/home/me", "repo")).toBe("/home/me/repo");
    expect(joinHostPath("/", "repo")).toBe("/repo");
    expect(joinHostPath("/home/me/", "repo")).toBe("/home/me/repo");
    expect(joinHostPath("C:\\Users\\me", "repo")).toBe("C:\\Users\\me\\repo");
    expect(joinHostPath("C:\\", "repo")).toBe("C:\\repo");
  });
});

describe("getFolderNameValidationMessage", () => {
  it("rejects names that would create outside the current folder", () => {
    expect(getFolderNameValidationMessage("repo")).toBeNull();
    expect(getFolderNameValidationMessage("")).not.toBeNull();
    expect(getFolderNameValidationMessage("..")).not.toBeNull();
    expect(getFolderNameValidationMessage("a/b")).not.toBeNull();
    expect(getFolderNameValidationMessage("a\\b")).not.toBeNull();
  });
});

describe("RemotePathBrowser new folder", () => {
  it("hides folder creation for existing-folder pickers", async () => {
    directory.mockResolvedValue(listing("/home/me", ["existing"]));
    const { wrapper: Wrapper } = createQueryClientTestHarness();

    render(
      <Wrapper>
        <RemotePathBrowser
          hostId="host_atum"
          allowCreateFolder={false}
          onDirectoryChange={vi.fn()}
        />
      </Wrapper>,
    );

    await screen.findByText("existing");
    expect(screen.queryByRole("button", { name: "New folder" })).toBeNull();
  });

  it("does not create in the previous folder while navigation is loading", async () => {
    let resolveNextDirectory: (value: HostDirectoryListing) => void = () => {};
    const nextDirectory = new Promise<HostDirectoryListing>((resolve) => {
      resolveNextDirectory = resolve;
    });
    directory.mockImplementation(({ path }) =>
      path === "/home/me/next"
        ? nextDirectory
        : Promise.resolve(listing("/home/me", ["next"])),
    );
    const { wrapper: Wrapper } = createQueryClientTestHarness();

    render(
      <Wrapper>
        <RemotePathBrowser
          hostId="host_atum"
          allowCreateFolder
          onDirectoryChange={vi.fn()}
        />
      </Wrapper>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "next" }));
    await waitFor(() => {
      expect(directory).toHaveBeenCalledWith(
        expect.objectContaining({ path: "/home/me/next" }),
      );
    });

    expect(
      screen
        .getByRole("button", { name: "New folder" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.queryByLabelText("New folder name")).toBeNull();
    expect(mkdir).not.toHaveBeenCalled();

    resolveNextDirectory(listing("/home/me/next", []));
    await screen.findByText("This folder is empty.");
  });

  it("creates the folder on the host and selects it", async () => {
    directory.mockImplementation(async ({ path }) =>
      path === "/home/me/repo"
        ? listing("/home/me/repo", [])
        : listing("/home/me", ["existing"]),
    );
    mkdir.mockResolvedValue({ ok: true });
    const onDirectoryChange = vi.fn();
    const { wrapper: Wrapper } = createQueryClientTestHarness();

    render(
      <Wrapper>
        <RemotePathBrowser
          hostId="host_atum"
          allowCreateFolder
          onDirectoryChange={onDirectoryChange}
        />
      </Wrapper>,
    );

    await screen.findByText("existing");
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    fireEvent.change(screen.getByLabelText("New folder name"), {
      target: { value: "repo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));

    await waitFor(() => {
      expect(mkdir).toHaveBeenCalledWith({
        hostId: "host_atum",
        path: "/home/me/repo",
      });
    });
    await waitFor(() => {
      expect(onDirectoryChange).toHaveBeenLastCalledWith("/home/me/repo");
    });
  });

  it("locks navigation while folder creation is pending", async () => {
    let resolveMkdir: (value: { ok: true }) => void = () => {};
    const pendingMkdir = new Promise<{ ok: true }>((resolve) => {
      resolveMkdir = resolve;
    });
    directory.mockImplementation(async ({ path }) =>
      path === "/home/me/repo"
        ? listing("/home/me/repo", [])
        : listing("/home/me", ["existing"]),
    );
    mkdir.mockReturnValue(pendingMkdir);
    const { wrapper: Wrapper } = createQueryClientTestHarness();

    render(
      <Wrapper>
        <RemotePathBrowser
          hostId="host_atum"
          allowCreateFolder
          onDirectoryChange={vi.fn()}
        />
      </Wrapper>,
    );

    await screen.findByText("existing");
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    fireEvent.change(screen.getByLabelText("New folder name"), {
      target: { value: "repo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));

    await waitFor(() => {
      expect(mkdir).toHaveBeenCalledOnce();
    });
    expect(
      screen.getByRole("button", { name: "existing" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Go to parent folder" })
        .hasAttribute("disabled"),
    ).toBe(true);

    resolveMkdir({ ok: true });
    await screen.findByText("This folder is empty.");
  });

  it("reports a failed create instead of navigating into it", async () => {
    directory.mockResolvedValue(listing("/home/me", ["existing"]));
    mkdir.mockRejectedValue(new Error("EEXIST: file already exists"));
    const onDirectoryChange = vi.fn();
    const { wrapper: Wrapper } = createQueryClientTestHarness();

    render(
      <Wrapper>
        <RemotePathBrowser
          hostId="host_atum"
          allowCreateFolder
          onDirectoryChange={onDirectoryChange}
        />
      </Wrapper>,
    );

    await screen.findByText("existing");
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    fireEvent.change(screen.getByLabelText("New folder name"), {
      target: { value: "existing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));

    expect(await screen.findByText(/already exists/)).toBeTruthy();
    expect(onDirectoryChange).not.toHaveBeenCalledWith("/home/me/existing");
  });
});

describe("RemotePathBrowser entry list", () => {
  it("mounts only the entries near the viewport for a huge directory", async () => {
    const names = Array.from(
      { length: 5000 },
      (_, i) => `file_${String(i).padStart(5, "0")}`,
    );
    directory.mockResolvedValue(listing("/home/me/manyfiles", names));
    const { wrapper: Wrapper } = createQueryClientTestHarness();

    const { container } = render(
      <Wrapper>
        <RemotePathBrowser
          hostId="host_atum"
          allowCreateFolder={false}
          onDirectoryChange={vi.fn()}
        />
      </Wrapper>,
    );

    await screen.findByText("file_00000");
    const mountedRows = container.querySelectorAll("li");
    expect(mountedRows.length).toBeLessThan(60);
    expect(mountedRows.length).toBeGreaterThanOrEqual(8);
    expect(screen.queryByText("file_04999")).toBeNull();

    const list = container.querySelector("ul");
    const scrollBox = list?.parentElement;
    if (!(scrollBox instanceof HTMLElement)) throw new Error("no scroll box");
    scrollBox.scrollTop = 4_999 * ENTRY_TEST_ROW_HEIGHT_PX;
    fireEvent.scroll(scrollBox);
    expect(await screen.findByText("file_04999")).not.toBeNull();
    expect(screen.queryByText("file_00000")).toBeNull();
    expect(container.querySelectorAll("li").length).toBeLessThan(60);
  });
});
