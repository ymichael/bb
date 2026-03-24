import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { PromptBox } from "@/components/promptbox/PromptBox";
import { PromptExecutionControls } from "@/components/promptbox/PromptExecutionControls";
import { PromptOptionPicker } from "@/components/promptbox/PromptOptionPicker";
import { PageShell } from "@/components/layout/PageShell";
import {
  useProjects,
  useCreateThread,
  useUploadPromptAttachment,
} from "@/hooks/useApi";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { usePromptDraftStorage } from "@/hooks/usePromptDraftStorage";
import { usePromptMentions } from "@/hooks/usePromptMentions";
import { usePromptModelReasoning } from "@/hooks/usePromptModelReasoning";
import { getProjectScopedStorageKey } from "@/lib/project-scoped-storage";
import { promptDraftToInput } from "@/lib/prompt-draft";

const PROJECT_MAIN_ZEN_MODE_STORAGE_KEY = "bb.promptbox.zen-mode.project-main";

export function ProjectMainView() {
  const { projectId } = useParams<{ projectId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { data: projects, isLoading: projectsLoading } = useProjects();
  const createThread = useCreateThread();
  const { localHostId, hasDaemon } = useHostDaemon();
  const uploadPromptAttachment = useUploadPromptAttachment();
  const promptDraft = usePromptDraftStorage({ projectId, threadId: null });
  const promptMentions = usePromptMentions(projectId);
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
    () => getProjectScopedStorageKey(PROJECT_MAIN_ZEN_MODE_STORAGE_KEY, projectId),
    [projectId],
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
    sandboxMode,
    setSandboxMode,
    environmentSelectionValue,
    setEnvironmentSelectionValue,
    activeModel,
    modelOptions,
    reasoningOptions,
    sandboxOptions,
    environmentOptions,
    supportsServiceTier,
  } = usePromptModelReasoning({ scope: "new-thread", projectId });
  const environmentSelectorOptions = useMemo(
    () => environmentOptions.map((option) => ({
      ...option,
    })),
    [environmentOptions],
  );
  const projectOptions = useMemo(() => {
    const knownOptions =
      projects?.map((project) => ({
        value: project.id,
        label: project.name,
      })) ?? [];

    if (projectId && !knownOptions.some((option) => option.value === projectId)) {
      knownOptions.unshift({
        value: projectId,
        label: projectsLoading ? "Loading project…" : projectId,
      });
    }

    return knownOptions;
  }, [projectId, projects, projectsLoading]);
  const selectedProject = useMemo(
    () => projects?.find((project) => project.id === projectId),
    [projectId, projects],
  );
  const selectedEnvironmentRequest = useMemo((): {
    hostId?: string;
    provisionerId?: "worktree" | "e2b";
    environmentId?: string;
  } => {
    if (!projectId) {
      return {};
    }
    if (!environmentSelectionValue || environmentSelectionValue === "local") {
      return localHostId ? { hostId: localHostId } : {};
    }
    if (environmentSelectionValue === "worktree") {
      return localHostId
        ? { hostId: localHostId, provisionerId: "worktree" }
        : {};
    }
    return {
      environmentId: environmentSelectionValue,
    };
  }, [environmentSelectionValue, localHostId, projectId]);
  const handleProjectChange = useCallback((nextProjectId: string) => {
    if (nextProjectId === projectId) return;
    navigate(`/projects/${nextProjectId}`);
  }, [navigate, projectId]);

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

  const handleAttachFiles = useCallback(async (files: File[]) => {
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
        setAttachmentError(err instanceof Error ? err.message : "Attachment upload failed");
        break;
      }
    }
  }, [projectId, promptDraft, uploadPromptAttachment]);

  if (!projectId) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-muted-foreground">
          Select a project.
        </p>
      </PageShell>
    );
  }

  const submitPrompt = async () => {
    const submittedDraft = {
      text: promptDraft.text,
      attachments: promptDraft.attachments,
    };
    const submittedInput = promptDraftToInput(submittedDraft);
    if (submittedInput.length === 0 || createThread.isPending) return;

    // Match thread follow-up behavior: clear immediately, then restore only if the
    // request fails and the user has not started a new draft in the meantime.
    promptDraft.clear();
    setAttachmentError(null);

    try {
      await createThread.mutateAsync({
        input: submittedInput,
        projectId,
        providerId: selectedProviderId ?? "",
        model: activeModel?.model,
        ...(supportsServiceTier && serviceTier ? { serviceTier } : {}),
        reasoningLevel,
        sandboxMode,
        ...selectedEnvironmentRequest,
      });
    } catch {
      promptDraft.restoreIfEmpty(submittedDraft);
      // Error state is surfaced in mutation status and can be shown by callers if needed.
    }
  };

  const isSubmitDisabled = createThread.isPending || promptInput.length === 0;

  return (
    <PageShell contentClassName="pt-8 md:pt-10">
      <div className="space-y-1">
        <div className="flex items-center px-3.5">
          {projectId ? (
            <div className="flex items-center gap-3">
              <PromptOptionPicker
                label="Project"
                value={projectId}
                options={projectOptions}
                onChange={handleProjectChange}
                className="h-8 px-0 text-sm text-foreground/90 hover:text-foreground"
              />
            </div>
          ) : null}
        </div>
        <PromptBox
          id="project-main-prompt"
          value={prompt}
          onChange={promptDraft.setText}
          onSubmit={submitPrompt}
          zenModeLayout="project-main"
          zenModeStorageKey={projectMainZenModeStorageKey}
          isSubmitting={createThread.isPending}
          submitDisabled={isSubmitDisabled}
          submitTitle={createThread.isPending ? "Submitting..." : "Submit (Enter)"}
          mentionSuggestions={promptMentions.suggestions}
          mentionLoading={promptMentions.isLoading}
          mentionError={promptMentions.isError}
          onMentionQueryChange={promptMentions.setQuery}
          attachments={promptDraft.attachments}
          attachmentProjectId={projectId}
          onAttachFiles={handleAttachFiles}
          onRemoveAttachment={promptDraft.removeAttachment}
          isAttaching={uploadPromptAttachment.isPending}
          attachmentError={attachmentError}
          footerStart={
            <PromptExecutionControls
              providerOptions={providerOptions}
              selectedProviderId={selectedProviderId}
              onSelectedProviderChange={setSelectedProviderId}
              hasMultipleProviders={hasMultipleProviders}
              activeModel={activeModel}
              selectedModel={selectedModel}
              modelOptions={modelOptions}
              onSelectedModelChange={setSelectedModel}
              serviceTier={serviceTier}
              onServiceTierChange={setServiceTier}
              supportsServiceTier={supportsServiceTier}
              reasoningLevel={reasoningLevel}
              reasoningOptions={reasoningOptions}
              onReasoningLevelChange={setReasoningLevel}
              sandboxMode={sandboxMode}
              sandboxOptions={sandboxOptions}
              onSandboxModeChange={setSandboxMode}
            />
          }
        />
        <div className="flex items-center px-3.5">
          <div className="flex flex-wrap items-center gap-2">
            {environmentSelectorOptions.length > 0 ? (
              <PromptOptionPicker
                label="Environment"
                value={environmentSelectionValue}
                options={environmentSelectorOptions}
                onChange={setEnvironmentSelectionValue}
              />
            ) : null}
          </div>
        </div>
      </div>
    </PageShell>
  );
}
