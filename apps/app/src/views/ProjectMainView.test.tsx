// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptDraftState } from "@/lib/prompt-draft";
import { ProjectMainView } from "./ProjectMainView";

const useProjectsMock = vi.fn();
const useHostDaemonMock = vi.fn();
const usePromptDraftStorageMock = vi.fn();
const usePromptMentionsMock = vi.fn();
const useThreadCreationOptionsMock = vi.fn();
const useCreateThreadMock = vi.fn();
const useUploadPromptAttachmentMock = vi.fn();

vi.mock("@/hooks/queries/project-queries", () => ({
  useProjects: () => useProjectsMock(),
}));

vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: () => useHostDaemonMock(),
}));

vi.mock("@/hooks/usePromptDraftStorage", () => ({
  usePromptDraftStorage: () => usePromptDraftStorageMock(),
}));

vi.mock("@/hooks/usePromptMentions", () => ({
  usePromptMentions: () => usePromptMentionsMock(),
}));

vi.mock("@/hooks/useThreadCreationOptions", () => ({
  useThreadCreationOptions: () => useThreadCreationOptionsMock(),
}));

vi.mock("@/hooks/mutations/thread-runtime-mutations", () => ({
  useCreateThread: () => useCreateThreadMock(),
}));

vi.mock("@/hooks/mutations/project-mutations", () => ({
  useUploadPromptAttachment: () => useUploadPromptAttachmentMock(),
}));

vi.mock("@/components/layout/PageShell", () => ({
  PageShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/promptbox/PromptBox", () => ({
  PromptBox: ({
    onSubmit,
    submission,
    value,
  }: {
    onSubmit: () => void;
    submission?: { disabled?: boolean };
    value: string;
  }) => (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <textarea aria-label="Prompt" readOnly value={value} />
      <button disabled={submission?.disabled} type="submit">Submit</button>
    </form>
  ),
}));

vi.mock("@/components/promptbox/PromptExecutionControls", () => ({
  PromptExecutionControls: () => null,
}));

vi.mock("@/components/promptbox/PromptOptionPicker", () => ({
  PromptOptionPicker: () => null,
}));

vi.mock("@/components/promptbox/EnvironmentPicker", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/promptbox/EnvironmentPicker")>();

  return {
    ...actual,
    EnvironmentPicker: () => null,
  };
});

interface PromptDraftStorageMock {
  addAttachment: ReturnType<typeof vi.fn>;
  appendText: ReturnType<typeof vi.fn>;
  attachments: PromptDraftState["attachments"];
  clear: ReturnType<typeof vi.fn>;
  getCurrent: ReturnType<typeof vi.fn>;
  removeAttachment: ReturnType<typeof vi.fn>;
  restoreIfEmpty: ReturnType<typeof vi.fn>;
  setAttachments: ReturnType<typeof vi.fn>;
  setText: ReturnType<typeof vi.fn>;
  setValue: ReturnType<typeof vi.fn>;
  storageKey: string;
  text: string;
  value: string;
}

function createPromptDraftStorageMock(
  initialDraft: PromptDraftState,
): {
  currentDraft: PromptDraftState;
  promptDraft: PromptDraftStorageMock;
  setCurrentDraft: (draft: PromptDraftState) => void;
} {
  let currentDraft = initialDraft;

  return {
    currentDraft,
    promptDraft: {
      addAttachment: vi.fn(),
      appendText: vi.fn(),
      attachments: initialDraft.attachments,
      clear: vi.fn(),
      getCurrent: vi.fn(() => currentDraft),
      removeAttachment: vi.fn(),
      restoreIfEmpty: vi.fn(),
      setAttachments: vi.fn(),
      setText: vi.fn(),
      setValue: vi.fn(),
      storageKey: "prompt-draft-key",
      text: initialDraft.text,
      value: initialDraft.text,
    },
    setCurrentDraft: (draft) => {
      currentDraft = draft;
    },
  };
}

function renderProjectMainView(): void {
  render(
    <MemoryRouter initialEntries={["/projects/proj-1"]}>
      <Routes>
        <Route element={<ProjectMainView />} path="/projects/:projectId" />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useProjectsMock.mockReturnValue({
    data: [
      {
        createdAt: 1,
        id: "proj-1",
        name: "Project One",
        sources: [],
        updatedAt: 1,
      },
    ],
    isLoading: false,
  });
  useHostDaemonMock.mockReturnValue({
    localHostId: "host-1",
  });
  usePromptMentionsMock.mockReturnValue({
    isError: false,
    isLoading: false,
    setQuery: vi.fn(),
    suggestions: [],
  });
  useThreadCreationOptionsMock.mockReturnValue({
    activeModel: null,
    environmentSelectionValue: "host:host-1:local",
    hasMultipleProviders: false,
    modelOptions: [],
    providerOptions: [],
    reasoningLevel: "medium",
    reasoningOptions: [],
    sandboxMode: "workspace-write",
    sandboxOptions: [],
    selectedModel: "gpt-5.4",
    selectedProviderId: "provider-1",
    serviceTier: undefined,
    setEnvironmentSelectionValue: vi.fn(),
    setReasoningLevel: vi.fn(),
    setSandboxMode: vi.fn(),
    setSelectedModel: vi.fn(),
    setSelectedProviderId: vi.fn(),
    setServiceTier: vi.fn(),
    supportsServiceTier: false,
  });
  useUploadPromptAttachmentMock.mockReturnValue({
    isPending: false,
    mutateAsync: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProjectMainView", () => {
  it("does not clear the draft when thread creation fails", async () => {
    const draft = createPromptDraftStorageMock({
      attachments: [],
      text: "Investigate server outage",
    });
    const mutateAsync = vi.fn(async () => {
      throw new Error("Server is down");
    });

    usePromptDraftStorageMock.mockReturnValue(draft.promptDraft);
    useCreateThreadMock.mockReturnValue({
      isPending: false,
      mutateAsync,
    });

    renderProjectMainView();

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledTimes(1);
    });

    expect(draft.promptDraft.clear).not.toHaveBeenCalled();
  });

  it("clears the draft after a successful submit when it has not changed", async () => {
    const draft = createPromptDraftStorageMock({
      attachments: [],
      text: "Investigate server outage",
    });
    const mutateAsync = vi.fn(async () => ({ id: "thread-1" }));

    usePromptDraftStorageMock.mockReturnValue(draft.promptDraft);
    useCreateThreadMock.mockReturnValue({
      isPending: false,
      mutateAsync,
    });

    renderProjectMainView();

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(draft.promptDraft.clear).toHaveBeenCalledTimes(1);
    });
  });

  it("preserves edits made while thread creation is in flight", async () => {
    const draft = createPromptDraftStorageMock({
      attachments: [],
      text: "Investigate server outage",
    });
    let resolveMutation: (() => void) | null = null;
    const mutateAsync = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveMutation = () => {
            resolve({ id: "thread-1" });
          };
        }),
    );

    usePromptDraftStorageMock.mockReturnValue(draft.promptDraft);
    useCreateThreadMock.mockReturnValue({
      isPending: false,
      mutateAsync,
    });

    renderProjectMainView();

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledTimes(1);
    });

    draft.setCurrentDraft({
      attachments: [],
      text: "Edited while pending",
    });

    await act(async () => {
      resolveMutation?.();
    });

    await waitFor(() => {
      expect(draft.promptDraft.getCurrent).toHaveBeenCalled();
    });

    expect(draft.promptDraft.clear).not.toHaveBeenCalled();
  });
});
