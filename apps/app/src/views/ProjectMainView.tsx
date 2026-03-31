import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { PromptBox } from "@/components/promptbox/PromptBox";
import { PromptExecutionControls } from "@/components/promptbox/PromptExecutionControls";
import { PromptOptionPicker } from "@/components/promptbox/PromptOptionPicker";
import { PageShell } from "@/components/layout/PageShell";
import { useUploadPromptAttachment } from "@/hooks/mutations/project-mutations";
import { useCreateThread } from "@/hooks/mutations/thread-mutations";
import { useProjects } from "@/hooks/queries/project-queries";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { usePromptDraftStorage } from "@/hooks/usePromptDraftStorage";
import { usePromptMentions } from "@/hooks/usePromptMentions";
import { useThreadCreationOptions } from "@/hooks/useThreadCreationOptions";
import { getProjectScopedStorageKey } from "@/lib/project-scoped-storage";
import { promptDraftToInput } from "@/lib/prompt-draft";
import type { CreateThreadRequest } from "@bb/server-contract";

const PROJECT_MAIN_ZEN_MODE_STORAGE_KEY = "bb.promptbox.zen-mode.project-main";

export function ProjectMainView() {
  const { projectId } = useParams<{ projectId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { data: projects, isLoading: projectsLoading } = useProjects();
  const createThread = useCreateThread();
  const { localHostId } = useHostDaemon();
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
  } = useThreadCreationOptions({ scope: "new-thread", projectId });
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
  const selectedEnvironment = useMemo((): CreateThreadRequest["environment"] | null => {
    if (!projectId || !localHostId) {
      return null;
    }
    if (environmentSelectionValue === "worktree") {
      return {
        type: "host",
        hostId: localHostId,
        workspace: { type: "managed-worktree" },
      };
    }
    // Default: unmanaged workspace on local host (project source path)
    return {
      type: "host",
      hostId: localHostId,
      workspace: { type: "unmanaged", path: null },
    };
  }, [environmentSelectionValue, localHostId, projectId]);
  const selectedThreadModel = activeModel?.model ?? selectedModel;
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
    if (
      submittedInput.length === 0 ||
      createThread.isPending ||
      !selectedEnvironment ||
      !selectedProviderId ||
      !selectedThreadModel
    ) {
      return;
    }

    // Match thread follow-up behavior: clear immediately, then restore only if the
    // request fails and the user has not started a new draft in the meantime.
    promptDraft.clear();
    setAttachmentError(null);

    try {
      await createThread.mutateAsync({
        input: submittedInput,
        projectId,
        providerId: selectedProviderId,
        model: selectedThreadModel,
        ...(supportsServiceTier && serviceTier ? { serviceTier } : {}),
        reasoningLevel,
        sandboxMode,
        environment: selectedEnvironment,
      });
    } catch {
      promptDraft.restoreIfEmpty(submittedDraft);
      // Error state is surfaced in mutation status and can be shown by callers if needed.
    }
  };

  const isSubmitDisabled =
    createThread.isPending ||
    promptInput.length === 0 ||
    !selectedEnvironment ||
    !selectedProviderId ||
    !selectedThreadModel;

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
          submission={{
            isSubmitting: createThread.isPending,
            disabled: isSubmitDisabled,
            title: createThread.isPending ? "Submitting..." : "Submit (Enter)",
          }}
          mentions={{
            suggestions: promptMentions.suggestions,
            isLoading: promptMentions.isLoading,
            isError: promptMentions.isError,
            onQueryChange: promptMentions.setQuery,
          }}
          attachments={{
            items: promptDraft.attachments,
            projectId,
            onAttachFiles: handleAttachFiles,
            onRemove: promptDraft.removeAttachment,
            isAttaching: uploadPromptAttachment.isPending,
            error: attachmentError,
          }}
          zenMode={{
            layout: "project-main",
            storageKey: projectMainZenModeStorageKey,
          }}
          footerStart={
            <PromptExecutionControls
              provider={{
                options: providerOptions,
                selectedId: selectedProviderId,
                onChange: setSelectedProviderId,
                hasMultiple: hasMultipleProviders,
              }}
              model={{
                active: activeModel,
                selected: selectedModel,
                options: modelOptions,
                onChange: setSelectedModel,
              }}
              serviceTier={{
                value: serviceTier,
                onChange: setServiceTier,
                supported: supportsServiceTier,
              }}
              reasoning={{
                value: reasoningLevel,
                options: reasoningOptions,
                onChange: setReasoningLevel,
              }}
              sandbox={{
                value: sandboxMode,
                options: sandboxOptions,
                onChange: setSandboxMode,
              }}
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
