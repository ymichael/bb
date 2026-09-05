import {
  PERSONAL_PROJECT_ID,
  type ProjectSource,
  type ThreadListEntry,
} from "@bb/domain";
import type {
  ProjectBranchesResponse,
  ProjectWithThreadsResponse,
  SidebarBootstrapResponse,
  SystemEnvironmentProvider,
  TerminalSession,
} from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import type { ReuseThreadOption } from "@/components/pickers/ReuseEnvironmentPicker";
import {
  hasPromptOptionValueChanged,
  mergeMissingPromptDraftAttachments,
  resolveNewThreadProjectDefaultsState,
  resolveNewThreadSubmitDisabledReason,
  restorePromptDraftAfterOptionChange,
  type ResolveNewThreadSubmitDisabledReasonArgs,
} from "@/components/promptbox/NewThreadComposer";
import { getProjectStoredPromptAttachmentPaths } from "@bb/client-core";
import { THREAD_HANDOFF_CREATE_SEED_LOCATION_STATE_KEY } from "@bb/client-core";
import {
  buildRootComposeTerminalSessions,
  buildMobileRecentThreads,
  canCreateRootComposeTerminal,
  hasSingleUseRootComposeTargetState,
  readSectionIdFromLocationState,
  readRootComposeSectionTargetFromLocationState,
  readInitialPromptFromLocationState,
  shouldReplaceInitialPromptFromLocationState,
  shouldStartComposingFromLocationState,
  shouldNavigateAfterThreadCreate,
} from "./RootComposeView";
import { resolveRootComposeProjectFileRouting } from "./RootComposePanelTabContent";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import { makeTerminalSession as makeTerminalSessionFixture } from "@/test/fixtures/terminal-sessions";
import {
  resolveProjectSourceGitDisabledReason,
  resolveRootComposeEffectiveEnvironmentValue,
} from "./root-compose-environment-selection";

describe("root-compose project file routing", () => {
  it("uses a persisted opener host instead of the newly selected context", () => {
    expect(
      resolveRootComposeProjectFileRouting({
        fileOpenerSource: {
          kind: "workspace",
          threadId: null,
          environmentId: null,
          projectId: "proj_opened",
          experimental_hostId: "host_opened",
        },
        selectedEnvironmentId: "env_selected",
        selectedHostId: "host_selected",
      }),
    ).toEqual({ environmentId: null, hostId: "host_opened" });
  });

  it("keeps primary-host routing when a persisted opener omits a host", () => {
    expect(
      resolveRootComposeProjectFileRouting({
        fileOpenerSource: {
          kind: "workspace",
          threadId: null,
          environmentId: null,
          projectId: "proj_opened",
        },
        selectedEnvironmentId: null,
        selectedHostId: "host_selected",
      }),
    ).toEqual({ environmentId: null, hostId: null });
  });

  it("retains live routing for a native project file tab", () => {
    expect(
      resolveRootComposeProjectFileRouting({
        fileOpenerSource: null,
        selectedEnvironmentId: "env_selected",
        selectedHostId: "host_selected",
      }),
    ).toEqual({
      environmentId: "env_selected",
      hostId: "host_selected",
    });
  });
});
describe("resolveNewThreadProjectDefaultsState", () => {
  const storedDefaults = {
    providerId: "codex",
    model: "gpt-5.6-sol",
    serviceTier: "default" as const,
    reasoningLevel: "medium" as const,
    permissionMode: "auto" as const,
  };

  it("keeps optimistic null defaults unresolved while the fallback query is pending", () => {
    expect(
      resolveNewThreadProjectDefaultsState({
        cachedDefaults: null,
        projectFound: true,
        queryData: undefined,
        queryIsError: false,
        queryIsPlaceholderData: false,
        queryIsSuccess: false,
      }),
    ).toEqual({ status: "pending" });
  });

  it("uses the authoritative saved defaults when the delayed query resolves", () => {
    expect(
      resolveNewThreadProjectDefaultsState({
        cachedDefaults: null,
        projectFound: true,
        queryData: storedDefaults,
        queryIsError: false,
        queryIsPlaceholderData: false,
        queryIsSuccess: true,
      }),
    ).toEqual({ status: "resolved", defaults: storedDefaults });
  });

  it("only confirms absence after the fallback query succeeds with null", () => {
    expect(
      resolveNewThreadProjectDefaultsState({
        cachedDefaults: null,
        projectFound: true,
        queryData: null,
        queryIsError: false,
        queryIsPlaceholderData: false,
        queryIsSuccess: true,
      }),
    ).toEqual({ status: "resolved", defaults: null });
  });

  it("does not treat a previous project's placeholder as authoritative", () => {
    expect(
      resolveNewThreadProjectDefaultsState({
        cachedDefaults: null,
        projectFound: true,
        queryData: storedDefaults,
        queryIsError: false,
        queryIsPlaceholderData: true,
        queryIsSuccess: true,
      }),
    ).toEqual({ status: "pending" });
  });
});

describe("resolveNewThreadSubmitDisabledReason", () => {
  const readyState = {
    environmentProviderInputsBlocker: null,
    isCopyingAttachments: false,
    isLoadingModels: false,
    isSubmitting: false,
    isUploading: false,
    gitCheckoutUnavailableReason: null,
    modelLoadError: null,
    projectDefaultsStatus: "resolved",
    projectDefaultsUnavailable: false,
    promptInputEmpty: false,
    providerDisplayName: "Codex",
    selectedProviderId: "codex",
    selectedThreadModel: "gpt-5.6-sol",
    submissionEnvironmentUnavailable: false,
  } satisfies ResolveNewThreadSubmitDisabledReasonArgs;

  it.each<
    [
      label: string,
      change: Partial<ResolveNewThreadSubmitDisabledReasonArgs>,
      reason: string,
    ]
  >([
    [
      "model loading after a machine switch",
      { isLoadingModels: true },
      "Loading models from the selected machine...",
    ],
    [
      "provider setup failure",
      {
        modelLoadError: {
          providerId: "codex",
          code: "auth_required",
        },
      },
      "Could not load models for Codex. Authentication is required.",
    ],
    [
      "project-default failure",
      {
        projectDefaultsStatus: "error",
        projectDefaultsUnavailable: true,
      },
      "Could not load the project's execution defaults.",
    ],
    [
      "an incomplete environment selection",
      { submissionEnvironmentUnavailable: true },
      "Select an environment.",
    ],
    [
      "an environment provider whose inputs are incomplete",
      {
        environmentProviderInputsBlocker: "Configure Docker container",
        submissionEnvironmentUnavailable: true,
      },
      "Configure Docker container",
    ],
    [
      "an environment provider whose plugin registered no inputs control",
      {
        environmentProviderInputsBlocker:
          "Docker container needs its plugin's control",
        submissionEnvironmentUnavailable: true,
      },
      "Docker container needs its plugin's control",
    ],
    [
      "an unavailable worktree",
      {
        gitCheckoutUnavailableReason:
          "Project source has no commits. Create an initial commit before creating a worktree",
      },
      "Project source has no commits. Create an initial commit before creating a worktree",
    ],
    [
      "an empty prompt",
      { promptInputEmpty: true },
      "Enter a prompt or attach a file.",
    ],
  ])("reports %s", (_label, change, reason) => {
    expect(
      resolveNewThreadSubmitDisabledReason({ ...readyState, ...change }),
    ).toBe(reason);
  });

  it("returns no reason when every submission requirement is ready", () => {
    expect(resolveNewThreadSubmitDisabledReason(readyState)).toBeNull();
  });

  it("allows a selected fallback model after a transient model-list failure", () => {
    expect(
      resolveNewThreadSubmitDisabledReason({
        ...readyState,
        modelLoadError: { providerId: "claude-code", code: "timeout" },
      }),
    ).toBeNull();
  });
});

interface MakeThreadArgs {
  id: string;
  projectId: string;
}

interface MakeProjectArgs {
  id: string;
  kind: ProjectWithThreadsResponse["kind"];
  name: string;
  threads: readonly ThreadListEntry[];
}

function makeProjectSource(hostId = "host_1"): ProjectSource {
  return {
    id: "src_1",
    projectId: "proj_app",
    type: "local_path",
    hostId,
    path: "/repo",
    isDefault: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeProjectProvider(id: string): SystemEnvironmentProvider {
  return {
    id,
    displayName: id,
    icon: null,
    logoUrl: null,
    pluginId: id,
    acceptsEmptyInputs: true,
    availability: null,
    requires: {
      projectCheckout: true,
      gitCheckout: id === "git-worktree",
      gitRemote: false,
      projectless: false,
    },
    inputs: null,
  };
}

function makeProjectlessProvider(
  id: string,
  projectless: boolean,
): SystemEnvironmentProvider {
  return {
    id,
    displayName: id,
    icon: null,
    logoUrl: null,
    pluginId: id,
    acceptsEmptyInputs: true,
    availability: null,
    requires: {
      projectCheckout: false,
      gitCheckout: false,
      gitRemote: false,
      projectless,
    },
    inputs: null,
  };
}

function makeReuseThreadOption(environmentId: string): ReuseThreadOption {
  return {
    environmentId,
    branchName: "feature",
    name: null,
    path: null,
    environmentProviderId: "git-worktree",
    threads: [{ id: "thr_1", title: "Thread" }],
  };
}

function makeThread(args: MakeThreadArgs): ThreadListEntry {
  return makeThreadListEntry({
    id: args.id,
    projectId: args.projectId,
    title: args.id,
    titleFallback: args.id,
    createdAt: 100,
  });
}

function makeProject(args: MakeProjectArgs): ProjectWithThreadsResponse {
  return makeProjectWithThreadsResponse({
    id: args.id,
    kind: args.kind,
    name: args.name,
    threads: [...args.threads],
    createdAt: 1,
    updatedAt: 1,
  });
}

function makeTerminalSession(
  overrides: Partial<TerminalSession>,
): TerminalSession {
  return makeTerminalSessionFixture({
    id: "term_1",
    threadId: null,
    environmentId: null,
    hostId: "host_1",
    initialCwd: "/repo",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });
}

function makeProjectBranchesResponse(
  overrides: Partial<ProjectBranchesResponse>,
): ProjectBranchesResponse {
  return {
    branches: [],
    branchesTruncated: false,
    checkout: { kind: "branch", branchName: "main", headSha: null },
    defaultBranch: "main",
    defaultBranchRelation: "equal",
    defaultWorktreeBaseBranch: "main",
    isWorktree: false,
    hasUncommittedChanges: false,
    operation: { kind: "none" },
    originDefaultBranch: "main",
    remoteBranches: [],
    remoteBranchesTruncated: false,
    selectedBranch: null,
    ...overrides,
  };
}

describe("buildMobileRecentThreads", () => {
  it("includes projectless and every project thread", () => {
    const sidebarNavigation: SidebarBootstrapResponse =
      makeSidebarBootstrapResponse({
        personalProject: makeProject({
          id: PERSONAL_PROJECT_ID,
          kind: "personal",
          name: "Personal",
          threads: [
            makeThread({
              id: "thr_personal",
              projectId: PERSONAL_PROJECT_ID,
            }),
          ],
        }),
        projects: [
          makeProject({
            id: "proj_app",
            kind: "standard",
            name: "App",
            threads: [
              makeThread({
                id: "thr_app",
                projectId: "proj_app",
              }),
            ],
          }),
          makeProject({
            id: "proj_docs",
            kind: "standard",
            name: "Docs",
            threads: [
              makeThread({
                id: "thr_docs",
                projectId: "proj_docs",
              }),
            ],
          }),
        ],
      });

    const threadIds = buildMobileRecentThreads({ sidebarNavigation }).map(
      (thread) => thread.id,
    );

    expect(threadIds).toEqual(["thr_personal", "thr_app", "thr_docs"]);
  });
});

describe("readInitialPromptFromLocationState", () => {
  it("returns the initialPrompt string seeded by navigation state", () => {
    expect(
      readInitialPromptFromLocationState({
        focusPrompt: true,
        initialPrompt: "Create a new bb automation to ",
      }),
    ).toBe("Create a new bb automation to ");
  });

  it("returns null when no usable initialPrompt is present", () => {
    expect(readInitialPromptFromLocationState(null)).toBeNull();
    expect(readInitialPromptFromLocationState({})).toBeNull();
    expect(
      readInitialPromptFromLocationState({ initialPrompt: "" }),
    ).toBeNull();
    expect(
      readInitialPromptFromLocationState({ initialPrompt: 42 }),
    ).toBeNull();
  });
});

describe("shouldReplaceInitialPromptFromLocationState", () => {
  it("returns true only for explicit replacement seed intents", () => {
    expect(
      shouldReplaceInitialPromptFromLocationState({
        initialPrompt: "Create a new bb skill to review PRs.",
        replaceInitialPrompt: true,
      }),
    ).toBe(true);
    expect(
      shouldReplaceInitialPromptFromLocationState({
        initialPrompt: "Create a new bb skill to review PRs.",
      }),
    ).toBe(false);
    expect(shouldReplaceInitialPromptFromLocationState(null)).toBe(false);
  });
});

describe("readSectionIdFromLocationState", () => {
  it("returns a trimmed section id seeded by navigation state", () => {
    expect(readSectionIdFromLocationState({ sectionId: " sec_work " })).toBe(
      "sec_work",
    );
  });

  it("returns null when no usable section id is present", () => {
    expect(readSectionIdFromLocationState(null)).toBeNull();
    expect(readSectionIdFromLocationState({})).toBeNull();
    expect(readSectionIdFromLocationState({ sectionId: "" })).toBeNull();
    expect(readSectionIdFromLocationState({ sectionId: 42 })).toBeNull();
  });
});

describe("readRootComposeSectionTargetFromLocationState", () => {
  it("returns a section target when navigation provides a section id", () => {
    expect(
      readRootComposeSectionTargetFromLocationState({
        sectionId: " sec_work ",
      }),
    ).toEqual({ sectionId: "sec_work", kind: "set" });
  });

  it("clears the section target for plain new-thread focus navigation", () => {
    expect(
      readRootComposeSectionTargetFromLocationState({ focusPrompt: true }),
    ).toEqual({ kind: "clear" });
  });

  it("clears the section target for an unusable section id", () => {
    expect(
      readRootComposeSectionTargetFromLocationState({ sectionId: "" }),
    ).toEqual({ kind: "clear" });
  });

  it("returns null when no section target instruction is present", () => {
    expect(readRootComposeSectionTargetFromLocationState(null)).toBeNull();
    expect(readRootComposeSectionTargetFromLocationState({})).toBeNull();
  });
});

describe("mergeMissingPromptDraftAttachments", () => {
  it("restores attachments that disappeared during option changes", () => {
    expect(
      mergeMissingPromptDraftAttachments(
        [
          {
            type: "localFile",
            path: "notes.md",
            name: "notes.md",
            mimeType: "text/markdown",
            sizeBytes: 32,
          },
        ],
        [
          {
            type: "localImage",
            path: "screenshot.png",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 64,
          },
        ],
      ),
    ).toEqual([
      {
        type: "localFile",
        path: "notes.md",
        name: "notes.md",
        mimeType: "text/markdown",
        sizeBytes: 32,
      },
      {
        type: "localImage",
        path: "screenshot.png",
        name: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 64,
      },
    ]);
  });

  it("leaves attachments alone when the preserved paths are still present", () => {
    expect(
      mergeMissingPromptDraftAttachments(
        [
          {
            type: "localImage",
            path: "screenshot.png",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 64,
          },
        ],
        [
          {
            type: "localImage",
            path: "screenshot.png",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 64,
          },
        ],
      ),
    ).toBeNull();
  });
});

describe("getProjectStoredPromptAttachmentPaths", () => {
  it("selects only server-managed relative attachment paths", () => {
    expect(
      getProjectStoredPromptAttachmentPaths([
        {
          type: "localImage",
          path: "image-uploaded.png",
          name: "image.png",
          mimeType: "image/png",
          sizeBytes: 64,
        },
        {
          type: "localFile",
          path: "image-uploaded.png",
          name: "duplicate.png",
          sizeBytes: 64,
        },
        {
          type: "localFile",
          path: "/tmp/report.pdf",
          name: "report.pdf",
          sizeBytes: 32,
        },
        {
          type: "localImage",
          path: "C:\\Users\\sawyer\\screenshot.png",
          name: "screenshot.png",
          sizeBytes: 32,
        },
        {
          type: "localFile",
          path: "https://example.test/report.pdf",
          name: "remote.pdf",
          sizeBytes: 32,
        },
      ]),
    ).toEqual(["image-uploaded.png"]);
  });
});

describe("restorePromptDraftAfterOptionChange", () => {
  it("restores a full text draft that an option change cleared", () => {
    const mention = {
      start: 0,
      end: 7,
      resource: {
        kind: "path" as const,
        path: "README.md",
        source: "workspace" as const,
        entryKind: "file" as const,
        label: "README.md",
      },
    };

    expect(
      restorePromptDraftAfterOptionChange({
        currentDraft: { text: "", mentions: [], attachments: [] },
        preservedDraft: {
          text: "README.md please",
          mentions: [mention],
          attachments: [
            {
              type: "localImage",
              path: "screenshot.png",
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 64,
            },
          ],
        },
      }),
    ).toEqual({
      text: "README.md please",
      mentions: [mention],
      attachments: [
        {
          type: "localImage",
          path: "screenshot.png",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 64,
        },
      ],
    });
  });

  it("merges missing attachments without replacing new draft text", () => {
    expect(
      restorePromptDraftAfterOptionChange({
        currentDraft: {
          text: "newer text",
          mentions: [],
          attachments: [],
        },
        preservedDraft: {
          text: "older text",
          mentions: [],
          attachments: [
            {
              type: "localImage",
              path: "screenshot.png",
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 64,
            },
          ],
        },
      }),
    ).toEqual({
      text: "newer text",
      mentions: [],
      attachments: [
        {
          type: "localImage",
          path: "screenshot.png",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 64,
        },
      ],
    });
  });

  it("does not rewrite an unchanged draft", () => {
    const draft = {
      text: "ship this",
      mentions: [],
      attachments: [],
    };

    expect(
      restorePromptDraftAfterOptionChange({
        currentDraft: draft,
        preservedDraft: draft,
      }),
    ).toBeNull();
  });
});

describe("hasPromptOptionValueChanged", () => {
  it("treats unchanged prompt option values as no-ops", () => {
    expect(hasPromptOptionValueChanged("codex", "codex")).toBe(false);
    expect(hasPromptOptionValueChanged(undefined, undefined)).toBe(false);
  });

  it("detects changed prompt option values", () => {
    expect(hasPromptOptionValueChanged("codex", "claude")).toBe(true);
    expect(hasPromptOptionValueChanged(undefined, "auto")).toBe(true);
  });
});

describe("hasSingleUseRootComposeTargetState", () => {
  it("treats section targets as single-use navigation state", () => {
    expect(hasSingleUseRootComposeTargetState({ sectionId: "sec_work" })).toBe(
      true,
    );
  });

  it("treats plain new-thread navigation as single-use target state", () => {
    expect(hasSingleUseRootComposeTargetState({ focusPrompt: true })).toBe(
      true,
    );
  });

  it("treats handoff seeds as single-use target state", () => {
    expect(
      hasSingleUseRootComposeTargetState({
        [THREAD_HANDOFF_CREATE_SEED_LOCATION_STATE_KEY]: {
          environmentId: "env_source",
          projectId: "proj_source",
          sourceThreadId: "thr_source",
          sourceThreadTitle: "Source thread",
        },
      }),
    ).toBe(true);
  });

  it("ignores non-target state", () => {
    expect(hasSingleUseRootComposeTargetState(null)).toBe(false);
  });
});

describe("shouldStartComposingFromLocationState", () => {
  it("treats sidebar new-thread focus navigation as a compose request", () => {
    expect(shouldStartComposingFromLocationState({ focusPrompt: true })).toBe(
      true,
    );
  });

  it("ignores non-focus navigation state", () => {
    expect(shouldStartComposingFromLocationState(null)).toBe(false);
    expect(shouldStartComposingFromLocationState({})).toBe(false);
    expect(shouldStartComposingFromLocationState({ focusPrompt: false })).toBe(
      false,
    );
  });
});

describe("shouldNavigateAfterThreadCreate", () => {
  it("follows the preference for ordinary new threads", () => {
    expect(
      shouldNavigateAfterThreadCreate({
        isForkDraft: false,
        navigateToThreadAfterCreate: false,
      }),
    ).toBe(false);
    expect(
      shouldNavigateAfterThreadCreate({
        isForkDraft: false,
        navigateToThreadAfterCreate: true,
      }),
    ).toBe(true);
  });

  it("always navigates for submitted fork drafts", () => {
    expect(
      shouldNavigateAfterThreadCreate({
        isForkDraft: true,
        navigateToThreadAfterCreate: false,
      }),
    ).toBe(true);
  });
});

describe("resolveProjectSourceGitDisabledReason", () => {
  it("explains why non-git and commitless sources cannot create worktrees", () => {
    expect(resolveProjectSourceGitDisabledReason(undefined)).toBeNull();
    expect(
      resolveProjectSourceGitDisabledReason(makeProjectBranchesResponse({})),
    ).toBeNull();
    expect(
      resolveProjectSourceGitDisabledReason(
        makeProjectBranchesResponse({
          checkout: {
            kind: "unknown",
            reason: "Path is not a git repository",
          },
          defaultBranch: null,
          defaultBranchRelation: null,
          defaultWorktreeBaseBranch: null,
          originDefaultBranch: null,
        }),
      ),
    ).toBe("New worktrees require a Git repository with at least one commit");
    expect(
      resolveProjectSourceGitDisabledReason(
        makeProjectBranchesResponse({
          checkout: { kind: "unborn", branchName: "main" },
          defaultBranch: null,
          defaultBranchRelation: null,
          defaultWorktreeBaseBranch: null,
          originDefaultBranch: null,
        }),
      ),
    ).toBe(
      "Project source has no commits. Create an initial commit before creating a worktree",
    );
  });
});

describe("resolveRootComposeEffectiveEnvironmentValue", () => {
  const checkoutProvider = makeProjectProvider("project-checkout");
  const worktreeProvider = makeProjectProvider("git-worktree");

  it("falls back to the checkout on the primary host for a project with a source there", () => {
    expect(
      resolveRootComposeEffectiveEnvironmentValue({
        knownHostIds: new Set(["host_1"]),
        environmentSelectionValue: "",
        environmentProviders: [checkoutProvider, worktreeProvider],
        isProjectless: false,
        primaryHostId: "host_1",
        projectSources: [makeProjectSource("host_1")],
        reuseThreadOptions: [],
        reuseThreadOptionsLoading: false,
      }),
    ).toBe("provider:project-checkout");
  });

  it("does not invent a checkout for a standard project without a source on the primary host", () => {
    expect(
      resolveRootComposeEffectiveEnvironmentValue({
        knownHostIds: new Set(["host_1", "host_2"]),
        environmentSelectionValue: "",
        environmentProviders: [checkoutProvider],
        isProjectless: false,
        primaryHostId: "host_1",
        projectSources: [makeProjectSource("host_2")],
        reuseThreadOptions: [],
        reuseThreadOptionsLoading: false,
      }),
    ).toBe("");
  });

  it("holds the selection until the provider list has loaded", () => {
    expect(
      resolveRootComposeEffectiveEnvironmentValue({
        knownHostIds: new Set(["host_1"]),
        environmentSelectionValue: "provider:git-worktree",
        isProjectless: false,
        primaryHostId: "host_1",
        projectSources: [makeProjectSource("host_1")],
        reuseThreadOptions: [],
        reuseThreadOptionsLoading: false,
      }),
    ).toBe("");
  });

  it("keeps a registered provider the user picked and drops one that is gone", () => {
    const args = {
      knownHostIds: new Set(["host_1"]),
      environmentProviders: [checkoutProvider, worktreeProvider],
      isProjectless: false,
      primaryHostId: "host_1",
      projectSources: [makeProjectSource("host_1")],
      reuseThreadOptions: [],
      reuseThreadOptionsLoading: false,
    };
    expect(
      resolveRootComposeEffectiveEnvironmentValue({
        ...args,
        environmentSelectionValue: "provider:git-worktree",
      }),
    ).toBe("provider:git-worktree");
    expect(
      resolveRootComposeEffectiveEnvironmentValue({
        ...args,
        environmentSelectionValue: "provider:gone",
      }),
    ).toBe("provider:project-checkout");
  });

  it("keeps a reuse environment only when it belongs to the selected project", () => {
    expect(
      resolveRootComposeEffectiveEnvironmentValue({
        knownHostIds: new Set(["host_1"]),
        environmentSelectionValue: "reuse:env_current",
        environmentProviders: [checkoutProvider],
        isProjectless: false,
        primaryHostId: "host_1",
        projectSources: [makeProjectSource("host_1")],
        reuseThreadOptions: [makeReuseThreadOption("env_current")],
        reuseThreadOptionsLoading: false,
      }),
    ).toBe("reuse:env_current");

    expect(
      resolveRootComposeEffectiveEnvironmentValue({
        knownHostIds: new Set(["host_1"]),
        environmentSelectionValue: "reuse:env_stale",
        environmentProviders: [checkoutProvider],
        isProjectless: false,
        primaryHostId: "host_1",
        projectSources: [makeProjectSource("host_1")],
        reuseThreadOptions: [makeReuseThreadOption("env_current")],
        reuseThreadOptionsLoading: false,
      }),
    ).toBe("provider:project-checkout");
  });

  it("holds specific reuse values as incomplete while project worktrees load", () => {
    expect(
      resolveRootComposeEffectiveEnvironmentValue({
        knownHostIds: new Set(["host_1"]),
        environmentSelectionValue: "reuse:env_pending",
        environmentProviders: [checkoutProvider],
        isProjectless: false,
        primaryHostId: "host_1",
        projectSources: [makeProjectSource("host_1")],
        reuseThreadOptions: [],
        reuseThreadOptionsLoading: true,
      }),
    ).toBe("reuse");
  });

  it("keeps a projectless reuse selection when the environment is one of its own", () => {
    expect(
      resolveRootComposeEffectiveEnvironmentValue({
        knownHostIds: new Set(["host_1"]),
        environmentSelectionValue: "reuse:env_personal",
        environmentProviders: [
          makeProjectlessProvider("personal-workspace", true),
        ],
        isProjectless: true,
        primaryHostId: "host_1",
        projectSources: [],
        reuseThreadOptions: [makeReuseThreadOption("env_personal")],
        reuseThreadOptionsLoading: false,
      }),
    ).toBe("reuse:env_personal");
  });

  it("drops a projectless reuse selection whose environment is not among its own", () => {
    expect(
      resolveRootComposeEffectiveEnvironmentValue({
        knownHostIds: new Set(["host_1"]),
        environmentSelectionValue: "reuse:env_gone",
        environmentProviders: [
          makeProjectlessProvider("personal-workspace", true),
        ],
        isProjectless: true,
        primaryHostId: "host_1",
        projectSources: [],
        reuseThreadOptions: [makeReuseThreadOption("env_personal")],
        reuseThreadOptionsLoading: false,
      }),
    ).toBe("provider:personal-workspace");
  });

  it("preselects the projectless-only provider once a projectless thread has a choice", () => {
    expect(
      resolveRootComposeEffectiveEnvironmentValue({
        knownHostIds: new Set(["host_1"]),
        environmentSelectionValue: "",
        environmentProviders: [
          makeProjectlessProvider("alpha-sandbox", true),
          makeProjectlessProvider("personal-workspace", true),
        ],
        isProjectless: true,
        primaryHostId: "host_1",
        projectSources: [],
        reuseThreadOptions: [],
        reuseThreadOptionsLoading: false,
      }),
    ).toBe("provider:personal-workspace");
  });

  it("replaces a provider a projectless thread cannot use", () => {
    expect(
      resolveRootComposeEffectiveEnvironmentValue({
        knownHostIds: new Set(["host_1"]),
        environmentSelectionValue: "provider:modal-sandbox",
        environmentProviders: [
          makeProjectlessProvider("modal-sandbox", false),
          makeProjectlessProvider("personal-workspace", true),
        ],
        isProjectless: true,
        primaryHostId: "host_1",
        projectSources: [],
        reuseThreadOptions: [],
        reuseThreadOptionsLoading: false,
      }),
    ).toBe("provider:personal-workspace");
  });

  it("selects nothing for a projectless thread until its providers have loaded", () => {
    expect(
      resolveRootComposeEffectiveEnvironmentValue({
        knownHostIds: new Set(["host_1"]),
        environmentSelectionValue: "provider:personal-workspace",
        isProjectless: true,
        primaryHostId: "host_1",
        projectSources: [],
        reuseThreadOptions: [],
        reuseThreadOptionsLoading: false,
      }),
    ).toBe("");
  });
});

describe("buildRootComposeTerminalSessions", () => {
  it("keeps host-path terminal sessions unresolved until the global list loads", () => {
    expect(
      buildRootComposeTerminalSessions({
        environmentTerminalSessions: undefined,
        globalTerminalSessions: undefined,
        terminalTarget: {
          kind: "host_path",
          hostId: "host_1",
          cwd: "/repo",
        },
      }),
    ).toBeUndefined();
  });

  it("filters loaded host-path terminal sessions by root target", () => {
    const matching = makeTerminalSession({
      id: "term_matching",
      hostId: "host_1",
      initialCwd: "/repo",
    });
    const otherHost = makeTerminalSession({
      id: "term_other_host",
      hostId: "host_2",
      initialCwd: "/repo",
    });
    const threadTerminal = makeTerminalSession({
      id: "term_thread",
      threadId: "thr_1",
      hostId: "host_1",
      initialCwd: "/repo",
    });

    expect(
      buildRootComposeTerminalSessions({
        environmentTerminalSessions: undefined,
        globalTerminalSessions: [matching, otherHost, threadTerminal],
        terminalTarget: {
          kind: "host_path",
          hostId: "host_1",
          cwd: "/repo",
        },
      }),
    ).toEqual([matching]);
  });
});

describe("canCreateRootComposeTerminal", () => {
  const connectedHostIds = new Set(["host_1"]);

  it("allows ready environments and host paths on connected hosts", () => {
    expect(
      canCreateRootComposeTerminal({
        connectedHostIds,
        environmentHostId: "host_1",
        terminalTarget: { kind: "environment", environmentId: "env_1" },
        environmentStatus: "ready",
      }),
    ).toBe(true);

    expect(
      canCreateRootComposeTerminal({
        connectedHostIds,
        environmentHostId: "host_1",
        terminalTarget: { kind: "environment", environmentId: "env_1" },
        environmentStatus: "provisioning",
      }),
    ).toBe(false);

    expect(
      canCreateRootComposeTerminal({
        connectedHostIds,
        environmentHostId: undefined,
        terminalTarget: { kind: "host_path", hostId: "host_1", cwd: "/repo" },
        environmentStatus: undefined,
      }),
    ).toBe(true);

    expect(
      canCreateRootComposeTerminal({
        connectedHostIds,
        environmentHostId: undefined,
        terminalTarget: { kind: "host_path", hostId: "host_1", cwd: null },
        environmentStatus: undefined,
      }),
    ).toBe(true);

    expect(
      canCreateRootComposeTerminal({
        connectedHostIds,
        environmentHostId: "host_1",
        terminalTarget: null,
        environmentStatus: "ready",
      }),
    ).toBe(false);
  });

  it("blocks terminal creation on offline hosts", () => {
    expect(
      canCreateRootComposeTerminal({
        connectedHostIds,
        environmentHostId: "host_offline",
        terminalTarget: { kind: "environment", environmentId: "env_1" },
        environmentStatus: "ready",
      }),
    ).toBe(false);

    expect(
      canCreateRootComposeTerminal({
        connectedHostIds,
        environmentHostId: undefined,
        terminalTarget: {
          kind: "host_path",
          hostId: "host_offline",
          cwd: "/repo",
        },
        environmentStatus: undefined,
      }),
    ).toBe(false);
  });
});
