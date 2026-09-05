// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Host } from "@bb/domain";
import { makeHost } from "@bb/test-helpers/domain-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SystemEnvironmentProvider } from "@bb/server-contract";
import {
  ProjectlessEnvSlot,
  ProjectlessMachineSlot,
} from "./NewThreadPromptBox";

const host = makeHost({
  id: "host_test",
  name: "Local host",
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProjectlessMachineSlot", () => {
  const secondHost: Host = {
    ...host,
    id: "host_second",
    name: "Mac Studio",
  };

  const personalWorkspaceProvider: SystemEnvironmentProvider = {
    id: "personal-workspace",
    displayName: "Personal workspace",
    icon: "Folder",
    logoUrl: null,
    pluginId: "environment-personal-workspace",
    acceptsEmptyInputs: true,
    availability: null,
    requires: {
      projectCheckout: false,
      gitCheckout: false,
      gitRemote: false,
      projectless: true,
    },
    inputs: null,
  };

  function makeEnvironment(overrides?: {
    selectedProviderHostId?: string;
    onSelectProvider?: (
      provider: SystemEnvironmentProvider,
      hostId: string | null,
    ) => void;
    machines?: {
      hosts: Host[];
      localDaemonHostId: string | null;
      primaryHostId: string | null;
    } | null;
  }) {
    return {
      value: "provider:personal-workspace",
      onChange: vi.fn(),
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
      providers: [personalWorkspaceProvider],
      selectedProviderHostId: overrides?.selectedProviderHostId ?? host.id,
      onSelectProvider: overrides?.onSelectProvider ?? vi.fn(),
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

  it("counts provider-made machines in the projectless machine chip", () => {
    render(
      <ProjectlessMachineSlot
        environment={makeEnvironment({
          machines: {
            hosts: [
              host,
              makeHost({
                id: "host_modal",
                name: "Modal sandbox 3f9a",
              }),
            ],
            localDaemonHostId: host.id,
            primaryHostId: host.id,
          },
        })}
      />,
    );

    expect(screen.getByRole("button", { name: "Machine" })).toBeTruthy();
  });

  it("names the selected machine in the chip", () => {
    render(
      <ProjectlessMachineSlot
        environment={makeEnvironment({
          selectedProviderHostId: secondHost.id,
        })}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Machine" }).textContent,
    ).toContain("Mac Studio");
  });

  it("routes a machine pick through the selected provider", () => {
    const onSelectProvider = vi.fn();
    render(
      <ProjectlessMachineSlot
        environment={makeEnvironment({
          selectedProviderHostId: secondHost.id,
          onSelectProvider,
        })}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Machine" });
    expect(trigger.textContent).toContain("Mac Studio");
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(screen.getByRole("menuitem", { name: /Local host/u }));

    expect(onSelectProvider).toHaveBeenCalledWith(
      personalWorkspaceProvider,
      host.id,
    );
  });
});

describe("ProjectlessEnvSlot", () => {
  const secondHost: Host = {
    ...host,
    id: "host_second",
    name: "Mac Studio",
  };

  const personalProvider: SystemEnvironmentProvider = {
    id: "personal-workspace",
    displayName: "Personal workspace",
    icon: "Folder",
    logoUrl: null,
    pluginId: "environment-personal-workspace",
    acceptsEmptyInputs: true,
    availability: null,
    requires: {
      projectCheckout: false,
      gitCheckout: false,
      gitRemote: false,
      projectless: true,
    },
    inputs: null,
  };

  const sandboxProvider: SystemEnvironmentProvider = {
    id: "modal-sandbox",
    displayName: "Modal sandbox",
    icon: "Cloud",
    logoUrl: null,
    pluginId: "environment-modal-sandbox",
    acceptsEmptyInputs: true,
    availability: null,
    requires: {
      projectCheckout: false,
      gitCheckout: false,
      gitRemote: false,
      projectless: false,
    },
    inputs: null,
  };

  function makeEnvironment(overrides: {
    value?: string;
    providers?: readonly SystemEnvironmentProvider[];
    onSelectProvider?: (
      provider: SystemEnvironmentProvider,
      hostId: string | null,
    ) => void;
  }) {
    return {
      value: overrides.value ?? "provider:personal-workspace",
      onChange: vi.fn(),
      sources: [],
      host,
      isLocal: true,
      machines: {
        hosts: [host, secondHost],
        localDaemonHostId: host.id,
        primaryHostId: host.id,
      },
      providers: overrides.providers ?? [personalProvider],
      selectedProviderHostId: host.id,
      onSelectProvider: overrides.onSelectProvider ?? vi.fn(),
    };
  }

  function makeWorktree(value: string | null = null) {
    return {
      options: [
        {
          environmentId: "env_personal",
          branchName: null,
          name: "Scratch space",
          path: null,
          environmentProviderId: "personal-workspace",
          threads: [{ id: "thr_1", title: "Earlier personal thread" }],
        },
      ],
      value,
      onChange: vi.fn(),
      disabled: false,
    };
  }

  it("keeps the machine slot when only one provider is available", () => {
    render(
      <ProjectlessEnvSlot
        environment={makeEnvironment({ providers: [personalProvider] })}
        worktree={makeWorktree()}
      />,
    );

    expect(screen.getByRole("button", { name: "Machine" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Environment" })).toBeNull();
  });

  it("omits project-only providers from the projectless picker", () => {
    render(
      <ProjectlessEnvSlot
        environment={makeEnvironment({
          value: "provider:personal-workspace",
          providers: [personalProvider, sandboxProvider],
        })}
        worktree={makeWorktree()}
      />,
    );

    expect(screen.getByRole("button", { name: "Machine" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Environment" })).toBeNull();
    expect(screen.queryByText("Modal sandbox")).toBeNull();
  });

  it("shows the reused environment instead of the machine slot when a thread reuses one", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ProjectlessEnvSlot
          environment={makeEnvironment({
            value: "reuse:env_personal",
            providers: [personalProvider],
          })}
          worktree={makeWorktree("env_personal")}
        />
      </QueryClientProvider>,
    );

    expect(screen.queryByRole("button", { name: "Machine" })).toBeNull();
    const triggers = screen.getAllByRole("button", { name: "Environment" });
    expect(triggers).toHaveLength(2);
    expect(triggers[0]?.textContent).toContain("Reuse");
    expect(triggers[1]?.textContent).toContain("Scratch space");
  });
});
