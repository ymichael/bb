import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import type { ThreadListEntry } from "@bb/domain";
import { NewThreadPromptBox } from "@/components/promptbox/NewThreadPromptBox";
import {
  encodeReuseValue,
  parseEnvironmentValue,
} from "@/components/pickers/environment-picker-value";
import { OptionPicker } from "@/components/pickers/OptionPicker";
import type { ReuseThreadOption } from "@/components/pickers/WorktreePicker";
import { Icon } from "@/components/ui/icon.js";
import { PageShell } from "@/components/ui/page-shell.js";
import { useUploadPromptAttachment } from "@/hooks/mutations/project-mutations";
import { useCreateThread } from "@/hooks/mutations/thread-runtime-mutations";
import {
  useProjectPromptHistory,
  useProjectSourceBranches,
  useProjects,
  useSidebarBootstrap,
} from "@/hooks/queries/project-queries";
import { useThreads } from "@/hooks/queries/thread-queries";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { usePromptDraftStorage } from "@/hooks/usePromptDraftStorage";
import { usePromptMentions } from "@/hooks/usePromptMentions";
import { useThreadCreationOptions } from "@/hooks/useThreadCreationOptions";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { promptHistoryEntriesToDrafts } from "@/lib/prompt-history";
import { getProjectScopedStorageKey } from "@/lib/project-scoped-storage";
import { promptDraftToInput } from "@/lib/prompt-draft";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { resolveProjectMainThreadEnvironment } from "./project-main-thread-environment";
import { useScopedBranchSelection } from "./project-main-branch-selection";

const PROJECT_MAIN_ZEN_MODE_STORAGE_KEY = "bb.promptbox.zen-mode.project-main";

// react-router's location.state is freeform unknown — narrow it here at the
// system boundary before reading.
function readReuseEnvironmentIdFromLocationState(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const candidate = (state as { reuseEnvironmentId?: unknown })
    .reuseEnvironmentId;
  if (typeof candidate === "string" && candidate.length > 0) return candidate;
  return null;
}

function isWorktreeWithEnv(thread: ThreadListEntry): boolean {
  if (thread.environmentId === null) return false;
  return (
    thread.environmentWorkspaceDisplayKind === "managed-worktree" ||
    thread.environmentWorkspaceDisplayKind === "unmanaged-worktree"
  );
}

function buildReuseThreadOptions(
  threads: readonly ThreadListEntry[],
): ReuseThreadOption[] {
  // One option per worktree env. Threads within each env are sorted
  // most-recently-active first so the picker preview surfaces the threads
  // the user is most likely to recognize. Only unarchived threads reach
  // here — `useThreads({ archived: false })` filters at the source. Envs
  // with no unarchived threads naturally drop out.
  const threadsByEnvironmentId = new Map<string, ThreadListEntry[]>();
  const branchByEnvironmentId = new Map<string, string | null>();
  for (const thread of threads) {
    if (!isWorktreeWithEnv(thread)) continue;
    if (thread.environmentId === null) continue;
    let bucket = threadsByEnvironmentId.get(thread.environmentId);
    if (!bucket) {
      bucket = [];
      threadsByEnvironmentId.set(thread.environmentId, bucket);
      branchByEnvironmentId.set(
        thread.environmentId,
        thread.environmentBranchName,
      );
    }
    bucket.push(thread);
  }
  const options: ReuseThreadOption[] = [];
  for (const [environmentId, bucket] of threadsByEnvironmentId) {
    bucket.sort(
      (left, right) => right.latestAttentionAt - left.latestAttentionAt,
    );
    options.push({
      environmentId,
      branchName: branchByEnvironmentId.get(environmentId) ?? null,
      threads: bucket.map((thread) => ({
        id: thread.id,
        title: getThreadDisplayTitle(thread),
      })),
    });
  }
  options.sort((left, right) => {
    if (left.branchName && right.branchName) {
      return left.branchName.localeCompare(right.branchName);
    }
    return left.environmentId.localeCompare(right.environmentId);
  });
  return options;
}

export function ProjectMainView() {
  const { projectId } = useParams<{ projectId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const sidebarBootstrapQuery = useSidebarBootstrap();
  const hasSidebarBootstrapSettled =
    sidebarBootstrapQuery.isSuccess || sidebarBootstrapQuery.isError;
  const projectsQuery = useProjects({ enabled: hasSidebarBootstrapSettled });
  const projects = projectsQuery.data;
  const projectsLoading =
    sidebarBootstrapQuery.isFetching || projectsQuery.isLoading;
  const createThread = useCreateThread();
  const { localHostId } = useHostDaemon();
  const uploadPromptAttachment = useUploadPromptAttachment();
  const promptDraft = usePromptDraftStorage({ projectId, threadId: null });
  const { data: projectPromptHistory = [] } =
    useProjectPromptHistory(projectId);
  const promptMentions = usePromptMentions(projectId, { environmentId: null });
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const prompt = promptDraft.text;
  const promptInput = useMemo(
    () =>
      promptDraftToInput({
        text: promptDraft.text,
        attachments: promptDraft.attachments,
      }),
    [promptDraft.attachments, promptDraft.text],
  );
  const projectMainZenModeStorageKey = useMemo(
    () =>
      getProjectScopedStorageKey(PROJECT_MAIN_ZEN_MODE_STORAGE_KEY, projectId),
    [projectId],
  );
  const promptHistoryDrafts = useMemo(
    () => promptHistoryEntriesToDrafts(projectPromptHistory),
    [projectPromptHistory],
  );
  const {
    selectedProviderId,
    setSelectedProviderId,
    providerOptions,
    hasMultipleProviders,
    selectedModel,
    setSelectedModel,
    serviceTier,
    setServiceTier,
    reasoningLevel,
    setReasoningLevel,
    permissionMode,
    setPermissionMode,
    environmentSelectionValue,
    setEnvironmentSelectionValue,
    clearReuseEnvironment,
    activeModel,
    modelOptions,
    reasoningOptions,
    permissionModeOptions,
    supportsPermissionModeSelection,
    supportsServiceTier,
    serviceTierSupportByProvider,
  } = useThreadCreationOptions({ scope: "new-thread", projectId });

  // Seed env picker from the sidebar "+" affordance's navigation state.
  // Reuse intent is purely transient — `setEnvironmentSelectionValue`
  // routes reuse values to session state inside the hook, never to
  // localStorage. We then clear location.state so a later refresh starts
  // from the user's host-mode default.
  useEffect(() => {
    const reuseEnvironmentId = readReuseEnvironmentIdFromLocationState(
      location.state,
    );
    if (reuseEnvironmentId === null) return;
    setEnvironmentSelectionValue(encodeReuseValue(reuseEnvironmentId));
    navigate(location.pathname + location.search, {
      replace: true,
      state: null,
    });
  }, [
    location.pathname,
    location.search,
    location.state,
    navigate,
    setEnvironmentSelectionValue,
  ]);

  // Worktree picker options come from the project's unarchived threads.
  // Threads on managed or unmanaged worktrees with a non-null environmentId
  // contribute; envs with only archived threads disappear naturally.
  const threadsQuery = useThreads(
    { projectId, archived: false },
    { enabled: Boolean(projectId) },
  );
  const reuseThreadOptions = useMemo(
    () => buildReuseThreadOptions(threadsQuery.data ?? []),
    [threadsQuery.data],
  );

  const currentProject = useMemo(
    () => projects?.find((p) => p.id === projectId),
    [projects, projectId],
  );
  const projectSources = useMemo(
    () => currentProject?.sources ?? [],
    [currentProject?.sources],
  );

  // The hook returns reuse values from session-only state and sanitizes any
  // legacy reuse entries out of localStorage, so we can take its value
  // verbatim and fall back to the local-host default only when nothing's
  // selected.
  const effectiveEnvironmentValue = useMemo(() => {
    if (
      environmentSelectionValue &&
      parseEnvironmentValue(environmentSelectionValue)
    ) {
      return environmentSelectionValue;
    }
    if (localHostId) {
      return `host:${localHostId}:local`;
    }
    return "";
  }, [environmentSelectionValue, localHostId]);
  const parsedEnvironment = useMemo(
    () => parseEnvironmentValue(effectiveEnvironmentValue),
    [effectiveEnvironmentValue],
  );
  const isHostMode = parsedEnvironment?.type === "host";
  const hostBranchesQuery = useProjectSourceBranches(
    projectId,
    isHostMode ? parsedEnvironment.hostId : null,
    { enabled: isHostMode },
  );
  const activeBranchesQuery = hostBranchesQuery;
  const branchOptions = useMemo(
    () => activeBranchesQuery.data?.branches ?? [],
    [activeBranchesQuery.data?.branches],
  );
  // The branch this env will use if the user doesn't override:
  //   - host:local      → the primary checkout's HEAD (`current`)
  //   - host:worktree   → the repo's default branch (the server's `default`
  //                       base-branch resolves to this)
  // For non-local environments, `current` is meaningless, so we prefer
  // `defaultBranch`.
  const isHostLocalMode = isHostMode && parsedEnvironment.mode === "local";
  const effectiveCurrentBranch = isHostLocalMode
    ? (activeBranchesQuery.data?.current ?? null)
    : (activeBranchesQuery.data?.defaultBranch ?? null);
  const {
    selectedBranch,
    onBranchChange: handleBranchChange,
    onCreateBranch: handleCreateBranch,
  } = useScopedBranchSelection({
    currentBranch: effectiveCurrentBranch,
    environmentValue: effectiveEnvironmentValue,
    projectId,
  });

  const selectedEnvironment = useMemo(
    () =>
      resolveProjectMainThreadEnvironment({
        environmentValue: effectiveEnvironmentValue,
        projectId,
        currentBranch: effectiveCurrentBranch,
        selectedBranch,
      }),
    [
      effectiveEnvironmentValue,
      projectId,
      effectiveCurrentBranch,
      selectedBranch,
    ],
  );

  const projectOptions = useMemo(() => {
    const knownOptions =
      projects?.map((project) => ({
        value: project.id,
        label: project.name,
      })) ?? [];

    if (
      projectId &&
      !knownOptions.some((option) => option.value === projectId)
    ) {
      knownOptions.unshift({
        value: projectId,
        label: projectsLoading ? "Loading project…" : projectId,
      });
    }

    return knownOptions;
  }, [projectId, projects, projectsLoading]);

  const selectedThreadModel = activeModel?.model ?? selectedModel;
  const handleProjectChange = useCallback(
    (nextProjectId: string) => {
      if (nextProjectId === projectId) return;
      navigate(`/projects/${nextProjectId}`);
    },
    [navigate, projectId],
  );

  const shouldFocusPrompt =
    typeof location.state === "object" &&
    location.state !== null &&
    "focusPrompt" in location.state &&
    location.state.focusPrompt === true;

  useEffect(() => {
    if (!shouldFocusPrompt) return;
    const handle = window.requestAnimationFrame(() => {
      const promptEl = document.getElementById("project-main-prompt");
      if (!(promptEl instanceof HTMLTextAreaElement)) return;
      promptEl.focus();
      const caretIndex = promptEl.value.length;
      promptEl.setSelectionRange(caretIndex, caretIndex);
    });
    return () => window.cancelAnimationFrame(handle);
  }, [location.key, shouldFocusPrompt]);

  const handleAttachFiles = useCallback(
    async (files: File[]) => {
      if (!projectId || files.length === 0) return;

      setAttachmentError(null);
      for (const file of files) {
        try {
          const uploaded = await uploadPromptAttachment.mutateAsync({
            projectId,
            file,
          });
          promptDraft.addAttachment(uploaded);
        } catch (err) {
          setAttachmentError(
            getMutationErrorMessage({
              error: err,
              fallbackMessage: "Attachment upload failed.",
            }),
          );
          break;
        }
      }
    },
    [projectId, promptDraft, uploadPromptAttachment],
  );

  const submitPrompt = useCallback(async () => {
    const submittedDraft = {
      text: promptDraft.text,
      attachments: promptDraft.attachments,
    };
    const submittedInput = promptDraftToInput(submittedDraft);
    if (
      submittedInput.length === 0 ||
      createThread.isPending ||
      !selectedEnvironment ||
      !selectedProviderId ||
      !selectedThreadModel ||
      !projectId
    ) {
      return;
    }

    setAttachmentError(null);

    try {
      await createThread.mutateAsync({
        input: submittedInput,
        projectId,
        providerId: selectedProviderId,
        model: selectedThreadModel,
        ...(supportsServiceTier && serviceTier ? { serviceTier } : {}),
        reasoningLevel,
        permissionMode,
        environment: selectedEnvironment,
      });
      promptDraft.clearIfCurrentMatches(submittedDraft);
    } catch {
      // Global mutation error handling already surfaced the failure.
    }
  }, [
    createThread,
    permissionMode,
    projectId,
    promptDraft,
    reasoningLevel,
    selectedEnvironment,
    selectedProviderId,
    selectedThreadModel,
    serviceTier,
    supportsServiceTier,
  ]);

  const isSubmitDisabled =
    createThread.isPending ||
    promptInput.length === 0 ||
    !selectedEnvironment ||
    !selectedProviderId ||
    !selectedThreadModel;

  const currentPromptDraft = useMemo(
    () => ({
      text: promptDraft.text,
      attachments: promptDraft.attachments,
    }),
    [promptDraft.attachments, promptDraft.text],
  );
  const historyConfig = useMemo(
    () => ({
      currentDraft: currentPromptDraft,
      entries: promptHistoryDrafts,
      onSelectEntry: promptDraft.setDraft,
      resetKey: projectId,
    }),
    [currentPromptDraft, projectId, promptDraft.setDraft, promptHistoryDrafts],
  );
  const mentionsConfig = useMemo(
    () => ({
      suggestions: promptMentions.suggestions,
      threadSectionMode: promptMentions.threadSectionMode,
      isLoading: promptMentions.isLoading,
      isError: promptMentions.isError,
      onQueryChange: promptMentions.setQuery,
    }),
    [
      promptMentions.isError,
      promptMentions.isLoading,
      promptMentions.setQuery,
      promptMentions.suggestions,
      promptMentions.threadSectionMode,
    ],
  );
  const attachmentsConfig = useMemo(
    () => ({
      items: promptDraft.attachments,
      projectId: projectId ?? "",
      onAttachFiles: handleAttachFiles,
      onRemove: promptDraft.removeAttachment,
      isAttaching: uploadPromptAttachment.isPending,
      error: attachmentError,
    }),
    [
      attachmentError,
      handleAttachFiles,
      projectId,
      promptDraft.attachments,
      promptDraft.removeAttachment,
      uploadPromptAttachment.isPending,
    ],
  );
  const executionConfig = useMemo(
    () => ({
      provider: {
        options: providerOptions,
        selectedId: selectedProviderId,
        onChange: setSelectedProviderId,
        hasMultiple: hasMultipleProviders,
      },
      model: {
        active: activeModel,
        selected: selectedModel,
        options: modelOptions,
        onChange: setSelectedModel,
      },
      serviceTier: {
        value: serviceTier,
        onChange: setServiceTier,
        supported: supportsServiceTier,
        supportByProvider: serviceTierSupportByProvider,
      },
      reasoning: {
        value: reasoningLevel,
        options: reasoningOptions,
        onChange: setReasoningLevel,
      },
    }),
    [
      activeModel,
      hasMultipleProviders,
      modelOptions,
      providerOptions,
      reasoningLevel,
      reasoningOptions,
      selectedModel,
      selectedProviderId,
      serviceTier,
      serviceTierSupportByProvider,
      setReasoningLevel,
      setSelectedModel,
      setSelectedProviderId,
      setServiceTier,
      supportsServiceTier,
    ],
  );
  const environmentConfig = useMemo(
    () => ({
      value: effectiveEnvironmentValue,
      onChange: setEnvironmentSelectionValue,
      sources: projectSources,
      reuseDisabled: reuseThreadOptions.length === 0,
    }),
    [
      effectiveEnvironmentValue,
      projectSources,
      reuseThreadOptions.length,
      setEnvironmentSelectionValue,
    ],
  );
  const worktreeConfig = useMemo(() => {
    const handleWorktreeChange = (environmentId: string) => {
      setEnvironmentSelectionValue(encodeReuseValue(environmentId));
    };
    return {
      options: reuseThreadOptions,
      value:
        parsedEnvironment?.type === "reuse"
          ? parsedEnvironment.environmentId
          : null,
      onChange: handleWorktreeChange,
    };
  }, [parsedEnvironment, reuseThreadOptions, setEnvironmentSelectionValue]);
  const branchConfig = useMemo(
    () => ({
      value: selectedBranch?.name ?? null,
      current: effectiveCurrentBranch,
      isNew: selectedBranch?.isNew ?? false,
      options: branchOptions,
      loading: activeBranchesQuery.isLoading,
      placeholder: "Default branch",
      onChange: handleBranchChange,
      onCreate: handleCreateBranch,
    }),
    [
      activeBranchesQuery.isLoading,
      branchOptions,
      effectiveCurrentBranch,
      handleBranchChange,
      handleCreateBranch,
      selectedBranch?.isNew,
      selectedBranch?.name,
    ],
  );
  const permissionConfig = useMemo(
    () => ({
      value: permissionMode,
      options: permissionModeOptions,
      onChange: setPermissionMode,
      supported: supportsPermissionModeSelection,
    }),
    [
      permissionMode,
      permissionModeOptions,
      setPermissionMode,
      supportsPermissionModeSelection,
    ],
  );

  const reuseHeader = useMemo(() => {
    if (parsedEnvironment?.type !== "reuse") return null;
    return (
      <div className="flex items-center gap-2 text-sm">
        <Icon name="GitBranch" className="size-4 shrink-0 text-primary" />
        <span className="flex min-w-0 items-center gap-1">
          <span className="font-medium text-foreground">
            Reusing existing worktree
          </span>
          <button
            type="button"
            onClick={clearReuseEnvironment}
            title="Stop reusing and start a regular new thread"
            aria-label="Stop reusing worktree"
            className="inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
          >
            <Icon name="X" className="size-3.5" />
          </button>
        </span>
      </div>
    );
  }, [clearReuseEnvironment, parsedEnvironment]);

  if (!projectId) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-muted-foreground">
          Select a project.
        </p>
      </PageShell>
    );
  }

  return (
    <PageShell contentClassName="pt-4 md:pt-5">
      <div className="space-y-1">
        <div className="flex items-center px-3.5">
          {projectId ? (
            <div className="flex items-center gap-3">
              <OptionPicker
                label="Project"
                value={projectId}
                options={projectOptions}
                onChange={handleProjectChange}
                className="h-8 text-sm"
              />
            </div>
          ) : null}
        </div>
        <NewThreadPromptBox
          id="project-main-prompt"
          value={prompt}
          onChange={promptDraft.setText}
          onSubmit={submitPrompt}
          isSubmitting={createThread.isPending}
          disabled={isSubmitDisabled}
          zenModeStorageKey={projectMainZenModeStorageKey}
          history={historyConfig}
          mentions={mentionsConfig}
          attachments={attachmentsConfig}
          execution={executionConfig}
          environment={environmentConfig}
          branch={branchConfig}
          worktree={worktreeConfig}
          permission={permissionConfig}
          header={reuseHeader}
        />
      </div>
    </PageShell>
  );
}
