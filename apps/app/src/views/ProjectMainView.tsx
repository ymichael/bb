import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderGit2, Laptop } from "lucide-react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { buildThreadOperationInstruction } from "@beanbag/agent-core";
import { PromptBox } from "@/components/promptbox/PromptBox";
import { PromptOptionPicker } from "@/components/promptbox/PromptOptionPicker";
import { PageShell } from "@/components/layout/PageShell";
import { type StatusPillVariant } from "@/components/shared/StatusPill";
import { StatusPillCommitPopover } from "@/components/shared/StatusPillCommitPopover";
import {
  useProjectWorkspaceStatus,
  useProjects,
  useSpawnThread,
  useUploadPromptAttachment,
} from "@/hooks/useApi";
import { usePromptDraftStorage } from "@/hooks/usePromptDraftStorage";
import { usePromptFileMentions } from "@/hooks/usePromptFileMentions";
import { usePromptModelReasoning } from "@/hooks/usePromptModelReasoning";
import { getProjectScopedStorageKey } from "@/lib/project-scoped-storage";
import { promptDraftToInput } from "@/lib/prompt-draft";
import { formatDirtyWorkspaceLabel } from "@/lib/workspace-change-summary";

const PROJECT_MAIN_ZEN_MODE_STORAGE_KEY = "bb.promptbox.zen-mode.project-main";

export function ProjectMainView() {
  const { projectId } = useParams<{ projectId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { data: projects, isLoading: projectsLoading } = useProjects();
  const { data: workspaceStatus, isLoading: threadsLoading } = useProjectWorkspaceStatus(projectId);
  const spawnThread = useSpawnThread();
  const spawnCommitThread = useSpawnThread();
  const uploadPromptAttachment = useUploadPromptAttachment();
  const promptDraft = usePromptDraftStorage({ projectId, threadId: null });
  const fileMentions = usePromptFileMentions(projectId);
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
    selectedModel,
    setSelectedModel,
    reasoningLevel,
    setReasoningLevel,
    sandboxMode,
    setSandboxMode,
    environmentId,
    setEnvironmentId,
    activeModel,
    modelOptions,
    reasoningOptions,
    sandboxOptions,
    environmentOptions,
  } = usePromptModelReasoning({ scope: "new-thread", projectId });
  const environmentSelectorOptions = useMemo(
    () =>
      environmentOptions.map((option) => {
        switch (option.value) {
          case "local":
            return { ...option, label: "Local", icon: Laptop };
          case "worktree":
            return { ...option, label: "New worktree", icon: FolderGit2 };
          default:
            // Intentionally preserve unknown environment IDs surfaced by the daemon.
            return option;
        }
      }),
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
  const projectWorkspaceStatus = useMemo<{
    label: string;
    variant: StatusPillVariant;
    actionable: boolean;
  }>(() => {
    if (workspaceStatus?.hasUncommittedChanges) {
      return {
        label: formatDirtyWorkspaceLabel(workspaceStatus),
        variant: "secondary",
        actionable: true,
      };
    }

    if (workspaceStatus?.hasCommittedUnmergedChanges) {
      const branch = workspaceStatus.currentBranch;
      return {
        label: branch ? `Ahead (${branch})` : "Ahead",
        variant: "outline",
        actionable: false,
      };
    }

    return {
      label: "Clean",
      variant: "outline",
      actionable: false,
    };
  }, [workspaceStatus]);
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
    if (promptInput.length === 0 || spawnThread.isPending) return;

    try {
      await spawnThread.mutateAsync({
        input: promptInput,
        projectId,
        model: activeModel?.model,
        reasoningLevel,
        sandboxMode,
        environmentId,
      });
      promptDraft.clear();
      setAttachmentError(null);
    } catch {
      // Error state is surfaced in mutation status and can be shown by callers if needed.
    }
  };

  const isSubmitDisabled = spawnThread.isPending || promptInput.length === 0;

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
          isSubmitting={spawnThread.isPending}
          submitDisabled={isSubmitDisabled}
          submitTitle={spawnThread.isPending ? "Submitting..." : "Submit (Enter)"}
          mentionSuggestions={fileMentions.suggestions}
          mentionLoading={fileMentions.isLoading}
          mentionError={fileMentions.isError}
          onMentionQueryChange={fileMentions.setQuery}
          attachments={promptDraft.attachments}
          attachmentProjectId={projectId}
          onAttachFiles={handleAttachFiles}
          onRemoveAttachment={promptDraft.removeAttachment}
          isAttaching={uploadPromptAttachment.isPending}
          attachmentError={attachmentError}
          footerStart={
            <>
              <PromptOptionPicker
                label="Model"
                value={activeModel?.model ?? selectedModel}
                options={modelOptions}
                onChange={setSelectedModel}
              />
              <PromptOptionPicker
                label="Reasoning"
                value={reasoningLevel}
                options={reasoningOptions}
                onChange={setReasoningLevel}
              />
              <PromptOptionPicker
                label="Sandbox"
                value={sandboxMode}
                options={sandboxOptions}
                onChange={setSandboxMode}
              />
            </>
          }
        />
        <div className="flex items-center px-3.5">
          <div className="flex items-center gap-2">
            <PromptOptionPicker
              label="Environment"
              value={environmentId}
              options={environmentSelectorOptions}
              onChange={setEnvironmentId}
            />
            {!threadsLoading && environmentId === "local" ? (
              <div className="flex items-center">
                <StatusPillCommitPopover
                  status={workspaceStatus}
                  label={projectWorkspaceStatus.label}
                  variant={projectWorkspaceStatus.variant}
                  canCommit={Boolean(workspaceStatus?.hasUncommittedChanges)}
                  isCommitting={spawnCommitThread.isPending}
                  onCommit={async ({ includeUnstaged, message }) => {
                    if (!projectId) return;
                    const operationPrompt = buildThreadOperationInstruction(
                      {
                        operation: "commit",
                        options: {
                          includeUnstaged,
                          ...(message ? { message } : {}),
                        },
                      },
                      { target: "project_main" },
                    );
                    const thread = await spawnCommitThread.mutateAsync({
                      projectId,
                      input: [{ type: "text", text: operationPrompt }],
                      model: activeModel?.model,
                      reasoningLevel,
                      sandboxMode,
                      environmentId: "local",
                      title: "Commit workspace changes",
                    });
                    navigate(`/projects/${projectId}/threads/${thread.id}`);
                  }}
                />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </PageShell>
  );
}
