// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { GIT_WORKTREE_ENVIRONMENT_PROVIDER_ID } from "./provider-id.js";

const app = await loadPluginApp(() => import("./app"));
const { selectedBranchName } = await import("./app");

afterEach(() => {
  cleanup();
});

function inputsSlot() {
  const registration = app.environmentProviderInputs.find(
    (candidate) =>
      candidate.environmentProviderId === GIT_WORKTREE_ENVIRONMENT_PROVIDER_ID,
  );
  if (registration === undefined) {
    throw new Error("the worktree inputs control was not registered");
  }
  return registration;
}

describe("worktree inputs control", () => {
  it("registers for the worktree provider only", () => {
    expect(
      app.environmentProviderInputs.map((r) => r.environmentProviderId),
    ).toEqual([GIT_WORKTREE_ENVIRONMENT_PROVIDER_ID]);
  });

  it("submits the default branch as soon as it mounts", async () => {
    const onChange = vi.fn();
    renderSlot(inputsSlot(), {
      projectId: "project-1",
      hostId: "host-a",
      value: null,
      onChange,
    });
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({
        status: "ready",
        value: { branch: { kind: "default" } },
      });
    });
  });

  it("binds bb's branch picker to the picked machine and project", () => {
    const slot = renderSlot(inputsSlot(), {
      projectId: "project-1",
      hostId: "host-a",
      value: { branch: { kind: "named", name: "release" } },
      onChange: vi.fn(),
    });
    const picker = slot.getByTestId("bb-branch-picker");
    expect(picker.getAttribute("data-host-id")).toBe("host-a");
    expect(picker.getAttribute("data-project-id")).toBe("project-1");
    expect(slot.getByLabelText("Branch from:")).toHaveProperty(
      "value",
      "release",
    );
  });

  it("names the picked branch", () => {
    const onChange = vi.fn();
    const slot = renderSlot(inputsSlot(), {
      projectId: "project-1",
      hostId: "host-a",
      value: { branch: { kind: "default" } },
      onChange,
    });
    fireEvent.change(slot.getByLabelText("Branch from:"), {
      target: { value: "release" },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      status: "ready",
      value: { branch: { kind: "named", name: "release" } },
    });
  });

  it("falls back to the default branch when the pick is cleared", () => {
    const onChange = vi.fn();
    const slot = renderSlot(inputsSlot(), {
      projectId: "project-1",
      hostId: "host-a",
      value: { branch: { kind: "named", name: "release" } },
      onChange,
    });
    fireEvent.change(slot.getByLabelText("Branch from:"), {
      target: { value: "" },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      status: "ready",
      value: { branch: { kind: "default" } },
    });
  });

  it("reads only a named branch out of the current value", () => {
    expect(
      selectedBranchName({ branch: { kind: "named", name: "main" } }),
    ).toBe("main");
    expect(selectedBranchName({ branch: { kind: "default" } })).toBeNull();
    expect(selectedBranchName(null)).toBeNull();
    expect(selectedBranchName("main")).toBeNull();
  });
});
