import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { PromptBox } from "@/components/promptbox/PromptBox";
import { PromptOptionPicker } from "@/components/promptbox/PromptOptionPicker";
import { TaskComposer } from "@/components/tasks/TaskComposer";
import { PageShell } from "@/components/layout/PageShell";
import { useCreateTask, useSpawnThread } from "@/hooks/useApi";
import { usePromptDraftStorage } from "@/hooks/usePromptDraftStorage";
import { usePromptFileMentions } from "@/hooks/usePromptFileMentions";
import { usePromptModelReasoning } from "@/hooks/usePromptModelReasoning";
import { useTaskDraftStorage } from "@/hooks/useTaskDraftStorage";
import { cn } from "@/lib/utils";

type ComposerTab = "thread" | "tasks";
const DEFAULT_TASK_ASSIGNEE = "agent/generic";
const TASK_ASSIGNEE_STORAGE_KEY = "beanbag.taskcomposer.assignee";

function getStoredTaskAssignee(): string {
  if (typeof window === "undefined") return DEFAULT_TASK_ASSIGNEE;
  const storedAssignee = window.localStorage.getItem(TASK_ASSIGNEE_STORAGE_KEY);
  return storedAssignee && storedAssignee.trim().length > 0
    ? storedAssignee
    : DEFAULT_TASK_ASSIGNEE;
}

export function ProjectMainView() {
  const { projectId } = useParams<{ projectId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const spawnThread = useSpawnThread();
  const createTask = useCreateTask();
  const promptDraft = usePromptDraftStorage({ projectId, threadId: null });
  const taskDraft = useTaskDraftStorage({ projectId });
  const fileMentions = usePromptFileMentions(projectId);
  const prompt = promptDraft.value;
  const taskTitle = taskDraft.title;
  const taskDescription = taskDraft.description;
  const [threadErrorMessage, setThreadErrorMessage] = useState<string | null>(null);
  const [taskErrorMessage, setTaskErrorMessage] = useState<string | null>(null);
  const [taskAssignee, setTaskAssignee] = useState(() => getStoredTaskAssignee());
  const [activeTab, setActiveTab] = useState<ComposerTab>("tasks");
  const {
    selectedModel,
    setSelectedModel,
    reasoningLevel,
    setReasoningLevel,
    sandboxMode,
    setSandboxMode,
    activeModel,
    modelOptions,
    reasoningOptions,
    sandboxOptions,
  } = usePromptModelReasoning({ scope: "new-thread" });

  const shouldFocusPrompt =
    typeof location.state === "object" &&
    location.state !== null &&
    "focusPrompt" in location.state &&
    location.state.focusPrompt === true;
  const shouldFocusTaskComposer =
    typeof location.state === "object" &&
    location.state !== null &&
    "focusTaskComposer" in location.state &&
    location.state.focusTaskComposer === true;

  const focusComposerById = useCallback((elementId: string) => {
    const handle = window.requestAnimationFrame(() => {
      const composerElement = document.getElementById(elementId);
      if (!(composerElement instanceof HTMLTextAreaElement)) return;
      composerElement.focus();
      const caretIndex = composerElement.value.length;
      composerElement.setSelectionRange(caretIndex, caretIndex);
    });

    return () => window.cancelAnimationFrame(handle);
  }, []);

  const handleTabChange = (nextTab: ComposerTab) => {
    setActiveTab(nextTab);
    focusComposerById(
      nextTab === "thread" ? "project-main-prompt" : "project-main-task-title",
    );
  };

  useEffect(() => {
    if (shouldFocusTaskComposer) {
      setActiveTab("tasks");
      return focusComposerById("project-main-task-title");
    }

    if (!shouldFocusPrompt) return;
    setActiveTab("thread");
    return focusComposerById("project-main-prompt");
  }, [location.key, shouldFocusPrompt, shouldFocusTaskComposer, focusComposerById]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const nextAssignee = taskAssignee.trim();
    if (nextAssignee.length === 0) {
      window.localStorage.removeItem(TASK_ASSIGNEE_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(TASK_ASSIGNEE_STORAGE_KEY, nextAssignee);
  }, [taskAssignee]);

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
    const trimmed = prompt.trim();
    if (!trimmed || spawnThread.isPending) return;

    setThreadErrorMessage(null);
    try {
      await spawnThread.mutateAsync({
        input: [{ type: "text", text: trimmed }],
        projectId,
        model: activeModel?.model,
        reasoningLevel,
        sandboxMode,
      });
      promptDraft.clear();
    } catch (error) {
      setThreadErrorMessage(
        error instanceof Error ? error.message : "Unable to send prompt.",
      );
    }
  };

  const submitTask = async () => {
    if (!projectId) return;
    const trimmedTitle = taskTitle.trim();
    if (!trimmedTitle || createTask.isPending) return;

    setTaskErrorMessage(null);
    try {
      const task = await createTask.mutateAsync({
        projectId,
        title: trimmedTitle,
        description: taskDescription.trim() || undefined,
        assignee: taskAssignee.trim().length > 0 ? taskAssignee : undefined,
      });
      taskDraft.clear();
      navigate(`/projects/${projectId}/tasks/${task.id}`);
    } catch (error) {
      setTaskErrorMessage(
        error instanceof Error ? error.message : "Unable to create task.",
      );
    }
  };

  const isSubmitDisabled = spawnThread.isPending || prompt.trim().length === 0;
  const isTaskSubmitDisabled =
    createTask.isPending || taskTitle.trim().length === 0;

  return (
    <PageShell contentClassName="pt-8 md:pt-10">
      <div className="w-full space-y-4">
        <div className="flex justify-center">
          <div className="inline-flex overflow-hidden rounded-lg border border-border/70 bg-muted/30">
            <button
              type="button"
              onClick={() => handleTabChange("tasks")}
              className={cn(
                "rounded-l-md border-r border-border/60 px-3 py-1.5 text-sm transition-colors",
                activeTab === "tasks"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Task
            </button>
            <button
              type="button"
              onClick={() => handleTabChange("thread")}
              className={cn(
                "rounded-r-md px-3 py-1.5 text-sm transition-colors",
                activeTab === "thread"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Thread
            </button>
          </div>
        </div>

        <div className="grid">
          <div
            aria-hidden={activeTab !== "thread"}
            className={cn(
              "col-start-1 row-start-1 transition-opacity duration-150",
              activeTab === "thread"
                ? "visible opacity-100"
                : "pointer-events-none invisible opacity-0"
            )}
          >
            <PromptBox
              id="project-main-prompt"
              value={prompt}
              onChange={(value) => {
                promptDraft.setValue(value);
                if (threadErrorMessage) setThreadErrorMessage(null);
              }}
              onSubmit={submitPrompt}
              isSubmitting={spawnThread.isPending}
              submitDisabled={isSubmitDisabled}
              submitTitle={spawnThread.isPending ? "Submitting..." : "Submit (Enter)"}
              mentionSuggestions={fileMentions.suggestions}
              mentionLoading={fileMentions.isLoading}
              mentionError={fileMentions.isError}
              onMentionQueryChange={fileMentions.setQuery}
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
          </div>
          <div
            aria-hidden={activeTab !== "tasks"}
            className={cn(
              "col-start-1 row-start-1 transition-opacity duration-150",
              activeTab === "tasks"
                ? "visible opacity-100"
                : "pointer-events-none invisible opacity-0"
            )}
          >
            <TaskComposer
              titleInputId="project-main-task-title"
              title={taskTitle}
              description={taskDescription}
              onTitleChange={(value) => {
                taskDraft.setTitle(value);
                if (taskErrorMessage) setTaskErrorMessage(null);
              }}
              onDescriptionChange={taskDraft.setDescription}
              assignee={taskAssignee}
              onAssigneeChange={(nextAssignee) => {
                setTaskAssignee(nextAssignee);
                if (taskErrorMessage) setTaskErrorMessage(null);
              }}
              onSubmit={submitTask}
              isSubmitting={createTask.isPending}
              submitDisabled={isTaskSubmitDisabled}
              submitTitle={createTask.isPending ? "Creating..." : "Create task (Enter)"}
              autoFocusTitle={shouldFocusTaskComposer}
            />
          </div>
        </div>
        <div className="min-h-5">
          {activeTab === "thread" && threadErrorMessage ? (
            <p className="pt-1 text-sm text-destructive">{threadErrorMessage}</p>
          ) : null}
          {activeTab === "tasks" && taskErrorMessage ? (
            <p className="pt-1 text-sm text-destructive">{taskErrorMessage}</p>
          ) : null}
        </div>
      </div>
    </PageShell>
  );
}
