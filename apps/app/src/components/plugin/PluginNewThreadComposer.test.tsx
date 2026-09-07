// @vitest-environment jsdom

import { useEffect, type ReactNode } from "react";
import { Provider } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  defaultAppSettings,
  PERSONAL_PROJECT_ID,
  type ThreadListEntry,
} from "@bb/domain";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  createMemoryRouter,
  MemoryRouter,
  RouterProvider,
  useLocation,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  NewThreadRequest,
  PluginEnvironmentProviderInputsProps,
} from "@get-bb/plugin-sdk";
import type { SystemEnvironmentProvider } from "@bb/server-contract";
import {
  NewThreadComposer,
  type NewThreadComposerState,
} from "@/components/promptbox/NewThreadComposer";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import {
  encodeReuseValue,
  REUSE_VALUE_WITHOUT_ENVIRONMENT,
} from "@/components/pickers/environment-picker-value";
import { useRootComposeReuseEnvironment } from "@/lib/root-compose-selection";
import { getPromptDraftAccessor } from "@/hooks/usePromptDraftStorage";
import { buildThreadHandoffLocationState } from "@bb/client-core";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import { makeProjectWithThreadsResponse } from "@/test/fixtures/projects";
import { RootComposeView } from "@/views/RootComposeView";
import { PluginNewThreadComposer } from "./PluginNewThreadComposer";

const mocks = vi.hoisted(() => ({
  promptBoxProps: [] as Array<Record<string, any>>,
  copyAttachments: vi.fn(),
  uploadAttachment: vi.fn(),
  projectThreads: [] as ThreadListEntry[],
  sidebarNavigationSettled: true,
  sidebarNavigationReplayed: false,
  extraProjects: [] as Array<Record<string, unknown>>,
  promptHistoryQueryOptions: [] as Array<{ enabled?: boolean } | undefined>,
  environmentProviders: [] as unknown[],
}));

vi.mock("@/components/promptbox/NewThreadPromptBox", () => ({
  NewThreadPromptBox: (props: Record<string, any>) => {
    mocks.promptBoxProps.push(props);
    return (
      <div data-testid="new-thread-prompt-box">
        {props.modeConfig?.environmentProviderInputsSlot ?? null}
      </div>
    );
  },
}));

vi.mock("@/hooks/queries/environment-provider-queries", () => ({
  useSystemEnvironmentProviders: () => ({
    providers: mocks.environmentProviders,
  }),
  useSystemEnvironmentProvidersByHost: (
    _projectId: string,
    hostIds: readonly string[],
  ) => new Map(hostIds.map((hostId) => [hostId, mocks.environmentProviders])),
}));

vi.mock("@/hooks/queries/machine-provider-queries", () => ({
  useSystemMachineProviders: () => ({ providers: [] }),
}));

vi.mock("@/lib/sdk", () => ({
  sdk: { projects: { attachments: { copy: mocks.copyAttachments } } },
}));

const PROJECT = makeProjectWithThreadsResponse({
  id: "proj_1",
  name: "Project One",
  defaultExecutionOptions: {
    providerId: "codex",
    model: "gpt-5.6",
    serviceTier: "default",
    reasoningLevel: "medium",
    permissionMode: "auto",
  },
  sources: [
    {
      id: "src_1",
      projectId: "proj_1",
      type: "local_path",
      hostId: "host_1",
      path: "/repo",
      isDefault: true,
      createdAt: 0,
      updatedAt: 0,
    },
  ],
});

const OTHER_PROJECT = makeProjectWithThreadsResponse({
  ...PROJECT,
  id: "proj_2",
  name: "Project Two",
  sources: [{ ...PROJECT.sources[0], id: "src_2", projectId: "proj_2" }],
});

vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({
  useSidebarNavigation: () =>
    mocks.sidebarNavigationSettled
      ? {
          data: {
            projects: [
              { ...PROJECT, threads: mocks.projectThreads },
              OTHER_PROJECT,
              ...mocks.extraProjects,
            ],
            personalProject: makeProjectWithThreadsResponse({
              id: "personal",
              kind: "personal",
              name: "Personal",
              sources: [],
              threads: [],
            }),
          },
          isError: false,
          isLoading: false,
          isSuccess: true,
          isPlaceholderData: mocks.sidebarNavigationReplayed,
        }
      : {
          data: undefined,
          isError: false,
          isLoading: true,
          isSuccess: false,
          isPlaceholderData: false,
        },
}));

vi.mock("@/hooks/queries/host-queries", () => ({
  useHosts: () => ({
    data: [{ id: "host_1", name: "Machine" }],
  }),
  selectHosts: <T,>(hosts: T[] | undefined) => hosts ?? [],
  selectPrimaryHost: (
    hosts: Array<{ id: string }> | undefined,
    primaryHostId: string | null,
  ) => hosts?.find((host) => host.id === primaryHostId) ?? hosts?.[0] ?? null,
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemProviders: () => ({ data: undefined }),
  useSystemProviderStates: () => ({ data: undefined, isPending: false }),
  useKnownProviderModelCatalogScope: () => undefined,
  useHostProviderCliStatus: () => ({ data: undefined }),
  useSystemConfig: () => ({
    data: { primaryHostId: "host_1", generalSettings: defaultAppSettings },
  }),
  useSystemExecutionOptions: () => ({
    data: {
      providers: [
        {
          id: "codex",
          displayName: "Codex",
          logoUrl: null,
          capabilities: {
            supportsServiceTier: false,
            permissionModes: ["auto", "accept-edits", "full"],
          },
          composerActions: [],
        },
        {
          id: "claude-code",
          displayName: "Claude Code",
          logoUrl: null,
          capabilities: {
            supportsServiceTier: false,
            permissionModes: ["auto", "accept-edits", "full"],
          },
          composerActions: [],
        },
      ],
      models: [
        {
          model: "gpt-5.6",
          displayName: "GPT-5.6",
          isDefault: true,
          supportedReasoningEfforts: [
            { reasoningEffort: "low" },
            { reasoningEffort: "medium" },
            { reasoningEffort: "high" },
          ],
        },
        {
          model: "gpt-5.6-sol",
          displayName: "GPT-5.6 Sol",
          isDefault: false,
          supportedReasoningEfforts: [
            { reasoningEffort: "medium" },
            { reasoningEffort: "high" },
          ],
        },
      ],
      selectedOnlyModels: [],
      modelLoadError: null,
    },
    isLoading: false,
    isError: false,
    isPlaceholderData: false,
  }),
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  useThreadStorageFiles: () => ({
    data: undefined,
    error: null,
    isLoading: false,
    refetch: vi.fn(),
  }),
  useThreadStorageFilePreview: () => ({
    data: undefined,
    error: null,
    isLoading: false,
  }),
}));

vi.mock("@/hooks/queries/project-queries", () => ({
  stripProjectThreads: (project: unknown) => project,
  useProjectPromptHistory: (
    _projectId: unknown,
    options?: { enabled?: boolean },
  ) => {
    mocks.promptHistoryQueryOptions.push(options);
    return { data: [] };
  },
  useProjectSourceBranches: () => ({
    data: {
      branches: ["main", "release"],
      branchesTruncated: false,
      checkout: { kind: "branch", branchName: "main" },
      defaultBranch: "main",
      defaultBranchRelation: null,
      hasUncommittedChanges: false,
      operation: { kind: "none" },
      originDefaultBranch: null,
      remoteBranches: [],
      remoteBranchesTruncated: false,
      selectedBranch: null,
      defaultWorktreeBaseBranch: null,
    },
    isLoading: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/queries/project-default-execution-options-query", () => ({
  useProjectDefaultExecutionOptions: () => ({ data: undefined }),
}));

vi.mock("@/hooks/mutations/project-mutations", () => ({
  useUploadPromptAttachment: () => ({
    mutateAsync: mocks.uploadAttachment,
    isPending: false,
  }),
}));

vi.mock("@/hooks/usePromptMentions", () => ({
  usePromptMentions: () => ({
    triggers: [],
    suggestions: [],
    isLoading: false,
    isError: false,
    setQuery: vi.fn(),
  }),
}));

vi.mock("@/hooks/useCommandSuggestions", () => ({
  useCommandSuggestions: () => ({
    trigger: null,
    suggestions: [],
    isLoading: false,
    isError: false,
    hasMore: false,
    isLoadingMore: false,
    loadMore: vi.fn(),
  }),
}));

vi.mock("@/hooks/useQuickCreateProject", () => ({
  useQuickCreateProjectController: () => ({
    hostId: null,
    hostName: null,
    hosts: [],
    isAvailable: false,
    isCreating: false,
    openCreateDialog: vi.fn(),
    platform: null,
    projectPathDialog: {
      isOpen: false,
      onOpenChange: vi.fn(),
      target: null,
    },
    submitProjectPath: vi.fn(),
  }),
}));

vi.mock("@/components/dialogs/ProjectMachineSetupDialog", () => ({
  ProjectMachineSetupDialog: () => null,
}));

vi.mock("@/views/RootComposeSecondaryContent", () => ({
  ROOT_COMPOSE_PINNED_PANEL_TOGGLE_POSITION_CLASS: "",
  RootComposeSecondaryContent: ({ children }: { children: ReactNode }) =>
    children,
}));

function latestPromptBoxProps(): Record<string, any> {
  const props = mocks.promptBoxProps.at(-1);
  expect(props).toBeDefined();
  return props as Record<string, any>;
}

function RootReuseProbe() {
  const [reuseEnvironment, setReuseEnvironment] =
    useRootComposeReuseEnvironment();
  return (
    <button
      type="button"
      data-testid="root-reuse-probe"
      data-value={reuseEnvironment}
      onClick={() => setReuseEnvironment("reuse:env-root")}
    />
  );
}

function ForkSeedSurface({ composer }: { composer: NewThreadComposerState }) {
  const { seedEnvironmentSelectionValue } = composer;
  useEffect(() => {
    seedEnvironmentSelectionValue(encodeReuseValue("env-source"));
  }, [seedEnvironmentSelectionValue]);
  return composer.renderPromptBox({});
}

function LocationProbe() {
  return <output data-testid="location-path">{useLocation().pathname}</output>;
}

function composerElement(
  seed: NewThreadRequest,
  onSubmit: (request: NewThreadRequest) => void,
  draftKey: string,
) {
  return (
    <MemoryRouter>
      <LocationProbe />
      <PluginNewThreadComposer
        draftKey={draftKey}
        defaultProjectId={seed.projectId}
        defaultProviderId={seed.providerId}
        defaultModel={seed.model}
        defaultReasoningLevel={seed.reasoningLevel}
        defaultServiceTier={seed.serviceTier}
        defaultPermissionMode={seed.permissionMode}
        defaultEnvironment={seed.environment}
        initialPrompt="review every PR for slop"
        onSubmit={onSubmit}
      />
    </MemoryRouter>
  );
}

function renderComposer(
  seed: NewThreadRequest,
  onSubmit: (request: NewThreadRequest) => void,
  draftKey: string,
) {
  return render(composerElement(seed, onSubmit, draftKey));
}

const BRANCH_INPUTS_SCHEMA = {
  type: "object",
  properties: { branch: { type: "object" } },
  required: ["branch"],
};

const CHECKOUT_PROVIDER: SystemEnvironmentProvider = {
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
  inputs: {
    type: "object",
    properties: { branch: { type: "object" }, path: { type: "string" } },
  },
};

const PERSONAL_WORKSPACE_PROVIDER: SystemEnvironmentProvider = {
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

const MANAGED_WORKTREE_SUGAR_PROVIDER: SystemEnvironmentProvider = {
  id: "git-worktree",
  displayName: "Worktree",
  icon: "GitBranch",
  logoUrl: null,
  pluginId: "environment-git-worktree",
  acceptsEmptyInputs: false,
  availability: null,
  requires: {
    projectCheckout: true,
    gitCheckout: true,
    gitRemote: false,
    projectless: false,
  },
  inputs: BRANCH_INPUTS_SCHEMA,
};

const EMPTY_SLOT_REGISTRATIONS = {
  homepageSections: [],
  settingsSections: [],
  navPanels: [],
  threadPanelActions: [],
  sidebarFooterActions: [],
  fileOpeners: [],
  messageDirectives: [],
};

const DEFAULT_BRANCH_INPUTS = { branch: { kind: "default" } };

function WorktreeInputsControl({
  value,
  onChange,
}: PluginEnvironmentProviderInputsProps) {
  useEffect(() => {
    if (value === null) {
      onChange({ status: "ready", value: DEFAULT_BRANCH_INPUTS });
    }
  }, [onChange, value]);
  return (
    <button
      type="button"
      data-testid="worktree-default-branch"
      onClick={() =>
        onChange({ status: "ready", value: DEFAULT_BRANCH_INPUTS })
      }
    >
      default branch
    </button>
  );
}

function registerWorktreeInputsControl(): void {
  setPluginSlotRegistrations("environment-git-worktree", {
    ...EMPTY_SLOT_REGISTRATIONS,
    environmentProviderInputs: [
      {
        environmentProviderId: "git-worktree",
        component: WorktreeInputsControl,
      },
    ],
  });
}

function CheckoutInputsControl({
  value,
  onChange,
}: PluginEnvironmentProviderInputsProps) {
  useEffect(() => {
    if (value === null) onChange({ status: "ready", value: {} });
  }, [onChange, value]);
  return null;
}

function registerCheckoutInputsControl(): void {
  setPluginSlotRegistrations("environment-project-checkout", {
    ...EMPTY_SLOT_REGISTRATIONS,
    environmentProviderInputs: [
      {
        environmentProviderId: "project-checkout",
        component: CheckoutInputsControl,
      },
    ],
  });
}

const STORED_REQUEST: NewThreadRequest = {
  projectId: "proj_1",
  providerId: "claude-code",
  model: "gpt-5.6-sol",
  reasoningLevel: "high",
  permissionMode: "full",
  executionInputSources: {
    providerId: "explicit",
    model: "explicit",
    reasoningLevel: "explicit",
    permissionMode: "explicit",
  },
  environment: {
    type: "provider",
    environmentProviderId: "git-worktree",
    machine: { type: "existing", hostId: "host_1" },
    inputs: { branch: { kind: "named", name: "release" } },
  },
  input: [{ type: "text", text: "review every PR for slop", mentions: [] }],
};

async function submit(): Promise<void> {
  await act(async () => {
    latestPromptBoxProps().onSubmit();
  });
}

describe("PluginNewThreadComposer seeding", () => {
  beforeEach(() => {
    mocks.promptBoxProps.length = 0;
    mocks.promptHistoryQueryOptions.length = 0;
    mocks.copyAttachments.mockReset();
    mocks.uploadAttachment.mockReset();
    mocks.projectThreads = [];
    mocks.sidebarNavigationSettled = true;
    mocks.sidebarNavigationReplayed = false;
    mocks.extraProjects = [];
    mocks.environmentProviders = [
      CHECKOUT_PROVIDER,
      MANAGED_WORKTREE_SUGAR_PROVIDER,
      PERSONAL_WORKSPACE_PROVIDER,
    ];
    resetPluginSlotStoreForTest();
    registerWorktreeInputsControl();
    registerCheckoutInputsControl();
    window.localStorage.clear();
    getPromptDraftAccessor({ kind: "new-thread" }).setDraft({
      text: "",
      mentions: [],
      attachments: [],
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("round-trips a stored request submitted untouched", async () => {
    const submitted: NewThreadRequest[] = [];
    renderComposer(
      STORED_REQUEST,
      (request) => {
        submitted.push(request);
      },
      "round-trip",
    );

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await submit();

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toEqual(STORED_REQUEST);
    await waitFor(() => {
      expect(latestPromptBoxProps().value).toBe("");
    });
  });

  it("marks a provider picked in an unseeded plugin composer as explicit", async () => {
    const submitted: NewThreadRequest[] = [];
    render(
      <MemoryRouter>
        <PluginNewThreadComposer
          draftKey="picked-provider"
          defaultProjectId="proj_1"
          initialPrompt="hello"
          onSubmit={(request) => {
            submitted.push(request);
          }}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await act(async () => {
      latestPromptBoxProps().execution.provider.onChange("claude-code");
    });
    await waitFor(() => {
      expect(latestPromptBoxProps().execution.provider.selectedId).toBe(
        "claude-code",
      );
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await submit();

    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.providerId).toBe("claude-code");
    expect(submitted[0]?.executionInputSources.providerId).toBe("explicit");
  });

  it("binds plugin draft actions to the hosted composer instance", async () => {
    renderComposer(STORED_REQUEST, () => undefined, "host-binding");

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    const host = latestPromptBoxProps().pluginComposerHost;
    expect(host.scope).toEqual({ kind: "new-thread", projectId: "proj_1" });
    expect(host.getCurrent().text).toBe("review every PR for slop");

    act(() => {
      host.setDraft({
        ...host.getCurrent(),
        text: "updated through the Composer API",
      });
    });

    await waitFor(() => {
      expect(latestPromptBoxProps().value).toBe(
        "updated through the Composer API",
      );
    });
  });

  it("does not demote a project the replayed bootstrap does not know yet", async () => {
    mocks.sidebarNavigationReplayed = true;
    const submitted: NewThreadRequest[] = [];
    const onSubmit = (request: NewThreadRequest) => {
      submitted.push(request);
    };
    const seed = { ...STORED_REQUEST, projectId: "proj_new" };
    const { rerender } = render(
      composerElement(seed, onSubmit, "replay-unknown-project"),
    );

    await waitFor(() => {
      expect(latestPromptBoxProps().project.value).toBe("proj_new");
    });
    expect(latestPromptBoxProps().project.isLoading).toBe(true);
    expect(latestPromptBoxProps().disabled).toBe(true);

    mocks.sidebarNavigationReplayed = false;
    mocks.extraProjects = [
      {
        ...PROJECT,
        id: "proj_new",
        name: "Project New",
        sources: [
          { ...PROJECT.sources[0], id: "src_new", projectId: "proj_new" },
        ],
      },
    ];
    rerender(composerElement(seed, onSubmit, "replay-unknown-project"));

    await waitFor(() => {
      expect(latestPromptBoxProps().project.isLoading).toBe(false);
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await submit();

    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.projectId).toBe("proj_new");
  });

  it("treats a replayed bootstrap that knows the project as settled", async () => {
    mocks.sidebarNavigationReplayed = true;
    renderComposer(STORED_REQUEST, () => {}, "replay-known-project");

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    expect(latestPromptBoxProps().project.isLoading).toBe(false);
    expect(latestPromptBoxProps().project.value).toBe("proj_1");
  });

  it("allows submitting a projectless thread", async () => {
    const submitted: NewThreadRequest[] = [];
    renderComposer(
      STORED_REQUEST,
      (request) => {
        submitted.push(request);
      },
      "projectless",
    );

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
      expect(latestPromptBoxProps().project.allowNoProject).toBe(true);
    });
    await act(async () => {
      await latestPromptBoxProps().project.onChange(null);
    });
    await waitFor(() => {
      expect(latestPromptBoxProps().project.value).toBeNull();
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await submit();

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      projectId: PERSONAL_PROJECT_ID,
      environment: {
        type: "provider",
        environmentProviderId: "personal-workspace",
        inputs: null,
      },
    });
  });

  it("re-seeds every selection when the seed props change, even after a user pick", async () => {
    const submitted: NewThreadRequest[] = [];
    const view = renderComposer(
      STORED_REQUEST,
      (request) => {
        submitted.push(request);
      },
      "re-seed",
    );
    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });

    await act(async () => {
      latestPromptBoxProps().execution.model.onChange("gpt-5.6");
    });
    const otherRecord: NewThreadRequest = {
      ...STORED_REQUEST,
      model: "gpt-5.6-sol",
      reasoningLevel: "medium",
      permissionMode: "accept-edits",
      environment: {
        type: "host",
        hostId: "host_1",
        workspace: {
          type: "unmanaged",
          path: null,
          branch: { kind: "existing", name: "release" },
        },
      },
    };
    view.rerender(
      composerElement(
        otherRecord,
        (request) => {
          submitted.push(request);
        },
        "re-seed",
      ),
    );

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await submit();

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toEqual({
      ...otherRecord,
      environment: {
        type: "provider",
        environmentProviderId: "project-checkout",
        machine: { type: "existing", hostId: "host_1" },
        inputs: { branch: { kind: "existing", name: "release" } },
      },
    });
  });

  it("re-seeds the provider inputs when the next record differs only by project", async () => {
    const submitted: NewThreadRequest[] = [];
    const onSubmit = (request: NewThreadRequest) => {
      submitted.push(request);
    };
    const view = renderComposer(STORED_REQUEST, onSubmit, "project-switch");
    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });

    fireEvent.click(screen.getByTestId("worktree-default-branch"));

    const otherProjectRecord: NewThreadRequest = {
      ...STORED_REQUEST,
      projectId: "proj_2",
    };
    view.rerender(
      composerElement(otherProjectRecord, onSubmit, "project-switch"),
    );
    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await submit();

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toEqual(otherProjectRecord);
  });

  it("does not resurrect the seeded inputs after the user leaves and returns to the environment", async () => {
    const submitted: NewThreadRequest[] = [];
    renderComposer(
      STORED_REQUEST,
      (request) => {
        submitted.push(request);
      },
      "env-return",
    );
    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });

    await act(async () => {
      latestPromptBoxProps().modeConfig.environment.onChange(
        "host:host_1:local",
      );
    });
    await act(async () => {
      latestPromptBoxProps().modeConfig.environment.onSelectProvider(
        MANAGED_WORKTREE_SUGAR_PROVIDER,
        "host_1",
      );
    });
    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await submit();

    expect(submitted).toHaveLength(1);
    expect(submitted[0].environment).toEqual({
      type: "provider",
      environmentProviderId: "git-worktree",
      machine: { type: "existing", hostId: "host_1" },
      inputs: DEFAULT_BRANCH_INPUTS,
    });
  });

  it("keeps project defaults when no seed props are passed", async () => {
    const submitted: NewThreadRequest[] = [];
    render(
      <MemoryRouter>
        <PluginNewThreadComposer
          draftKey="unseeded"
          defaultProjectId="proj_1"
          initialPrompt="hello"
          onSubmit={(request) => {
            submitted.push(request);
          }}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await submit();

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      projectId: "proj_1",
      providerId: "codex",
      model: "gpt-5.6",
      reasoningLevel: "medium",
      permissionMode: "auto",
      environment: {
        type: "provider",
        environmentProviderId: "project-checkout",
        inputs: {},
      },
    });
  });

  it("does not clear the root reuse selection after a plugin submission", async () => {
    render(
      <Provider>
        <MemoryRouter>
          <RootReuseProbe />
          <PluginNewThreadComposer
            draftKey="root-reuse-isolation"
            defaultProjectId={STORED_REQUEST.projectId}
            defaultProviderId={STORED_REQUEST.providerId}
            defaultModel={STORED_REQUEST.model}
            defaultReasoningLevel={STORED_REQUEST.reasoningLevel}
            defaultPermissionMode={STORED_REQUEST.permissionMode}
            defaultEnvironment={STORED_REQUEST.environment}
            initialPrompt="plugin prompt"
            onSubmit={() => undefined}
          />
        </MemoryRouter>
      </Provider>,
    );
    fireEvent.click(screen.getByTestId("root-reuse-probe"));
    expect(screen.getByTestId("root-reuse-probe").dataset.value).toBe(
      "reuse:env-root",
    );
    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });

    await submit();

    expect(screen.getByTestId("root-reuse-probe").dataset.value).toBe(
      "reuse:env-root",
    );
  });

  it("derives reuse options from the sidebar bootstrap so a fork keeps its seeded worktree", async () => {
    mocks.projectThreads = [
      makeThreadListEntry({
        id: "thr_source",
        projectId: "proj_1",
        environmentId: "env-source",
        environmentHostId: "host_1",
        environmentName: "source",
        environmentBranchName: "feature/source",
        queuedWork: "none",
        environmentProviderId: "git-worktree",
      }),
    ];
    const submitted: NewThreadRequest[] = [];
    render(
      <Provider>
        <MemoryRouter>
          <NewThreadComposer
            projectId="proj_1"
            onProjectChange={() => undefined}
            draftStorage={{ kind: "new-thread" }}
            selectionScope="new-thread"
            seed={{
              initialPrompt: "fork prompt",
              environment: {
                type: "reuse",
                environmentId: "env-source",
              },
            }}
            resetKey="thr_source"
            onSubmit={(request) => {
              submitted.push(request);
            }}
          >
            {(composer) => <ForkSeedSurface composer={composer} />}
          </NewThreadComposer>
        </MemoryRouter>
      </Provider>,
    );

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await submit();

    expect(submitted).toHaveLength(1);
    expect(submitted[0].environment).toEqual({
      type: "reuse",
      environmentId: "env-source",
    });
  });

  it("renders the root composer with a loading project picker before the sidebar bootstrap settles", () => {
    mocks.sidebarNavigationSettled = false;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    window.localStorage.setItem("bb.root-compose.project-id", "proj_1");
    const router = createMemoryRouter(
      [{ path: "/", element: <RootComposeView /> }],
      { initialEntries: ["/"] },
    );
    render(
      <Provider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </Provider>,
    );

    expect(screen.getByTestId("new-thread-prompt-box")).toBeTruthy();
    expect(latestPromptBoxProps().project.isLoading).toBe(true);
    expect(mocks.promptHistoryQueryOptions.length).toBeGreaterThan(0);
    expect(
      mocks.promptHistoryQueryOptions.every(
        (options) => options?.enabled === false,
      ),
    ).toBe(true);
  });

  it("keeps a seeded fork's reuse selection pending until the sidebar bootstrap settles", async () => {
    mocks.sidebarNavigationSettled = false;
    const submitted: NewThreadRequest[] = [];
    const seed = {
      initialPrompt: "fork prompt",
      environment: { type: "reuse" as const, environmentId: "env-source" },
    };
    const onSubmit = (request: NewThreadRequest) => {
      submitted.push(request);
    };
    const element = () => (
      <Provider>
        <MemoryRouter>
          <NewThreadComposer
            projectId="proj_1"
            onProjectChange={() => undefined}
            draftStorage={{ kind: "new-thread" }}
            selectionScope="new-thread"
            seed={seed}
            resetKey="thr_source"
            onSubmit={onSubmit}
          >
            {(composer) => <ForkSeedSurface composer={composer} />}
          </NewThreadComposer>
        </MemoryRouter>
      </Provider>
    );
    const { rerender } = render(element());

    await waitFor(() => {
      expect(latestPromptBoxProps().modeConfig.environment.value).toBe(
        REUSE_VALUE_WITHOUT_ENVIRONMENT,
      );
    });
    expect(latestPromptBoxProps().modeConfig.worktree.options).toEqual([]);

    mocks.sidebarNavigationSettled = true;
    mocks.projectThreads = [
      makeThreadListEntry({
        id: "thr_source",
        projectId: "proj_1",
        environmentId: "env-source",
        environmentHostId: "host_1",
        environmentName: "source",
        environmentBranchName: "feature/source",
        queuedWork: "none",
        environmentProviderId: "git-worktree",
      }),
    ];
    rerender(element());

    await waitFor(() => {
      expect(latestPromptBoxProps().modeConfig.environment.value).toBe(
        encodeReuseValue("env-source"),
      );
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await submit();

    expect(submitted).toHaveLength(1);
    expect(submitted[0].environment).toEqual({
      type: "reuse",
      environmentId: "env-source",
    });
  });

  it("enables the project picker and prompt-history query once the sidebar bootstrap settles", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    window.localStorage.setItem("bb.root-compose.project-id", "proj_1");
    const router = createMemoryRouter(
      [{ path: "/", element: <RootComposeView /> }],
      { initialEntries: ["/"] },
    );
    render(
      <Provider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </Provider>,
    );

    expect(latestPromptBoxProps().project.isLoading).toBe(false);
    expect(mocks.promptHistoryQueryOptions.at(-1)?.enabled).toBe(true);
  });

  it("keeps an unrelated draft attachment out of a RootComposeView handoff", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    window.localStorage.setItem("bb.root-compose.project-id", "proj_1");
    getPromptDraftAccessor({ kind: "new-thread" }).setDraft({
      text: "unrelated draft",
      mentions: [],
      attachments: [
        {
          type: "localFile",
          name: "unrelated.txt",
          path: ".bb/attachments/unrelated.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
        },
      ],
    });
    const router = createMemoryRouter(
      [{ path: "/", element: <RootComposeView /> }],
      {
        initialEntries: [
          {
            pathname: "/",
            state: buildThreadHandoffLocationState({
              environmentId: "env-handoff",
              projectId: "proj_1",
              sourceThreadId: "thr_source",
              sourceThreadTitle: "Source thread",
            }),
          },
        ],
      },
    );
    render(
      <Provider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </Provider>,
    );

    expect(mocks.promptBoxProps[0]?.modeConfig.environment.value).toBe(
      "provider:personal-workspace",
    );
    expect(mocks.promptBoxProps[0]?.value).toBe("unrelated draft");
    expect(mocks.promptBoxProps[0]?.attachments.items).toHaveLength(1);
    await waitFor(() => {
      expect(latestPromptBoxProps().value).toBe(
        "Continue from @thread:thr_source",
      );
    });
    await waitFor(() => {
      expect(router.state.location.state).toBeNull();
    });
    expect(
      mocks.promptBoxProps.some(
        (props) =>
          props.value === "Continue from @thread:thr_source" &&
          props.attachments.items.length > 0,
      ),
    ).toBe(false);
    expect(latestPromptBoxProps().attachments.items).toEqual([]);
  });

  it("applies a replacing initial prompt from location state exactly once", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    window.localStorage.setItem("bb.root-compose.project-id", "proj_1");
    const rootDraft = getPromptDraftAccessor({ kind: "new-thread" });
    rootDraft.setDraft({
      text: "leftover draft",
      mentions: [],
      attachments: [],
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const router = createMemoryRouter(
      [{ path: "/", element: <RootComposeView /> }],
      {
        initialEntries: [
          {
            pathname: "/",
            state: {
              focusPrompt: true,
              initialPrompt: "Create a kanban plugin",
              replaceInitialPrompt: true,
            },
          },
        ],
      },
    );
    render(
      <Provider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </Provider>,
    );

    await waitFor(() => {
      expect(latestPromptBoxProps().value).toBe("Create a kanban plugin");
    });
    await waitFor(() => {
      expect(router.state.location.state).toBeNull();
    });
    expect(rootDraft.getCurrent().text).toBe("Create a kanban plugin");
    const updateDepthErrors = consoleError.mock.calls.filter((call) =>
      call.some(
        (argument) =>
          typeof argument === "string" &&
          argument.includes("Maximum update depth exceeded"),
      ),
    );
    consoleError.mockRestore();
    expect(updateDepthErrors).toEqual([]);
  });

  it("ignores a repeated submit while the first submission is pending", async () => {
    let finishSubmit: (() => void) | null = null;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSubmit = resolve;
        }),
    );
    renderComposer(STORED_REQUEST, onSubmit, "repeated-submit");
    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });

    act(() => {
      latestPromptBoxProps().onSubmit();
      latestPromptBoxProps().onSubmit();
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(latestPromptBoxProps().value).toBe("");

    await act(async () => {
      finishSubmit?.();
    });
  });

  it("restores the optimistically cleared draft when submission fails", async () => {
    let failSubmit: (() => void) | null = null;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          failSubmit = () => reject(new Error("create failed"));
        }),
    );
    renderComposer(STORED_REQUEST, onSubmit, "failed-submit");
    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });

    act(() => latestPromptBoxProps().onSubmit());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(latestPromptBoxProps().value).toBe("");
    await act(async () => {
      failSubmit?.();
    });
    await waitFor(() => {
      expect(latestPromptBoxProps().isSubmitting).toBe(false);
    });
    expect(latestPromptBoxProps().value).toBe("review every PR for slop");
  });

  it("does not replace a new draft when submission fails", async () => {
    let failSubmit: (() => void) | null = null;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          failSubmit = () => reject(new Error("create failed"));
        }),
    );
    renderComposer(STORED_REQUEST, onSubmit, "failed-submit-new-draft");
    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });

    act(() => latestPromptBoxProps().onSubmit());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(latestPromptBoxProps().value).toBe("");
    act(() => latestPromptBoxProps().onChange("next thread", []));
    await act(async () => {
      failSubmit?.();
    });

    await waitFor(() => {
      expect(latestPromptBoxProps().isSubmitting).toBe(false);
    });
    expect(latestPromptBoxProps().value).toBe("next thread");
  });

  it("keeps the old project when attachment copying fails", async () => {
    mocks.uploadAttachment.mockResolvedValue({
      type: "localFile",
      name: "notes.txt",
      path: ".bb/attachments/notes.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
    });
    mocks.copyAttachments.mockRejectedValue(new Error("copy failed"));
    renderComposer(STORED_REQUEST, vi.fn(), "copy-failure");
    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });

    await act(async () => {
      await latestPromptBoxProps().attachments.onAttachFiles([
        new File(["notes"], "notes.txt", { type: "text/plain" }),
      ]);
    });
    await waitFor(() => {
      expect(latestPromptBoxProps().attachments.items).toHaveLength(1);
    });
    await act(async () => {
      await latestPromptBoxProps().project.onChange("proj_2");
    });

    expect(mocks.copyAttachments).toHaveBeenCalledWith({
      projectId: "proj_2",
      sourceProjectId: "proj_1",
      paths: [".bb/attachments/notes.txt"],
    });
    expect(latestPromptBoxProps().project.value).toBe("proj_1");
    expect(latestPromptBoxProps().attachments.items).toHaveLength(1);
  });
});

const SANDBOX_PROVIDER: SystemEnvironmentProvider = {
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

const OPTIONAL_INPUTS_PROVIDER: SystemEnvironmentProvider = {
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

const BRANCH_PROVIDER: SystemEnvironmentProvider = {
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

const HOST_PROVIDER: SystemEnvironmentProvider = {
  id: "hosted",
  displayName: "Machine sandbox",
  icon: "Server",
  logoUrl: null,
  pluginId: "hosted",
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

const PROJECT_WITHOUT_CHECKOUT = {
  ...PROJECT,
  id: "proj_no_checkout",
  name: "Project Without Checkout",
  sources: [],
};

describe("NewThreadComposer environment providers", () => {
  beforeEach(() => {
    mocks.promptBoxProps.length = 0;
    mocks.projectThreads = [];
    mocks.sidebarNavigationSettled = true;
    mocks.sidebarNavigationReplayed = false;
    mocks.extraProjects = [];
    mocks.environmentProviders = [CHECKOUT_PROVIDER];
    resetPluginSlotStoreForTest();
    registerCheckoutInputsControl();
    window.localStorage.clear();
    getPromptDraftAccessor({ kind: "new-thread" }).setDraft({
      text: "",
      mentions: [],
      attachments: [],
    });
  });

  afterEach(() => {
    cleanup();
  });

  function renderUnseeded(
    onSubmit: (request: NewThreadRequest) => void,
    draftKey: string,
    projectId = "proj_1",
  ) {
    return render(
      <MemoryRouter>
        <LocationProbe />
        <PluginNewThreadComposer
          draftKey={draftKey}
          defaultProjectId={projectId}
          initialPrompt="run in the sandbox"
          onSubmit={onSubmit}
        />
      </MemoryRouter>,
    );
  }

  it("submits the value the provider's configuration slot produced", async () => {
    mocks.environmentProviders = [CHECKOUT_PROVIDER, SANDBOX_PROVIDER];
    setPluginSlotRegistrations("docker-sandbox", {
      ...EMPTY_SLOT_REGISTRATIONS,
      environmentProviderInputs: [
        {
          environmentProviderId: "container",
          component: ({ onChange }) => (
            <button
              type="button"
              data-testid="set-provider-config"
              onClick={() =>
                onChange({ status: "ready", value: { image: "img-chosen" } })
              }
            >
              choose
            </button>
          ),
        },
      ],
    });
    const submitted: NewThreadRequest[] = [];
    renderUnseeded((request) => {
      submitted.push(request);
    }, "provider-inputs");

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await act(async () => {
      latestPromptBoxProps().modeConfig.environment.onSelectProvider(
        SANDBOX_PROVIDER,
        null,
      );
    });
    await waitFor(() => {
      expect(latestPromptBoxProps().modeConfig.environment.value).toBe(
        "provider:container",
      );
      expect(screen.getByTestId("set-provider-config")).toBeTruthy();
    });
    expect(latestPromptBoxProps().disabled).toBe(true);
    fireEvent.click(screen.getByTestId("set-provider-config"));
    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await submit();

    expect(submitted).toHaveLength(1);
    expect(submitted[0].environment).toEqual({
      type: "provider",
      environmentProviderId: "container",
      machine: { type: "existing", hostId: "host_1" },
      inputs: { image: "img-chosen" },
    });
  });

  it("blocks a provider that declares inputs when its plugin registered no control", async () => {
    mocks.environmentProviders = [CHECKOUT_PROVIDER, SANDBOX_PROVIDER];
    const submitted: NewThreadRequest[] = [];
    renderUnseeded((request) => {
      submitted.push(request);
    }, "provider-missing-control");

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    expect(
      latestPromptBoxProps().modeConfig.environment.inputsControlProviderIds,
    ).toEqual(new Set(["project-checkout"]));
    await act(async () => {
      latestPromptBoxProps().modeConfig.environment.onSelectProvider(
        SANDBOX_PROVIDER,
        null,
      );
    });

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(true);
    });
    expect(latestPromptBoxProps().disabledReason).toBe(
      "Docker container needs its plugin's control",
    );
    await expect(submit()).resolves.toBeUndefined();
    expect(submitted).toHaveLength(0);
  });

  it("ignores a control registered by a plugin that does not own the provider", async () => {
    mocks.environmentProviders = [CHECKOUT_PROVIDER, SANDBOX_PROVIDER];
    setPluginSlotRegistrations("impostor", {
      ...EMPTY_SLOT_REGISTRATIONS,
      environmentProviderInputs: [
        {
          environmentProviderId: "container",
          component: ({ onChange }) => (
            <button
              type="button"
              data-testid="impostor-provider-config"
              onClick={() =>
                onChange({ status: "ready", value: { image: "img-impostor" } })
              }
            >
              choose
            </button>
          ),
        },
      ],
    });
    const submitted: NewThreadRequest[] = [];
    renderUnseeded((request) => {
      submitted.push(request);
    }, "provider-impostor-control");

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    expect(
      latestPromptBoxProps().modeConfig.environment.inputsControlProviderIds,
    ).toEqual(new Set(["project-checkout"]));
    await act(async () => {
      latestPromptBoxProps().modeConfig.environment.onSelectProvider(
        SANDBOX_PROVIDER,
        null,
      );
    });

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(true);
    });
    expect(latestPromptBoxProps().disabledReason).toBe(
      "Docker container needs its plugin's control",
    );
    expect(screen.queryByTestId("impostor-provider-config")).toBe(null);
    await expect(submit()).resolves.toBeUndefined();
    expect(submitted).toHaveLength(0);
  });

  it("submits empty inputs for a provider whose schema requires nothing and has no control", async () => {
    mocks.environmentProviders = [CHECKOUT_PROVIDER, OPTIONAL_INPUTS_PROVIDER];
    const submitted: NewThreadRequest[] = [];
    renderUnseeded((request) => {
      submitted.push(request);
    }, "provider-optional-inputs");

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await act(async () => {
      latestPromptBoxProps().modeConfig.environment.onSelectProvider(
        OPTIONAL_INPUTS_PROVIDER,
        null,
      );
    });
    await waitFor(() => {
      expect(latestPromptBoxProps().modeConfig.environment.value).toBe(
        "provider:optional-sandbox",
      );
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await submit();

    expect(submitted).toHaveLength(1);
    expect(submitted[0].environment).toEqual({
      type: "provider",
      environmentProviderId: "optional-sandbox",
      machine: { type: "existing", hostId: "host_1" },
      inputs: {},
    });
  });

  it("routes setup-required provider submissions to plugin settings", async () => {
    const setupRequiredProvider: SystemEnvironmentProvider = {
      ...OPTIONAL_INPUTS_PROVIDER,
      id: "modal-sandbox",
      displayName: "Modal sandbox",
      pluginId: "environment-modal-sandbox",
      inputs: null,
      availability: {
        status: "setup-required",
        message: "Add Modal credentials",
      },
    };
    mocks.environmentProviders = [CHECKOUT_PROVIDER, setupRequiredProvider];
    const submitted: NewThreadRequest[] = [];
    renderUnseeded((request) => {
      submitted.push(request);
    }, "provider-setup-required");

    await act(async () => {
      latestPromptBoxProps().modeConfig.environment.onSelectProvider(
        setupRequiredProvider,
        null,
      );
    });
    await waitFor(() => {
      expect(latestPromptBoxProps().modeConfig.environment.value).toBe(
        "provider:modal-sandbox",
      );
    });
    await submit();

    expect(submitted).toHaveLength(0);
    expect(screen.getByTestId("location-path").textContent).toBe(
      "/settings/plugins/environment-modal-sandbox",
    );
  });

  it("shows the plugin's blocked reason and prevents submit", async () => {
    mocks.environmentProviders = [CHECKOUT_PROVIDER, SANDBOX_PROVIDER];
    setPluginSlotRegistrations("docker-sandbox", {
      ...EMPTY_SLOT_REGISTRATIONS,
      environmentProviderInputs: [
        {
          environmentProviderId: "container",
          component: ({ onChange }) => (
            <button
              type="button"
              data-testid="clear-provider-config"
              onClick={() =>
                onChange({
                  status: "blocked",
                  reason: "Choose a container image",
                })
              }
            >
              clear
            </button>
          ),
        },
      ],
    });
    const submitted: NewThreadRequest[] = [];
    renderUnseeded((request) => {
      submitted.push(request);
    }, "provider-incomplete-config");

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await act(async () => {
      latestPromptBoxProps().modeConfig.environment.onSelectProvider(
        SANDBOX_PROVIDER,
        null,
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("clear-provider-config")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("clear-provider-config"));

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(true);
    });
    expect(latestPromptBoxProps().disabledReason).toBe(
      "Choose a container image",
    );
    await expect(submit()).resolves.toBeUndefined();
    expect(submitted).toHaveLength(0);
  });

  it("lets a host provider without gitCheckout use a machine that has no project checkout", async () => {
    mocks.environmentProviders = [
      CHECKOUT_PROVIDER,
      HOST_PROVIDER,
      BRANCH_PROVIDER,
    ];
    mocks.extraProjects = [PROJECT_WITHOUT_CHECKOUT];
    const submitted: NewThreadRequest[] = [];
    renderUnseeded(
      (request) => {
        submitted.push(request);
      },
      "host-provider-no-checkout",
      PROJECT_WITHOUT_CHECKOUT.id,
    );

    await waitFor(() => {
      expect(latestPromptBoxProps().project.value).toBe(
        PROJECT_WITHOUT_CHECKOUT.id,
      );
    });
    await act(async () => {
      latestPromptBoxProps().modeConfig.environment.onSelectProvider(
        BRANCH_PROVIDER,
        "host_1",
      );
    });
    await waitFor(() => {
      expect(latestPromptBoxProps().modeConfig.environment.value).toBe(
        "provider:branchy",
      );
    });
    expect(
      latestPromptBoxProps().modeConfig.environment.selectedProviderHostId,
    ).toBeNull();

    await act(async () => {
      latestPromptBoxProps().modeConfig.environment.onSelectProvider(
        HOST_PROVIDER,
        "host_1",
      );
    });
    await waitFor(() => {
      expect(latestPromptBoxProps().modeConfig.environment.value).toBe(
        "provider:hosted",
      );
      expect(
        latestPromptBoxProps().modeConfig.environment.selectedProviderHostId,
      ).toBe("host_1");
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await submit();

    expect(submitted).toHaveLength(1);
    expect(submitted[0].environment).toEqual({
      type: "provider",
      environmentProviderId: "hosted",
      machine: { type: "existing", hostId: "host_1" },
      inputs: null,
    });
  });

  it("submits a gitCheckout provider without inputs with the row's machine and no branch picker", async () => {
    mocks.environmentProviders = [CHECKOUT_PROVIDER, BRANCH_PROVIDER];
    const submitted: NewThreadRequest[] = [];
    renderUnseeded((request) => {
      submitted.push(request);
    }, "branch-provider-row");

    await waitFor(() => {
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await act(async () => {
      latestPromptBoxProps().modeConfig.environment.onSelectProvider(
        BRANCH_PROVIDER,
        "host_1",
      );
    });
    await waitFor(() => {
      expect(latestPromptBoxProps().modeConfig.environment.value).toBe(
        "provider:branchy",
      );
      expect(
        latestPromptBoxProps().modeConfig.environment.selectedProviderHostId,
      ).toBe("host_1");
      expect(latestPromptBoxProps().disabled).toBe(false);
    });
    await submit();

    expect(submitted).toHaveLength(1);
    expect(submitted[0].environment).toEqual({
      type: "provider",
      environmentProviderId: "branchy",
      machine: { type: "existing", hostId: "host_1" },
      inputs: null,
    });
  });
});
