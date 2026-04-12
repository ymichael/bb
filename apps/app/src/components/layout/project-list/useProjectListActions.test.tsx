// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { Project, Thread } from "@bb/domain";
import type { ProjectResponse } from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import { HttpError } from "@/lib/api";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { toast } from "sonner";
import { useProjectListActions } from "./useProjectListActions";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();

  return {
    ...actual,
    archiveThread: vi.fn(),
    deleteProject: vi.fn(),
    deleteThread: vi.fn(),
    markThreadRead: vi.fn(),
    markThreadUnread: vi.fn(),
    unarchiveThread: vi.fn(),
    updateProject: vi.fn(),
    updateThread: vi.fn(),
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

interface ThreadOverrides extends Partial<Thread> {}

interface ProjectOverrides extends Partial<Project> {}

interface ProjectResponseOverrides extends Partial<ProjectResponse> {}

interface ThreadListHookProps {
  threads: Thread[];
}

function makeThread(overrides: ThreadOverrides = {}): Thread {
  return {
    archivedAt: null,
    automationId: null,
    createdAt: 1,
    deletedAt: null,
    environmentId: "environment-1",
    id: "thread-1",
    lastReadAt: null,
    parentThreadId: null,
    projectId: "project-1",
    providerId: "provider-1",
    stopRequestedAt: null,
    status: "idle",
    title: "Thread title",
    titleFallback: "Thread title",
    type: "standard",
    updatedAt: 10,
    ...overrides,
  };
}

function makeProject(overrides: ProjectOverrides = {}): Project {
  return {
    createdAt: 1,
    id: "project-1",
    name: "Project One",
    updatedAt: 1,
    ...overrides,
  };
}

function makeProjectResponse(
  overrides: ProjectResponseOverrides = {},
): ProjectResponse {
  const sources = overrides.sources ?? [];

  return {
    ...makeProject(overrides),
    sources,
  };
}

function makeArchiveForceRequiredError(): HttpError {
  return new HttpError({
    body: {
      code: "archive_confirmation_required",
    },
    code: "archive_confirmation_required",
    message: "Archiving this thread would clean up a workspace that contains work.",
    status: 409,
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useProjectListActions", () => {
  it("opens and closes the project rename dialog around a successful rename", async () => {
    const project = makeProjectResponse();
    const onProjectRemoved = vi.fn();
    const onThreadDeleted = vi.fn();

    vi.mocked(api.updateProject).mockResolvedValue(
      makeProject({
        id: project.id,
        name: "Renamed project",
      }),
    );

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useProjectListActions({
          onProjectRemoved,
          onThreadDeleted,
          threads: [],
        }),
      { wrapper },
    );

    act(() => {
      result.current.requestRenameProject(project);
    });

    expect(result.current.projectRenameDialog.target).toEqual({
      currentName: project.name,
      id: project.id,
    });

    act(() => {
      result.current.submitProjectRename(project.id, "Renamed project");
    });

    await waitFor(() => {
      expect(api.updateProject).toHaveBeenCalledWith(project.id, {
        name: "Renamed project",
      });
    });

    await waitFor(() => {
      expect(result.current.projectRenameDialog.isOpen).toBe(false);
    });
  });

  it("opens archive confirmation when force is required and closes it after the thread becomes archived", async () => {
    const thread = makeThread();
    const onProjectRemoved = vi.fn();
    const onThreadDeleted = vi.fn();

    vi.mocked(api.archiveThread).mockRejectedValueOnce(makeArchiveForceRequiredError());

    const { wrapper } = createQueryClientTestHarness();
    const { result, rerender } = renderHook(
      ({ threads }: ThreadListHookProps) =>
        useProjectListActions({
          onProjectRemoved,
          onThreadDeleted,
          threads,
        }),
      {
        initialProps: {
          threads: [thread],
        },
        wrapper,
      },
    );

    act(() => {
      result.current.toggleThreadArchive(thread);
    });

    await waitFor(() => {
      expect(result.current.archiveConfirmationDialog.target).toEqual(thread);
    });

    rerender({
      threads: [
        makeThread({
          archivedAt: 100,
          id: thread.id,
        }),
      ],
    });

    await waitFor(() => {
      expect(result.current.archiveConfirmationDialog.isOpen).toBe(false);
    });
  });

  it("marks threads read or unread based on whether the latest update has been seen", async () => {
    const unreadThread = makeThread({
      id: "thread-unread",
      lastReadAt: 2,
      updatedAt: 10,
    });
    const readThread = makeThread({
      id: "thread-read",
      lastReadAt: 10,
      updatedAt: 10,
    });

    vi.mocked(api.markThreadRead).mockResolvedValue(
      makeThread({
        id: unreadThread.id,
        lastReadAt: 10,
      }),
    );
    vi.mocked(api.markThreadUnread).mockResolvedValue(
      makeThread({
        id: readThread.id,
        lastReadAt: 0,
      }),
    );

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useProjectListActions({
          onProjectRemoved: vi.fn(),
          onThreadDeleted: vi.fn(),
          threads: [],
        }),
      { wrapper },
    );

    act(() => {
      result.current.toggleThreadRead(unreadThread);
      result.current.toggleThreadRead(readThread);
    });

    await waitFor(() => {
      expect(api.markThreadRead).toHaveBeenCalledWith(unreadThread.id);
    });

    await waitFor(() => {
      expect(api.markThreadUnread).toHaveBeenCalledWith(readThread.id);
    });
  });

  it("shows a toast when project rename fails", async () => {
    const project = makeProjectResponse();
    const error = new Error("Rename failed");

    vi.mocked(api.updateProject).mockRejectedValue(error);

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useProjectListActions({
          onProjectRemoved: vi.fn(),
          onThreadDeleted: vi.fn(),
          threads: [],
        }),
      { wrapper },
    );

    act(() => {
      result.current.requestRenameProject(project);
      result.current.submitProjectRename(project.id, "Broken name");
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Rename failed");
    });
  });
});
