import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { NewThreadPromptBox } from "@/components/promptbox/NewThreadPromptBox";
import { parseEnvironmentValue } from "@/components/pickers/environment-picker-value";
import { OptionPicker } from "@/components/pickers/OptionPicker";
import { PageShell } from "@/components/ui/page-shell.js";
import { useUploadPromptAttachment } from "@/hooks/mutations/project-mutations";
import { useCreateThread } from "@/hooks/mutations/thread-runtime-mutations";
import {
  useProjectPromptHistory,
  useProjectSourceBranches,
  useProjects,
  useSidebarBootstrap,
} from "@/hooks/queries/project-queries";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { usePromptDraftStorage } from "@/hooks/usePromptDraftStorage";
import { usePromptMentions } from "@/hooks/usePromptMentions";
import { useThreadCreationOptions } from "@/hooks/useThreadCreationOptions";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { promptHistoryEntriesToDrafts } from "@/lib/prompt-history";
import { getProjectScopedStorageKey } from "@/lib/project-scoped-storage";
import { promptDraftToInput } from "@/lib/prompt-draft";
import { resolveProjectMainThreadEnvironment } from "./project-main-thread-environment";
import { useScopedBranchSelection } from "./project-main-branch-selection";

const PROJECT_MAIN_ZEN_MODE_STORAGE_KEY = "bb.promptbox.zen-mode.project-main";

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
    activeModel,
    modelOptions,
    reasoningOptions,
    permissionModeOptions,
    supportsPermissionModeSelection,
    supportsServiceTier,
    serviceTierSupportByProvider,
  } = useThreadCreationOptions({ scope: "new-thread", projectId });

  const currentProject = useMemo(
    () => projects?.find((p) => p.id === projectId),
    [projects, projectId],
  );
  const projectSources = useMemo(
    () => currentProject?.sources ?? [],
    [currentProject?.sources],
  );

  // Fall back to local host direct if no value is stored yet
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
      isLoading: promptMentions.isLoading,
      isError: promptMentions.isError,
      onQueryChange: promptMentions.setQuery,
    }),
    [
      promptMentions.isError,
      promptMentions.isLoading,
      promptMentions.setQuery,
      promptMentions.suggestions,
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
    }),
    [effectiveEnvironmentValue, projectSources, setEnvironmentSelectionValue],
  );
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
          permission={permissionConfig}
        />
      </div>
    </PageShell>
  );
}
