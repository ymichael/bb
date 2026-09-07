// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID } from "./provider-id.js";

const app = await loadPluginApp(() => import("./app"));
const { readCheckoutInputs } = await import("./app");

afterEach(() => {
  cleanup();
});

function inputsSlot() {
  const registration = app.environmentProviderInputs.find(
    (candidate) =>
      candidate.environmentProviderId ===
      PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID,
  );
  if (registration === undefined) {
    throw new Error("the checkout inputs control was not registered");
  }
  return registration;
}

describe("checkout inputs control", () => {
  it("submits the current checkout as soon as it mounts", async () => {
    const onChange = vi.fn();
    renderSlot(inputsSlot(), {
      projectId: "project-1",
      hostId: "host-a",
      value: null,
      onChange,
    });
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ status: "ready", value: {} });
    });
  });

  it("renders the current checkout chip", () => {
    const slot = renderSlot(inputsSlot(), {
      projectId: "project-1",
      hostId: "host-a",
      value: null,
      onChange: vi.fn(),
    });
    expect(
      slot.getByRole("combobox", { name: "Branch" }).textContent,
    ).toContain("Current (main)");
  });

  it("renders an existing branch pick on the chip", () => {
    const slot = renderSlot(inputsSlot(), {
      projectId: "project-1",
      hostId: "host-a",
      value: { branch: { kind: "existing", name: "release" } },
      onChange: vi.fn(),
    });
    expect(
      slot.getByRole("combobox", { name: "Branch" }).textContent,
    ).toContain("Checkout:release");
  });

  it("renders a new branch base on the chip", () => {
    const slot = renderSlot(inputsSlot(), {
      projectId: "project-1",
      hostId: "host-a",
      value: { branch: { kind: "new", baseBranch: "origin/main" } },
      onChange: vi.fn(),
    });
    const chipText = slot.getByRole("combobox", { name: "Branch" }).textContent;
    expect(chipText).toContain("New branch from");
    expect(chipText).toContain("origin/main");
  });

  it("keeps a seeded path while the branch changes", async () => {
    const onChange = vi.fn();
    const slot = renderSlot(
      inputsSlot(),
      {
        projectId: "project-1",
        hostId: "host-a",
        value: { path: "/srv/other-checkout" },
        onChange,
      },
      { branchesState: { branches: ["main", "release"] } },
    );
    fireEvent.click(slot.getByRole("combobox", { name: "Branch" }));
    fireEvent.click(await slot.findByRole("button", { name: "Checkout" }));
    fireEvent.click(await slot.findByRole("button", { name: "release" }));
    expect(onChange).toHaveBeenLastCalledWith({
      status: "ready",
      value: {
        path: "/srv/other-checkout",
        branch: { kind: "existing", name: "release" },
      },
    });
    cleanup();
    const cleared = renderSlot(inputsSlot(), {
      projectId: "project-1",
      hostId: "host-a",
      value: {
        path: "/srv/other-checkout",
        branch: { kind: "existing", name: "release" },
      },
      onChange,
    });
    fireEvent.click(cleared.getByRole("combobox", { name: "Branch" }));
    fireEvent.click(await cleared.findByTitle("Current: main"));
    expect(onChange).toHaveBeenLastCalledWith({
      status: "ready",
      value: { path: "/srv/other-checkout" },
    });
  });

  it("selects a searched existing branch with Enter and closes", async () => {
    const onChange = vi.fn();
    const slot = renderSlot(
      inputsSlot(),
      {
        projectId: "project-1",
        hostId: "host-a",
        value: null,
        onChange,
      },
      { branchesState: { branches: ["main", "release"] } },
    );
    const trigger = slot.getByRole("combobox", { name: "Branch" });
    fireEvent.click(trigger);
    fireEvent.click(await slot.findByRole("button", { name: "Checkout" }));
    const search = await slot.findByRole("textbox", {
      name: "Search branches",
    });
    fireEvent.change(search, { target: { value: "release" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith({
      status: "ready",
      value: { branch: { kind: "existing", name: "release" } },
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("selects a searched new-branch base with Enter and closes", async () => {
    const onChange = vi.fn();
    const slot = renderSlot(
      inputsSlot(),
      {
        projectId: "project-1",
        hostId: "host-a",
        value: { branch: { kind: "new", baseBranch: "main" } },
        onChange,
      },
      { branchesState: { branches: ["main", "release"] } },
    );
    const trigger = slot.getByRole("combobox", { name: "Branch" });
    fireEvent.click(trigger);
    const search = await slot.findByRole("textbox", {
      name: "Search branches",
    });
    fireEvent.change(search, { target: { value: "release" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith({
      status: "ready",
      value: { branch: { kind: "new", baseBranch: "release" } },
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("reports the checkout blocker through the inputs channel", async () => {
    const onChange = vi.fn();
    const slot = renderSlot(
      inputsSlot(),
      {
        projectId: "project-1",
        hostId: "host-a",
        value: { branch: { kind: "existing", name: "release" } },
        onChange,
      },
      {
        branchesState: { branches: ["main", "release"] },
        checkoutState: { dirty: true },
      },
    );
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({
        status: "blocked",
        reason: "Checkout blocked by uncommitted changes",
      });
    });
    expect(
      slot.getByRole("combobox", { name: "Branch" }).textContent,
    ).toContain("Checkout:release");
    fireEvent.click(slot.getByRole("combobox", { name: "Branch" }));
    const newBranch = (await slot.findByText("New")).closest("button");
    expect(newBranch).not.toBeNull();
    expect(newBranch).toHaveProperty("disabled", true);
    expect(newBranch?.getAttribute("title")).toBe(
      "Checkout blocked by uncommitted changes",
    );
    expect(slot.queryByRole("button", { name: "release" })).toBeNull();
    expect(slot.queryByRole("textbox", { name: "Search branches" })).toBeNull();
  });

  it("matches the checkout menu structure and enters new-branch mode in place", async () => {
    const onChange = vi.fn();
    const slot = renderSlot(
      inputsSlot(),
      {
        projectId: "project-1",
        hostId: "host-a",
        value: null,
        onChange,
      },
      {
        branchesState: {
          branches: ["main", "release"],
          remoteBranches: ["origin/main"],
        },
      },
    );
    const trigger = slot.getByRole("combobox", { name: "Branch" });
    fireEvent.click(trigger);

    expect(await slot.findByText("Start from:")).toBeTruthy();
    expect(slot.getAllByTitle("Current: main")).toHaveLength(2);
    expect(slot.getByTitle("New branch")).toBeTruthy();
    expect(slot.getByTitle("Checkout an existing branch")).toBeTruthy();
    expect(slot.queryByRole("textbox", { name: "Search branches" })).toBeNull();

    fireEvent.click(slot.getByTitle("New branch"));

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(await slot.findByText("Branch from:")).toBeTruthy();
    expect(slot.getByRole("textbox", { name: "Search branches" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "origin/main" })).toBeTruthy();
    expect(onChange).toHaveBeenLastCalledWith({
      status: "ready",
      value: { branch: { kind: "new", baseBranch: "main" } },
    });
  });

  it("reads only a well-formed branch out of the current value", () => {
    expect(
      readCheckoutInputs({ branch: { kind: "existing", name: "main" } }),
    ).toEqual({ path: null, branch: { kind: "existing", name: "main" } });
    expect(
      readCheckoutInputs({ branch: { kind: "named", name: "main" } }),
    ).toEqual({ path: null, branch: null });
    expect(readCheckoutInputs("main")).toEqual({ path: null, branch: null });
  });
});
