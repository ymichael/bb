// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Host, ProjectSource } from "@bb/domain";
import { makeHost } from "@bb/test-helpers/domain-fixtures";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import type { SystemEnvironmentProvider } from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EnvironmentPickerUI,
  PROVIDER_INPUTS_CONTROL_MISSING_REASON,
} from "./EnvironmentPicker";

const checkoutProvider: SystemEnvironmentProvider = {
  id: "project-checkout",
  displayName: "Project checkout",
  icon: "Laptop",
  logoUrl: null,
  pluginId: "environment-project-checkout",
  acceptsEmptyInputs: true,
  availability: null,
  requires: {
    projectCheckout: true,
    gitCheckout: false,
    gitRemote: false,
    projectless: false,
  },
  inputs: null,
};

const branchProvider: SystemEnvironmentProvider = {
  id: "branchy",
  displayName: "New branch workspace",
  icon: "GitBranch",
  logoUrl: null,
  pluginId: "branchy",
  acceptsEmptyInputs: true,
  availability: null,
  requires: {
    projectCheckout: true,
    gitCheckout: true,
    gitRemote: false,
    projectless: false,
  },
  inputs: null,
};

const sandboxProvider: SystemEnvironmentProvider = {
  id: "container",
  displayName: "Docker container",
  icon: "Container",
  logoUrl: null,
  pluginId: "docker-sandbox",
  acceptsEmptyInputs: false,
  availability: null,
  requires: {
    projectCheckout: false,
    gitCheckout: false,
    gitRemote: false,
    projectless: false,
  },
  inputs: {
    type: "object",
    properties: { image: { type: "string" } },
    required: ["image"],
  },
};

const optionalInputsProvider: SystemEnvironmentProvider = {
  id: "optional-sandbox",
  displayName: "Optional sandbox",
  icon: "Container",
  logoUrl: null,
  pluginId: "optional-sandbox",
  acceptsEmptyInputs: true,
  availability: null,
  requires: {
    projectCheckout: false,
    gitCheckout: false,
    gitRemote: false,
    projectless: false,
  },
  inputs: {
    type: "object",
    properties: { image: { type: "string" } },
  },
};

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
  it("omits a projectless-only provider from a project picker", () => {
    render(
      <EnvironmentPickerUI
        value="provider:project-checkout"
        sources={sources}
        host={host}
        isLocal
        providers={[
          checkoutProvider,
          {
            ...optionalInputsProvider,
            id: "personal-workspace",
            displayName: "Personal workspace",
            requires: {
              projectCheckout: false,
              gitCheckout: false,
              gitRemote: false,
              projectless: true,
            },
          },
        ]}
        selectedProviderHostId={host.id}
        onSelectProvider={vi.fn()}
        modal={false}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Environment" }), {
      button: 0,
    });
    expect(
      screen.getByRole("menuitem", { name: /Project checkout/u }),
    ).toBeTruthy();
    expect(screen.queryByText("Personal workspace")).toBeNull();
  });

  it("disables an unavailable provider with its availability message", () => {
    render(
      <EnvironmentPickerUI
        value="provider:project-checkout"
        sources={sources}
        host={host}
        isLocal
        providers={[
          {
            ...checkoutProvider,
            availability: {
              status: "unavailable",
              message: "Project source unavailable",
            },
          },
        ]}
        selectedProviderHostId={host.id}
        onSelectProvider={vi.fn()}
        modal={false}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Environment" }), {
      button: 0,
    });

    const providerItem = screen.getByRole("menuitem", {
      name: /Project checkout/u,
    });
    expect(providerItem.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Project source unavailable")).toBeTruthy();
  });

  it("keeps a setup-required provider selectable and shows its message", () => {
    const onSelectProvider = vi.fn();
    const setupRequiredProvider: SystemEnvironmentProvider = {
      ...sandboxProvider,
      acceptsEmptyInputs: true,
      inputs: null,
      availability: {
        status: "setup-required",
        message: "Add Modal credentials",
      },
    };
    render(
      <EnvironmentPickerUI
        value="provider:project-checkout"
        sources={sources}
        host={host}
        isLocal
        providers={[setupRequiredProvider]}
        onSelectProvider={onSelectProvider}
        modal={false}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Environment" }), {
      button: 0,
    });

    const providerItem = screen.getByRole("menuitem", {
      name: /Docker container/u,
    });
    expect(providerItem.getAttribute("aria-disabled")).toBeNull();
    expect(screen.getByText("Add Modal credentials")).toBeTruthy();
    fireEvent.click(providerItem);
    expect(onSelectProvider).toHaveBeenCalledWith(
      setupRequiredProvider,
      host.id,
    );
  });

  it("disables a provider that declares inputs until its plugin registers a control", () => {
    const onSelectProvider = vi.fn();
    const { rerender } = render(
      <EnvironmentPickerUI
        value="provider:project-checkout"
        sources={sources}
        host={host}
        isLocal
        providers={[sandboxProvider]}
        onSelectProvider={onSelectProvider}
        modal={false}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Environment" }), {
      button: 0,
    });
    const disabledItem = screen.getByRole("menuitem", {
      name: /Docker container/u,
    });
    expect(disabledItem.getAttribute("aria-disabled")).toBe("true");
    expect(
      screen.getByText(PROVIDER_INPUTS_CONTROL_MISSING_REASON),
    ).toBeTruthy();

    rerender(
      <EnvironmentPickerUI
        value="provider:project-checkout"
        sources={sources}
        host={host}
        isLocal
        providers={[sandboxProvider]}
        inputsControlProviderIds={new Set([sandboxProvider.id])}
        onSelectProvider={onSelectProvider}
        modal={false}
      />,
    );
    const enabledItem = screen.getByRole("menuitem", {
      name: /Docker container/u,
    });
    expect(enabledItem.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(enabledItem);
    expect(onSelectProvider).toHaveBeenCalledWith(sandboxProvider, host.id);
  });

  it("keeps a provider whose inputs schema requires nothing selectable without a control", () => {
    const onSelectProvider = vi.fn();
    render(
      <EnvironmentPickerUI
        value="provider:project-checkout"
        sources={sources}
        host={host}
        isLocal
        providers={[optionalInputsProvider]}
        onSelectProvider={onSelectProvider}
        modal={false}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Environment" }), {
      button: 0,
    });
    const item = screen.getByRole("menuitem", { name: /Optional sandbox/u });
    expect(item.getAttribute("aria-disabled")).toBeNull();
    expect(screen.queryByText(PROVIDER_INPUTS_CONTROL_MISSING_REASON)).toBe(
      null,
    );
    fireEvent.click(item);
    expect(onSelectProvider).toHaveBeenCalledWith(
      optionalInputsProvider,
      host.id,
    );
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
    selectedProviderHostId?: string;
    providers?: readonly SystemEnvironmentProvider[];
    onSelectProvider?: (
      provider: SystemEnvironmentProvider,
      hostId: string | null,
    ) => void;
  }) {
    render(
      <EnvironmentPickerUI
        value={overrides?.value ?? "provider:project-checkout"}
        sources={machineSources}
        host={thisMachine}
        isLocal
        machines={{
          hosts: [thisMachine, studio, devVm],
          localDaemonHostId: thisMachine.id,
          primaryHostId: thisMachine.id,
        }}
        providers={overrides?.providers ?? [checkoutProvider]}
        selectedProviderHostId={
          overrides?.selectedProviderHostId ?? thisMachine.id
        }
        onSelectProvider={overrides?.onSelectProvider ?? vi.fn()}
        modal={false}
      />,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Environment" }), {
      button: 0,
    });
  }

  it("groups options per machine and selects the checkout with that machine's host id", () => {
    const onSelectProvider = vi.fn();
    renderMachineMenu({ onSelectProvider });

    expect(screen.getByText("MacBook Pro")).toBeTruthy();
    expect(screen.getByText("this machine")).toBeTruthy();
    expect(screen.getByText("Mac Studio")).toBeTruthy();

    const checkoutItems = screen.getAllByRole("menuitem", {
      name: /Project checkout/u,
    });
    expect(checkoutItems).toHaveLength(3);
    fireEvent.click(checkoutItems[1]!);
    expect(onSelectProvider).toHaveBeenCalledWith(checkoutProvider, studio.id);
  });

  it("includes provider-made hosts in environment picker machine sections", () => {
    const providerHost = makeHost({
      id: "host_modal",
      name: "Modal sandbox 3f9a",
      machineProviderId: "modal-sandbox",
    });
    render(
      <EnvironmentPickerUI
        value="provider:project-checkout"
        sources={machineSources}
        host={thisMachine}
        isLocal
        machines={{
          hosts: [thisMachine, studio, providerHost],
          localDaemonHostId: thisMachine.id,
          primaryHostId: thisMachine.id,
        }}
        providers={[checkoutProvider]}
        selectedProviderHostId={thisMachine.id}
        onSelectProvider={vi.fn()}
        modal={false}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Environment" }), {
      button: 0,
    });

    expect(screen.getByText("Mac Studio")).toBeTruthy();
    expect(screen.getByText("Modal sandbox 3f9a")).toBeTruthy();
  });

  it("does not show project checkout paths in machine headers", () => {
    renderMachineMenu();

    expect(screen.queryByText("~/bb")).toBeNull();
    expect(screen.queryByText("~/code/bb")).toBeNull();
  });

  it("offers a host-scoped provider once per machine", () => {
    const onSelectProvider = vi.fn();
    renderMachineMenu({
      providers: [branchProvider],
      onSelectProvider,
    });

    const providerItems = screen.getAllByRole("menuitem", {
      name: /New branch workspace/u,
    });
    expect(providerItems).toHaveLength(3);
    fireEvent.click(providerItems[1]!);
    expect(onSelectProvider).toHaveBeenCalledWith(branchProvider, studio.id);
  });

  it("uses each machine's scoped availability for its provider row", () => {
    render(
      <EnvironmentPickerUI
        value="provider:project-checkout"
        sources={machineSources}
        host={thisMachine}
        isLocal
        machines={{
          hosts: [thisMachine, studio],
          localDaemonHostId: thisMachine.id,
          primaryHostId: thisMachine.id,
        }}
        providers={[checkoutProvider]}
        providersByHostId={
          new Map([
            [
              thisMachine.id,
              [
                {
                  ...checkoutProvider,
                  availability: { status: "available" },
                },
              ],
            ],
            [
              studio.id,
              [
                {
                  ...checkoutProvider,
                  availability: {
                    status: "unavailable",
                    message: "Checkout missing on Mac Studio",
                  },
                },
              ],
            ],
          ])
        }
        selectedProviderHostId={thisMachine.id}
        onSelectProvider={vi.fn()}
        modal={false}
      />,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Environment" }), {
      button: 0,
    });

    const checkoutItems = screen.getAllByRole("menuitem", {
      name: /Project checkout/u,
    });
    expect(checkoutItems[0]!.getAttribute("aria-disabled")).toBeNull();
    expect(checkoutItems[1]!.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Checkout missing on Mac Studio")).toBeTruthy();
  });

  it("disables an offline machine's options and shows when it was last seen", () => {
    renderMachineMenu();

    expect(screen.getByText(/last seen 2h ago/u)).toBeTruthy();
    const checkoutItems = screen.getAllByRole("menuitem", {
      name: /Project checkout/u,
    });
    expect(checkoutItems).toHaveLength(3);
    expect(checkoutItems[2]!.getAttribute("aria-disabled")).toBe("true");
  });

  it("shows protocol versions instead of plain offline metadata for stale daemons", () => {
    const staleVm: Host = {
      ...devVm,
      lastRejectedProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION - 1,
    };
    render(
      <EnvironmentPickerUI
        value="provider:project-checkout"
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
        value="provider:project-checkout"
        sources={machineSources}
        host={thisMachine}
        isLocal
        machines={{
          hosts: [thisMachine, offlineStudio],
          localDaemonHostId: thisMachine.id,
          primaryHostId: thisMachine.id,
        }}
        providers={[checkoutProvider]}
        selectedProviderHostId={thisMachine.id}
        onSelectProvider={vi.fn()}
        modal={false}
      />,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Environment" }), {
      button: 0,
    });

    const checkoutItems = screen.getAllByRole("menuitem", {
      name: /Project checkout/u,
    });
    expect(checkoutItems).toHaveLength(2);
    expect(checkoutItems[0]!.getAttribute("aria-disabled")).toBeNull();
    expect(checkoutItems[1]!.getAttribute("aria-disabled")).toBe("true");
  });

  it("offers guided setup for a connected machine without a source", () => {
    const onRequestMachineSetup = vi.fn();
    const onlineVm: Host = { ...devVm, status: "connected", lastSeenAt: null };
    render(
      <EnvironmentPickerUI
        value="provider:project-checkout"
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

  it("offers guided setup below host-scoped providers on a connected machine without a source", () => {
    const onRequestMachineSetup = vi.fn();
    const onSelectProvider = vi.fn();
    const onlineVm: Host = { ...devVm, status: "connected", lastSeenAt: null };
    const hostProvider = {
      ...checkoutProvider,
      id: "host-sandbox",
      displayName: "Host sandbox",
      requires: {
        ...checkoutProvider.requires,
        projectCheckout: false,
      },
    };
    render(
      <EnvironmentPickerUI
        value="provider:project-checkout"
        sources={machineSources}
        host={thisMachine}
        isLocal
        machines={{
          hosts: [thisMachine, onlineVm],
          localDaemonHostId: thisMachine.id,
          primaryHostId: thisMachine.id,
        }}
        providers={[hostProvider]}
        selectedProviderHostId={thisMachine.id}
        onSelectProvider={onSelectProvider}
        onRequestMachineSetup={onRequestMachineSetup}
        modal={false}
      />,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Environment" }), {
      button: 0,
    });

    expect(
      screen.getAllByRole("menuitem", { name: /Host sandbox/u }),
    ).toHaveLength(2);
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Set up on dev-vm…/u }),
    );
    expect(onRequestMachineSetup).toHaveBeenCalledWith(onlineVm);
  });

  it("keeps the disabled not-set-up row for an offline machine", () => {
    render(
      <EnvironmentPickerUI
        value="provider:project-checkout"
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
    renderMachineMenu();

    expect(screen.getByText("MacBook Pro · Project checkout")).toBeTruthy();
    expect(
      document.querySelector("[data-promptbox-compact-label]")?.textContent,
    ).toBe("Project checkout");
  });

  it("names another selected machine in the trigger label", () => {
    renderMachineMenu({ selectedProviderHostId: studio.id });

    expect(screen.getByText("Mac Studio · Project checkout")).toBeTruthy();
  });

  it("lists every eligible provider row under each machine", () => {
    const onSelectProvider = vi.fn();
    render(
      <EnvironmentPickerUI
        value="provider:project-checkout"
        sources={machineSources}
        host={thisMachine}
        isLocal
        machines={{
          hosts: [thisMachine, studio],
          localDaemonHostId: thisMachine.id,
          primaryHostId: thisMachine.id,
        }}
        providers={[branchProvider, sandboxProvider]}
        selectedProviderHostId={null}
        inputsControlProviderIds={new Set([sandboxProvider.id])}
        onSelectProvider={onSelectProvider}
        modal={false}
      />,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Environment" }), {
      button: 0,
    });

    const providerItems = screen.getAllByRole("menuitem", {
      name: /New branch workspace/u,
    });
    expect(providerItems).toHaveLength(2);
    fireEvent.click(providerItems[1]!);
    expect(onSelectProvider).toHaveBeenCalledWith(branchProvider, studio.id);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Environment" }), {
      button: 0,
    });
    const sandboxItems = screen.getAllByRole("menuitem", {
      name: /Docker container/u,
    });
    expect(sandboxItems).toHaveLength(2);
    fireEvent.click(sandboxItems[0]!);
    expect(onSelectProvider).toHaveBeenCalledWith(
      sandboxProvider,
      thisMachine.id,
    );
  });

  it("names the selected machine and provider display name in the trigger label", () => {
    render(
      <EnvironmentPickerUI
        value="provider:branchy"
        sources={machineSources}
        host={studio}
        isLocal={false}
        machines={{
          hosts: [thisMachine, studio],
          localDaemonHostId: thisMachine.id,
          primaryHostId: thisMachine.id,
        }}
        providers={[branchProvider]}
        selectedProviderHostId={studio.id}
        onSelectProvider={vi.fn()}
        modal={false}
      />,
    );

    expect(screen.getByText("Mac Studio · New branch workspace")).toBeTruthy();
  });

  it("reports an offline machine ahead of the provider it was selected on", () => {
    const offlineStudio: Host = { ...studio, status: "disconnected" };
    render(
      <EnvironmentPickerUI
        value="provider:branchy"
        sources={machineSources}
        host={offlineStudio}
        isLocal={false}
        machines={{
          hosts: [thisMachine, offlineStudio],
          localDaemonHostId: thisMachine.id,
          primaryHostId: thisMachine.id,
        }}
        providers={[branchProvider]}
        selectedProviderHostId={offlineStudio.id}
        onSelectProvider={vi.fn()}
        modal={false}
      />,
    );

    expect(screen.getByText("Mac Studio · Host is offline")).toBeTruthy();
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.queryByText(/New branch workspace/u)).toBeNull();
  });

  it("keeps the single-host menu when only one host exists", () => {
    render(
      <EnvironmentPickerUI
        value="provider:project-checkout"
        sources={machineSources}
        host={thisMachine}
        isLocal
        machines={{
          hosts: [thisMachine],
          localDaemonHostId: thisMachine.id,
          primaryHostId: thisMachine.id,
        }}
        providers={[checkoutProvider]}
        selectedProviderHostId={thisMachine.id}
        onSelectProvider={vi.fn()}
        modal={false}
      />,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Environment" }), {
      button: 0,
    });

    expect(
      screen.getByRole("menuitem", { name: /Project checkout/u }),
    ).toBeTruthy();
    expect(screen.queryByText("MacBook Pro")).toBeNull();
  });
});
