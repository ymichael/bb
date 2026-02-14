import { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { PromptBox } from "@/components/promptbox/PromptBox";
import { PromptOptionPicker } from "@/components/promptbox/PromptOptionPicker";
import { TaskComposer } from "@/components/tasks/TaskComposer";
import { useCreateTask, useSpawnThread } from "@/hooks/useApi";
import { usePromptDraftStorage } from "@/hooks/usePromptDraftStorage";
import { usePromptFileMentions } from "@/hooks/usePromptFileMentions";
import { usePromptModelReasoning } from "@/hooks/usePromptModelReasoning";
import { cn } from "@/lib/utils";

type ComposerTab = "thread" | "tasks";

export function ProjectMainView() {
  const { projectId } = useParams<{ projectId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const spawnThread = useSpawnThread();
  const createTask = useCreateTask();
  const promptDraft = usePromptDraftStorage({ projectId, threadId: null });
  const fileMentions = usePromptFileMentions(projectId);
  const prompt = promptDraft.value;
  const [threadErrorMessage, setThreadErrorMessage] = useState<string | null>(null);
  const [taskErrorMessage, setTaskErrorMessage] = useState<string | null>(null);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [activeTab, setActiveTab] = useState<ComposerTab>("thread");
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

  useEffect(() => {
    if (shouldFocusTaskComposer) {
      setActiveTab("tasks");
      const handle = window.requestAnimationFrame(() => {
        const titleElement = document.getElementById("project-main-task-title");
        if (!(titleElement instanceof HTMLInputElement)) return;
        titleElement.focus();
        const caretIndex = titleElement.value.length;
        titleElement.setSelectionRange(caretIndex, caretIndex);
      });

      return () => window.cancelAnimationFrame(handle);
    }

    if (!shouldFocusPrompt) return;
    setActiveTab("thread");
    const handle = window.requestAnimationFrame(() => {
      const promptElement = document.getElementById("project-main-prompt");
      if (!(promptElement instanceof HTMLTextAreaElement)) return;
      promptElement.focus();
      const caretIndex = promptElement.value.length;
      promptElement.setSelectionRange(caretIndex, caretIndex);
    });

    return () => window.cancelAnimationFrame(handle);
  }, [location.key, shouldFocusPrompt, shouldFocusTaskComposer]);

  if (!projectId) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        Select a project.
      </p>
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
      });
      setTaskTitle("");
      setTaskDescription("");
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
    <div className="mx-auto flex min-h-0 w-full max-w-[760px] flex-1 items-start pt-8 md:pt-10">
      <div className="w-full space-y-4">
        <div className="flex justify-center">
          <div className="inline-flex overflow-hidden rounded-lg border border-border/70 bg-muted/30">
            <button
              type="button"
              onClick={() => setActiveTab("thread")}
              className={cn(
                "rounded-l-md border-r border-border/60 px-3 py-1.5 text-sm transition-colors",
                activeTab === "thread"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Thread
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("tasks")}
              className={cn(
                "rounded-r-md px-3 py-1.5 text-sm transition-colors",
                activeTab === "tasks"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Task
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
                setTaskTitle(value);
                if (taskErrorMessage) setTaskErrorMessage(null);
              }}
              onDescriptionChange={setTaskDescription}
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
    </div>
  );
}
