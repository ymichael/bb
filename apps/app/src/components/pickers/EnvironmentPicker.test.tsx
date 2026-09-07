// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Host, ProjectSource } from "@bb/domain";
import { makeHost } from "@bb/test-helpers/domain-fixtures";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvironmentPickerUI } from "./EnvironmentPicker";

const host = makeHost({
  id: "host_test",
  name: "Local host",
});

const sources: readonly ProjectSource[] = [
  {
    id: "src_test",
    projectId: "proj_test",
    type: "local_path",
    hostId: host.id,
    path: "/tmp/project",
    isDefault: true,
    createdAt: 0,
    updatedAt: 0,
  },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("EnvironmentPickerUI", () => {
  it("disables new worktree without disabling local work for non-git sources", () => {
    render(
      <EnvironmentPickerUI
        value={`host:${host.id}:local`}
        onChange={vi.fn()}
        sources={sources}
        host={host}
        isLocal
        worktreeDisabledReason="Project source is not a git repository"
        modal={false}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Environment" }), {
      button: 0,
    });

    const localItem = screen.getByRole("menuitem", { name: /Work locally/u });
    const worktreeItem = screen.getByRole("menuitem", {
      name: /New worktree/u,
    });

    expect(localItem.getAttribute("aria-disabled")).toBeNull();
    expect(worktreeItem.getAttribute("aria-disabled")).toBe("true");
    expect(
      screen.getByText("Project source is not a git repository"),
    ).toBeTruthy();
  });
});

describe("EnvironmentPickerUI multi-machine menu", () => {
  const HOUR_MS = 60 * 60 * 1000;

  const thisMachine: Host = {
    ...host,
    id: "host_local",
    name: "MacBook Pro",
  };
  const studio: Host = {
    ...host,
    id: "host_studio",
    name: "Mac Studio",
  };
  const devVm: Host = {
    ...host,
    id: "host_vm",
    name: "dev-vm",
    status: "disconnected",
    lastSeenAt: Date.now() - 2 * HOUR_MS,
  };

  const machineSources: readonly ProjectSource[] = [
    { ...sources[0]!, id: "src_local", hostId: thisMachine.id, path: "~/bb" },
    { ...sources[0]!, id: "src_studio", hostId: studio.id, path: "~/code/bb" },
  ];

  function renderMachineMenu(overrides?: {
    value?: string;
    onChange?: (value: string) => void;
  }) {
    render(
      <EnvironmentPickerUI
        value={overrides?.value ?? `host:${thisMachine.id}:local`}
        onChange={overrides?.onChange ?? vi.fn()}
        sources={machineSources}
        host={thisMachine}
        isLocal
        machines={{
          hosts: [thisMachine, studio, devVm],
          localDaemonHostId: thisMachine.id,
          primaryHostId: thisMachine.id,
        }}
        modal={false}
      />,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Environment" }), {
      button: 0,
    });
  }

  it("groups options per machine and encodes values with each machine's host id", () => {
    const onChange = vi.fn();
    renderMachineMenu({ onChange });

    expect(screen.getByText("MacBook Pro")).toBeTruthy();
    expect(screen.getByText("this machine")).toBeTruthy();
    expect(screen.getByText("Mac Studio")).toBeTruthy();

    const worktreeItems = screen.getAllByRole("menuitem", {
      name: /New worktree/u,
    });
    expect(worktreeItems).toHaveLength(2);
    fireEvent.click(worktreeItems[1]!);
    expect(onChange).toHaveBeenCalledWith(`host:${studio.id}:worktree`);
  });

  it("disables an offline machine's options and shows when it was last seen", () => {
    const onChange = vi.fn();
    renderMachineMenu({ onChange });

    expect(screen.getByText(/last seen 2h ago/u)).toBeTruthy();
    const placeholder = screen.getByRole("menuitem", {
      name: "Not set up for this project",
    });
    expect(placeholder.getAttribute("aria-disabled")).toBe("true");
  });

  it("shows protocol versions instead of plain offline metadata for stale daemons", () => {
    const staleVm: Host = {
      ...devVm,
      lastRejectedProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION - 1,
    };
    render(
      <EnvironmentPickerUI
        value={`host:${thisMachine.id}:local`}
        onChange={vi.fn()}
        sources={machineSources}
        host={thisMachine}
        isLocal
        machines={{
          hosts: [thisMachine, staleVm],
          localDaemonHostId: thisMachine.id,
          primaryHostId: thisMachine.id,
        }}
        modal={false}
      />,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Environment" }), {
      button: 0,
    });

    expect(
      screen.getByText(
        `Needs update · daemon protocol ${HOST_DAEMON_PROTOCOL_VERSION - 1} · server protocol ${HOST_DAEMON_PROTOCOL_VERSION}`,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/last seen 2h ago/u)).toBeNull();
  });

  it("disables options on an offline machine that has a source", () => {
    const offlineStudio: Host = { ...studio, status: "disconnected" };
    render(
      <EnvironmentPickerUI
        value={`host:${thisMachine.id}:local`}
        onChange={vi.fn()}
        sources={machineSources}
        host={thisMachine}
        isLocal
        machines={{
          hosts: [thisMachine, offlineStudio],
          localDaemonHostId: thisMachine.id,
          primaryHostId: thisMachine.id,
        }}
        modal={false}
      />,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Environment" }), {
      button: 0,
    });

    const checkoutItem = screen.getByRole("menuitem", {
      name: /Work in checkout/u,
    });
    expect(checkoutItem.getAttribute("aria-disabled")).toBe("true");
  });

  it("offers guided setup for a connected machine without a source", () => {
    const onRequestMachineSetup = vi.fn();
    const onlineVm: Host = { ...devVm, status: "connected", lastSeenAt: null };
    render(
      <EnvironmentPickerUI
        value={`host:${thisMachine.id}:local`}
        onChange={vi.fn()}
        sources={machineSources}
        host={thisMachine}
        isLocal
        machines={{
          hosts: [thisMachine, studio, onlineVm],
          localDaemonHostId: thisMachine.id,
          primaryHostId: thisMachine.id,
        }}
        onRequestMachineSetup={onRequestMachineSetup}
        modal={false}
      />,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Environment" }), {
      button: 0,
    });

    expect(screen.queryByText("Not set up for this project")).toBeNull();
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Set up on dev-vm…/u }),
    );
    expect(onRequestMachineSetup).toHaveBeenCalledWith(onlineVm);
  });

  it("keeps the disabled not-set-up row for an offline machine", () => {
    render(
      <EnvironmentPickerUI
        value={`host:${thisMachine.id}:local`}
        onChange={vi.fn()}
        sources={machineSources}
        host={thisMachine}
        isLocal
        machines={{
          hosts: [thisMachine, studio, devVm],
          localDaemonHostId: thisMachine.id,
          primaryHostId: thisMachine.id,
        }}
        onRequestMachineSetup={vi.fn()}
        modal={false}
      />,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Environment" }), {
      button: 0,
    });

    expect(screen.queryByText(/Set up on dev-vm/u)).toBeNull();
    const placeholder = screen.getByRole("menuitem", {
      name: "Not set up for this project",
    });
    expect(placeholder.getAttribute("aria-disabled")).toBe("true");
  });

  it("names the primary machine in the trigger label when multiple machines exist", () => {
    renderMachineMenu({ value: `host:${thisMachine.id}:worktree` });

    expect(screen.getByText("MacBook Pro · New worktree")).toBeTruthy();
    expect(screen.getByText("Worktree")).toBeTruthy();
  });

  it("names another selected machine in the trigger label", () => {
    renderMachineMenu({ value: `host:${studio.id}:worktree` });

    expect(screen.getByText("Mac Studio · New worktree")).toBeTruthy();
    expect(screen.getByText("Worktree")).toBeTruthy();
  });

  it("keeps the single-host menu when only one host exists", () => {
    render(
      <EnvironmentPickerUI
        value={`host:${thisMachine.id}:local`}
        onChange={vi.fn()}
        sources={machineSources}
        host={thisMachine}
        isLocal
        machines={{
          hosts: [thisMachine],
          localDaemonHostId: thisMachine.id,
          primaryHostId: thisMachine.id,
        }}
        modal={false}
      />,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Environment" }), {
      button: 0,
    });

    expect(
      screen.getByRole("menuitem", { name: /Work locally/u }),
    ).toBeTruthy();
    expect(screen.queryByText("MacBook Pro")).toBeNull();
  });
});
