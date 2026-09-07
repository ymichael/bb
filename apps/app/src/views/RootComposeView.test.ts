import {
  PERSONAL_PROJECT_ID,
  type ProjectSource,
  type ThreadListEntry,
} from "@bb/domain";
import type {
  ProjectBranchesResponse,
  ProjectWithThreadsResponse,
  SidebarBootstrapResponse,
  TerminalSession,
} from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { parseEnvironmentValue } from "@/components/pickers/environment-picker-value";
import type { ReuseThreadOption } from "@/components/pickers/WorktreePicker";
import {
  hasPromptBranchSelectionChanged,
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
  resolveProjectSourceWorktreeDisabledReason,
  resolveComposeHostId,
  resolveRootComposeEffectiveEnvironmentValue,
  resolveRootComposeProjectRouting,
  resolveRootComposeProviderRouting,
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
    branchMutationBlockerTitle: null,
    isCopyingAttachments: false,
    isLoadingModels: false,
    isSubmitting: false,
    isUploading: false,
    managedWorktreeUnavailableReason: null,
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
      "an unavailable worktree",
      {
        managedWorktreeUnavailableReason:
          "Project source has no commits. Create an initial commit before creating a worktree",
      },
      "Project source has no commits. Create an initial commit before creating a worktree",
    ],
    [
      "a blocked branch checkout",
      { branchMutationBlockerTitle: "Checkout blocked by uncommitted changes" },
      "Checkout blocked by uncommitted changes",
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

function makeReuseThreadOption(environmentId: string): ReuseThreadOption {
  return {
    environmentId,
    branchName: "feature",
    name: null,
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

describe("hasPromptBranchSelectionChanged", () => {
  it("treats the same branch selection as a no-op", () => {
    expect(
      hasPromptBranchSelectionChanged(
        { name: "main", isNew: false },
        { name: "main", isNew: false },
      ),
    ).toBe(false);
    expect(hasPromptBranchSelectionChanged(null, null)).toBe(false);
  });

  it("detects changed branch selections", () => {
    expect(
      hasPromptBranchSelectionChanged(
        { name: "main", isNew: false },
        { name: "main", isNew: true },
      ),
    ).toBe(true);
    expect(
      hasPromptBranchSelectionChanged({ name: "main", isNew: false }, null),
    ).toBe(true);
    expect(
      hasPromptBranchSelectionChanged(null, { name: "develop", isNew: false }),
    ).toBe(true);
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

describe("resolveProjectSourceWorktreeDisabledReason", () => {
  it("explains why non-git and commitless sources cannot create worktrees", () => {
    expect(resolveProjectSourceWorktreeDisabledReason(undefined)).toBeNull();
    expect(
      resolveProjectSourceWorktreeDisabledReason(
        makeProjectBranchesResponse({}),
      ),
    ).toBeNull();
    expect(
      resolveProjectSourceWorktreeDisabledReason(
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
      resolveProjectSourceWorktreeDisabledReason(
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

describe("resolveComposeHostId", () => {
  it("keys provider-CLI eligibility to the selected remote host, not the primary", () => {
    expect(
      resolveComposeHostId(
        parseEnvironmentValue("host:host_remote:worktree"),
        "host_primary",
      ),
    ).toBe("host_remote");
  });

  it("falls back to the primary host when no host is selected", () => {
    expect(
      resolveComposeHostId(
        parseEnvironmentValue("reuse:env_1"),
        "host_primary",
      ),
    ).toBe("host_primary");
    expect(resolveComposeHostId(parseEnvironmentValue(""), null)).toBeNull();
  });
});

describe("resolveRootComposeProjectRouting", () => {
  it("propagates the selected host or environment to project workspace calls", () => {
    expect(
      resolveRootComposeProjectRouting(
        parseEnvironmentValue("host:host_remote:worktree"),
        "host_primary",
      ),
    ).toEqual({ hostId: "host_remote" });
    expect(
      resolveRootComposeProjectRouting(
        parseEnvironmentValue("reuse:env_remote"),
        "host_primary",
      ),
    ).toEqual({ environmentId: "env_remote" });
  });
});

describe("resolveRootComposeEffectiveEnvironmentValue", () => {
  it("keeps host mode but rewrites the host id to the active project source host", () => {
    expect(
      resolveRootComposeEffectiveEnvironmentValue({
        knownHostIds: new Set(["host_1"]),
        environmentSelectionValue: "host:stale_host:worktree",
        isProjectless: false,
        primaryHostId: "host_1",
        projectSources: [makeProjectSource("host_1")],
        reuseThreadOptions: [],
        reuseThreadOptionsLoading: false,
      }),
    ).toBe("host:host_1:worktree");
  });

  it("does not invent a host workspace for a standard project without a source", () => {
    expect(
      resolveRootComposeEffectiveEnvironmentValue({
        knownHostIds: new Set(["host_1"]),
        environmentSelectionValue: "host:stale_host:local",
        isProjectless: false,
        primaryHostId: "host_1",
        projectSources: [],
        reuseThreadOptions: [],
        reuseThreadOptionsLoading: false,
      }),
    ).toBe("");
  });

  it("keeps a reuse environment only when it belongs to the selected project", () => {
    expect(
      resolveRootComposeEffectiveEnvironmentValue({
        knownHostIds: new Set(["host_1"]),
        environmentSelectionValue: "reuse:env_current",
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
        isProjectless: false,
        primaryHostId: "host_1",
        projectSources: [makeProjectSource("host_1")],
        reuseThreadOptions: [makeReuseThreadOption("env_current")],
        reuseThreadOptionsLoading: false,
      }),
    ).toBe("host:host_1:local");
  });

  it("holds specific reuse values as incomplete while project worktrees load", () => {
    expect(
      resolveRootComposeEffectiveEnvironmentValue({
        knownHostIds: new Set(["host_1"]),
        environmentSelectionValue: "reuse:env_pending",
        isProjectless: false,
        primaryHostId: "host_1",
        projectSources: [makeProjectSource("host_1")],
        reuseThreadOptions: [],
        reuseThreadOptionsLoading: true,
      }),
    ).toBe("reuse");
  });

  it("uses the primary host for projectless threads without requiring project sources", () => {
    expect(
      resolveRootComposeEffectiveEnvironmentValue({
        knownHostIds: new Set(["host_1"]),
        environmentSelectionValue: "host:stale_host:worktree",
        isProjectless: true,
        primaryHostId: "host_1",
        projectSources: [],
        reuseThreadOptions: [],
        reuseThreadOptionsLoading: false,
      }),
    ).toBe("host:host_1:local");
  });

  it("keeps a non-primary host selection when that host has a source", () => {
    expect(
      resolveRootComposeEffectiveEnvironmentValue({
        knownHostIds: new Set(["host_1", "host_2"]),
        environmentSelectionValue: "host:host_2:worktree",
        isProjectless: false,
        primaryHostId: "host_1",
        projectSources: [
          makeProjectSource("host_1"),
          makeProjectSource("host_2"),
        ],
        reuseThreadOptions: [],
        reuseThreadOptionsLoading: false,
      }),
    ).toBe("host:host_2:worktree");
  });

  it("falls back to the primary host when the selected host is gone", () => {
    expect(
      resolveRootComposeEffectiveEnvironmentValue({
        knownHostIds: new Set(["host_1"]),
        environmentSelectionValue: "host:host_gone:worktree",
        isProjectless: false,
        primaryHostId: "host_1",
        projectSources: [makeProjectSource("host_1")],
        reuseThreadOptions: [],
        reuseThreadOptionsLoading: false,
      }),
    ).toBe("host:host_1:worktree");
  });

  it("keeps a projectless machine selection normalized to local mode", () => {
    expect(
      resolveRootComposeEffectiveEnvironmentValue({
        knownHostIds: new Set(["host_1", "host_2"]),
        environmentSelectionValue: "host:host_2:worktree",
        isProjectless: true,
        primaryHostId: "host_1",
        projectSources: [],
        reuseThreadOptions: [],
        reuseThreadOptionsLoading: false,
      }),
    ).toBe("host:host_2:local");
  });

  it("falls back to the primary host for a stale projectless machine selection", () => {
    expect(
      resolveRootComposeEffectiveEnvironmentValue({
        knownHostIds: new Set(["host_1"]),
        environmentSelectionValue: "host:host_gone:local",
        isProjectless: true,
        primaryHostId: "host_1",
        projectSources: [],
        reuseThreadOptions: [],
        reuseThreadOptionsLoading: false,
      }),
    ).toBe("host:host_1:local");
  });

  it("falls back to the primary host when the selected host lacks a source", () => {
    expect(
      resolveRootComposeEffectiveEnvironmentValue({
        knownHostIds: new Set(["host_1", "host_2"]),
        environmentSelectionValue: "host:host_2:local",
        isProjectless: false,
        primaryHostId: "host_1",
        projectSources: [makeProjectSource("host_1")],
        reuseThreadOptions: [],
        reuseThreadOptionsLoading: false,
      }),
    ).toBe("host:host_1:local");
  });
});

describe("resolveRootComposeProviderRouting", () => {
  it("routes discovery through the effective selected host", () => {
    expect(
      resolveRootComposeProviderRouting({
        knownHostIds: new Set(["host_1", "host_2"]),
        environmentSelectionValue: "host:host_2:worktree",
        isProjectless: false,
        primaryHostId: "host_1",
        projectSources: [
          makeProjectSource("host_1"),
          makeProjectSource("host_2"),
        ],
        reuseThreadOptions: [],
        reuseThreadOptionsLoading: false,
      }),
    ).toEqual({ hostId: "host_2" });
  });

  it("routes stale selections through the effective primary fallback", () => {
    expect(
      resolveRootComposeProviderRouting({
        knownHostIds: new Set(["host_1"]),
        environmentSelectionValue: "host:host_gone:local",
        isProjectless: false,
        primaryHostId: "host_1",
        projectSources: [makeProjectSource("host_1")],
        reuseThreadOptions: [],
        reuseThreadOptionsLoading: false,
      }),
    ).toEqual({ hostId: "host_1" });
  });

  it("routes reusable worktrees by environment", () => {
    expect(
      resolveRootComposeProviderRouting({
        knownHostIds: new Set(["host_1"]),
        environmentSelectionValue: "reuse:env_remote",
        isProjectless: false,
        primaryHostId: "host_1",
        projectSources: [makeProjectSource("host_1")],
        reuseThreadOptions: [makeReuseThreadOption("env_remote")],
        reuseThreadOptionsLoading: false,
      }),
    ).toEqual({ environmentId: "env_remote" });
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
