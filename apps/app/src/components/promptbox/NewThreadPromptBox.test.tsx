// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Host, ProjectSource } from "@bb/domain";
import { makeHost } from "@bb/test-helpers/domain-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectlessMachineSlot, ThreadEnvSlot } from "./NewThreadPromptBox";

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

describe("ThreadEnvSlot", () => {
  it("forwards worktree disabled reasons to the environment picker", () => {
    render(
      <ThreadEnvSlot
        environment={{
          value: `host:${host.id}:local`,
          onChange: vi.fn(),
          sources,
          host,
          isLocal: true,
          worktreeDisabledReason: "Project source is not a git repository",
        }}
        branch={{
          value: null,
          currentBranch: null,
          isNew: false,
          options: [],
          onChange: vi.fn(),
        }}
        worktree={{
          options: [],
          value: null,
          onChange: vi.fn(),
        }}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Environment" }), {
      button: 0,
    });

    const worktreeItem = screen.getByRole("menuitem", {
      name: /New worktree/u,
    });

    expect(worktreeItem.getAttribute("aria-disabled")).toBe("true");
  });

  it("hides the branch picker when branch controls are not applicable", () => {
    render(
      <ThreadEnvSlot
        environment={{
          value: `host:${host.id}:local`,
          onChange: vi.fn(),
          sources,
          host,
          isLocal: true,
        }}
        branch={{
          value: null,
          currentBranch: null,
          isNew: false,
          hidden: true,
          options: [],
          triggerLabel: "Unknown checkout",
          onChange: vi.fn(),
        }}
        worktree={{
          options: [],
          value: null,
          onChange: vi.fn(),
        }}
      />,
    );

    expect(screen.queryByText("Unknown checkout")).toBeNull();
  });
});

describe("ProjectlessMachineSlot", () => {
  const secondHost: Host = {
    ...host,
    id: "host_second",
    name: "Mac Studio",
  };

  function makeEnvironment(overrides?: {
    value?: string;
    onChange?: (value: string) => void;
    machines?: {
      hosts: Host[];
      localDaemonHostId: string | null;
      primaryHostId: string | null;
    } | null;
  }) {
    return {
      value: overrides?.value ?? `host:${host.id}:local`,
      onChange: overrides?.onChange ?? vi.fn(),
      sources: [],
      host,
      isLocal: true,
      machines:
        overrides && "machines" in overrides
          ? overrides.machines
          : {
              hosts: [host, secondHost],
              localDaemonHostId: host.id,
              primaryHostId: host.id,
            },
    };
  }

  it("renders no chip without multi-machine host data", () => {
    render(
      <ProjectlessMachineSlot
        environment={makeEnvironment({ machines: null })}
      />,
    );

    expect(screen.queryByRole("button", { name: "Machine" })).toBeNull();
  });

  it("renders no chip with a single host", () => {
    render(
      <ProjectlessMachineSlot
        environment={makeEnvironment({
          machines: {
            hosts: [host],
            localDaemonHostId: host.id,
            primaryHostId: host.id,
          },
        })}
      />,
    );

    expect(screen.queryByRole("button", { name: "Machine" })).toBeNull();
  });

  it("encodes a machine pick as that host's personal-local environment value", () => {
    const onChange = vi.fn();
    render(
      <ProjectlessMachineSlot environment={makeEnvironment({ onChange })} />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Machine" }), {
      button: 0,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: /Mac Studio/u }));

    expect(onChange).toHaveBeenCalledWith(`host:${secondHost.id}:local`);
  });

  it("names the selected machine in the chip", () => {
    render(
      <ProjectlessMachineSlot
        environment={makeEnvironment({ value: `host:${secondHost.id}:local` })}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Machine" }).textContent,
    ).toContain("Mac Studio");
  });
});
