import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { NewThreadPromptBox } from "@/components/promptbox/NewThreadPromptBox";
import { parseEnvironmentValue } from "@/components/pickers/EnvironmentPicker";
import { OptionPicker } from "@/components/pickers/OptionPicker";
import { PageShell } from "@/components/ui";
import { useUploadPromptAttachment } from "@/hooks/mutations/project-mutations";
import { useCreateThread } from "@/hooks/mutations/thread-runtime-mutations";
import {
  useProjectPromptHistory,
  useProjects,
} from "@/hooks/queries/project-queries";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { usePromptDraftStorage } from "@/hooks/usePromptDraftStorage";
import { usePromptMentions } from "@/hooks/usePromptMentions";
import { useThreadCreationOptions } from "@/hooks/useThreadCreationOptions";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { promptHistoryEntriesToDrafts } from "@/lib/prompt-history";
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
  const { data: projectPromptHistory = [] } =
    useProjectPromptHistory(projectId);
  const promptMentions = usePromptMentions(projectId, { environmentId: null });
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<{
    name: string;
    isNew: boolean;
  }>({ name: "main", isNew: false });
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
  const projectSources = currentProject?.sources ?? [];

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

  const selectedEnvironment = useMemo(():
    | CreateThreadRequest["environment"]
    | null => {
    if (!projectId) return null;
    const parsed = parseEnvironmentValue(effectiveEnvironmentValue);
    if (!parsed) return null;

    if (parsed.type === "host") {
      if (parsed.mode === "worktree") {
        return {
          type: "host",
          hostId: parsed.hostId,
          workspace: {
            type: "managed-worktree",
            baseBranch: { kind: "named", name: selectedBranch.name },
          },
        };
      }
      return {
        type: "host",
        hostId: parsed.hostId,
        workspace: {
          type: "unmanaged",
          path: null,
          branch: selectedBranch.isNew
            ? { kind: "new" }
            : { kind: "existing", name: selectedBranch.name },
        },
      };
    }

    if (parsed.type === "sandbox") {
      return {
        type: "sandbox-host",
        sandboxType: parsed.backendId,
        baseBranch: { kind: "named", name: selectedBranch.name },
      };
    }

    return null;
  }, [
    effectiveEnvironmentValue,
    projectId,
    selectedBranch.name,
    selectedBranch.isNew,
  ]);

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
  };

  const isSubmitDisabled =
    createThread.isPending ||
    promptInput.length === 0 ||
    !selectedEnvironment ||
    !selectedProviderId ||
    !selectedThreadModel;

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
                className="h-8 px-0 text-sm"
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
          history={{
            currentDraft: {
              text: promptDraft.text,
              attachments: promptDraft.attachments,
            },
            entries: promptHistoryDrafts,
            onSelectEntry: promptDraft.setDraft,
            resetKey: projectId,
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
          execution={{
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
          }}
          environment={{
            value: effectiveEnvironmentValue,
            onChange: setEnvironmentSelectionValue,
            projectId,
            sources: projectSources,
          }}
          branch={{
            value: selectedBranch.name,
            isNew: selectedBranch.isNew,
            onChange: (name) => setSelectedBranch({ name, isNew: false }),
            onCreate: () =>
              setSelectedBranch((prev) => ({ name: prev.name, isNew: true })),
          }}
          permission={{
            value: permissionMode,
            options: permissionModeOptions,
            onChange: setPermissionMode,
            supported: supportsPermissionModeSelection,
          }}
        />
      </div>
    </PageShell>
  );
}
