import { describe, expect, it } from "vitest";
import type { EnvironmentDisplayInfo } from "@bb/core-ui";
import type { SystemEnvironmentProvider } from "@bb/server-contract";
import {
  findEnvironmentDisplayProvider,
  getEnvironmentDisplayIconName,
  getEnvironmentWorkspaceInfoDisplay,
  getEnvironmentWorkspaceSummaryDisplay,
  shouldShowEnvironmentHostIdentity,
} from "./environment-workspace-display";

describe("shouldShowEnvironmentHostIdentity", () => {
  it("keeps the machine identity for a projectless thread with one machine", () => {
    expect(shouldShowEnvironmentHostIdentity(false, true)).toBe(true);
    expect(shouldShowEnvironmentHostIdentity(false, false)).toBe(false);
  });
});

const worktreeProvider: SystemEnvironmentProvider = {
  id: "git-worktree",
  displayName: "Worktree",
  icon: "FolderGit",
  logoUrl: null,
  pluginId: "environment-git-worktree",
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

const machineContainerProvider: SystemEnvironmentProvider = {
  id: "container",
  displayName: "Container",
  icon: "Box",
  logoUrl: null,
  pluginId: "containers",
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

function makeDisplay(
  overrides: Partial<EnvironmentDisplayInfo> = {},
): EnvironmentDisplayInfo {
  return {
    modeLabel: "Working locally",
    compactModeLabel: "Local",
    typeLabel: "Local",
    providerLabel: null,
    lifecycle: null,
    id: "env_test",
    ...overrides,
  };
}

const noProviderLookup = findEnvironmentDisplayProvider([], null);
const worktreeProviderLookup = findEnvironmentDisplayProvider(
  [worktreeProvider],
  "git-worktree",
);
const personalProviderLookup = findEnvironmentDisplayProvider(
  [personalProvider],
  "personal-workspace",
);
const containerProviderLookup = findEnvironmentDisplayProvider(
  [machineContainerProvider],
  "container",
);

interface SummaryDisplayOverrides {
  display?: EnvironmentDisplayInfo;
  providerLookup?: ReturnType<typeof findEnvironmentDisplayProvider>;
  environmentName?: string | null;
  hasMultipleMachines?: boolean;
  hostName?: string | null;
  isProjectless?: boolean;
}

function getSummaryDisplay({
  display = makeDisplay(),
  providerLookup = noProviderLookup,
  environmentName = null,
  hasMultipleMachines = false,
  hostName = "Michael-M4",
  isProjectless = false,
}: SummaryDisplayOverrides = {}) {
  return getEnvironmentWorkspaceSummaryDisplay({
    display,
    providerLookup,
    environmentName,
    hasMultipleMachines,
    hostName,
    isProjectless,
  });
}

describe("findEnvironmentDisplayProvider", () => {
  it("reports a provider id no running plugin registers as loaded and unknown", () => {
    expect(
      findEnvironmentDisplayProvider([worktreeProvider], "modal-sandbox"),
    ).toEqual({
      status: "loaded",
      provider: null,
      environmentProviderId: "modal-sandbox",
    });
  });

  it("reports loading while the provider list has not arrived", () => {
    expect(findEnvironmentDisplayProvider(undefined, "git-worktree")).toEqual({
      status: "loading",
    });
  });

  it("reports a row with no provider as loaded even before the list arrives", () => {
    expect(findEnvironmentDisplayProvider(undefined, null)).toEqual({
      status: "loaded",
      provider: null,
      environmentProviderId: null,
    });
  });
});

describe("getEnvironmentDisplayIconName", () => {
  it("uses the provider icon", () => {
    expect(getEnvironmentDisplayIconName(worktreeProviderLookup)).toBe(
      "FolderGit",
    );
  });

  it("falls back to the plugin placeholder icon for an unknown icon name", () => {
    expect(
      getEnvironmentDisplayIconName({
        status: "loaded",
        provider: { ...worktreeProvider, icon: "NotAnIconName" },
      }),
    ).toBe("Zap");
  });

  it("has no icon for a row with no provider or while the list loads", () => {
    expect(getEnvironmentDisplayIconName(noProviderLookup)).toBeNull();
    expect(getEnvironmentDisplayIconName({ status: "loading" })).toBeNull();
  });
});

describe("getEnvironmentWorkspaceSummaryDisplay", () => {
  it("keeps provisioning ahead of the provider icon and label", () => {
    expect(
      getSummaryDisplay({
        display: makeDisplay({
          modeLabel: "Provisioning",
          compactModeLabel: "Provisioning",
          lifecycle: "provisioning",
          providerLabel: "Worktree",
          typeLabel: "Worktree · Local",
        }),
        providerLookup: worktreeProviderLookup,
        hasMultipleMachines: true,
      }),
    ).toEqual({
      label: "Provisioning",
      compactLabel: "Provisioning",
      icon: "Loading",
      typeLabel: undefined,
    });
  });

  it("keeps destroyed ahead of a machine label", () => {
    expect(
      getSummaryDisplay({
        display: makeDisplay({
          modeLabel: "Destroyed",
          compactModeLabel: "Destroyed",
          lifecycle: "destroyed",
        }),
        providerLookup: worktreeProviderLookup,
        hasMultipleMachines: true,
      }),
    ).toMatchObject({ label: "Destroyed", compactLabel: "Destroyed" });
  });

  it.each([
    {
      name: "a local project checkout",
      display: makeDisplay(),
      providerLookup: noProviderLookup,
    },
    {
      name: "a remote project checkout",
      display: makeDisplay({
        modeLabel: "Working remotely",
        compactModeLabel: "Remote",
        typeLabel: "Remote",
      }),
      providerLookup: noProviderLookup,
    },
    {
      name: "a worktree",
      display: makeDisplay({
        modeLabel: "Worktree",
        compactModeLabel: "Worktree",
        typeLabel: "Worktree · Local",
        providerLabel: "Worktree",
      }),
      providerLookup: worktreeProviderLookup,
    },
    {
      name: "a personal workspace",
      display: makeDisplay({
        modeLabel: "Personal workspace",
        compactModeLabel: "Personal workspace",
        typeLabel: "Personal workspace · Local",
        providerLabel: "Personal workspace",
      }),
      providerLookup: personalProviderLookup,
    },
  ])("shows nothing for $name on a single machine", (testCase) => {
    expect(
      getSummaryDisplay({
        display: testCase.display,
        providerLookup: testCase.providerLookup,
      }),
    ).toBeNull();
  });

  it("shows the machine for a single-machine projectless thread", () => {
    expect(
      getSummaryDisplay({
        providerLookup: personalProviderLookup,
        isProjectless: true,
      }),
    ).toMatchObject({ label: "Michael-M4", compactLabel: "Michael-M4" });
  });

  it("omits an unnamed single-machine environment with an unregistered provider", () => {
    expect(
      getSummaryDisplay({
        providerLookup: findEnvironmentDisplayProvider([], "retired-cloud"),
      }),
    ).toBeNull();
  });

  it.each([
    { name: "project checkout", providerLookup: noProviderLookup },
    { name: "git-worktree", providerLookup: worktreeProviderLookup },
    { name: "personal-workspace", providerLookup: personalProviderLookup },
    {
      name: "third-party provider that runs on a machine",
      providerLookup: containerProviderLookup,
    },
  ])("uses the machine name for a multi-machine $name", (testCase) => {
    expect(
      getSummaryDisplay({
        providerLookup: testCase.providerLookup,
        hasMultipleMachines: true,
      }),
    ).toMatchObject({ label: "Michael-M4", compactLabel: "Michael-M4" });
  });

  it("shows nothing while the provider list is still loading", () => {
    expect(
      getSummaryDisplay({
        providerLookup: { status: "loading" },
        hasMultipleMachines: true,
      }),
    ).toBeNull();
  });

  it("keeps an explicit environment name when multiple machines exist", () => {
    expect(
      getSummaryDisplay({
        display: makeDisplay({
          modeLabel: "Design system polish",
          compactModeLabel: "Design system polish",
        }),
        providerLookup: worktreeProviderLookup,
        environmentName: "Design system polish",
        hasMultipleMachines: true,
      }),
    ).toMatchObject({
      label: "Design system polish",
      compactLabel: "Design system polish",
    });
  });
});

describe("getEnvironmentWorkspaceInfoDisplay", () => {
  it("shows the environment label and machine for a provider that runs on one", () => {
    expect(
      getEnvironmentWorkspaceInfoDisplay({
        display: makeDisplay({ providerLabel: "Worktree" }),
        providerLookup: worktreeProviderLookup,
        environmentName: null,
        hostName: "Michael-M4",
      }),
    ).toEqual({
      label: "Worktree",
      icon: "FolderGit",
      machineName: "Michael-M4",
    });
  });

  it("shows an unregistered provider as not installed in the info tab", () => {
    expect(
      getEnvironmentWorkspaceInfoDisplay({
        display: makeDisplay({ compactModeLabel: "retired-cloud" }),
        providerLookup: findEnvironmentDisplayProvider([], "retired-cloud"),
        environmentName: null,
        hostName: "Michael-M4",
      }),
    ).toMatchObject({
      label: "retired-cloud (not installed)",
      machineName: "Michael-M4",
    });
  });
});
