import { PERSONAL_PROJECT_ID, type Thread } from "@bb/domain";
import { makeThread as makeThreadFixture } from "@bb/test-helpers/domain-fixtures";
import { describe, expect, it } from "vitest";
import { buildThreadMentionSuggestions } from "./threadMentionSuggestions";

interface ThreadFixtureOptions {
  id: string;
  parentThreadId?: string | null;
  projectId?: string;
  title: string | null;
  titleFallback?: string | null;
  visibility?: Thread["visibility"];
}

interface BuildSuggestionFixtureArgs {
  threads: readonly Thread[];
  query: string;
  currentProjectId?: string;
  currentThreadId?: string;
  limit?: number;
}

function makeThread(options: ThreadFixtureOptions): Thread {
  return makeThreadFixture({
    id: options.id,
    projectId: options.projectId ?? "proj-1",
    environmentId: "env-1",
    providerId: "openai",
    title: options.title,
    titleFallback: options.titleFallback ?? null,
    parentThreadId: options.parentThreadId ?? null,
    visibility: options.visibility ?? "visible",
    lastReadAt: null,
    latestAttentionAt: 1,
    createdAt: 1,
    updatedAt: 1,
  });
}

function getSuggestionThreadIds(
  args: BuildSuggestionFixtureArgs,
): readonly string[] {
  return buildThreadMentionSuggestions({
    threads: args.threads,
    query: args.query,
    currentProjectId: args.currentProjectId,
    currentThreadId: args.currentThreadId,
    projectNamesById: new Map([
      ["proj-1", "Core App"],
      ["proj-2", "Docs Site"],
    ]),
    limit: args.limit ?? 8,
  }).map((suggestion) => suggestion.threadId);
}

describe("buildThreadMentionSuggestions", () => {
  it("matches non-contiguous title queries", () => {
    const threads = [
      makeThread({
        id: "thr_research",
        title: "Research notes",
      }),
      makeThread({
        id: "thr_prompt",
        title: "Prompt mention improvements",
      }),
      makeThread({
        id: "thr_release",
        title: "Release checklist",
      }),
    ];

    expect(
      getSuggestionThreadIds({
        threads,
        query: "pmi",
      }),
    ).toEqual(["thr_prompt"]);
  });

  it("matches thread ids", () => {
    const threads = [
      makeThread({
        id: "thr_alpha",
        title: "Design review",
      }),
      makeThread({
        id: "thr_beta",
        title: "Implementation plan",
      }),
    ];

    expect(
      getSuggestionThreadIds({
        threads,
        query: "beta",
      }),
    ).toEqual(["thr_beta"]);
  });

  it("excludes the current thread", () => {
    const threads = [
      makeThread({
        id: "thr_current",
        title: "Prompt mention improvements",
      }),
      makeThread({
        id: "thr_other",
        title: "Prompt mention rollout",
      }),
    ];

    expect(
      getSuggestionThreadIds({
        threads,
        query: "prompt",
        currentThreadId: "thr_current",
      }),
    ).toEqual(["thr_other"]);
  });

  it("excludes side chats", () => {
    const threads = [
      makeThread({
        id: "thr_parent",
        title: "Prompt mention improvements",
      }),
      makeThread({
        id: "thr_side_chat",
        visibility: "hidden",
        title: "Prompt mention side chat",
      }),
    ];

    expect(
      getSuggestionThreadIds({
        threads,
        query: "prompt mention",
      }),
    ).toEqual(["thr_parent"]);
  });

  it("returns threads with deterministic ties", () => {
    const threads = [
      makeThread({
        id: "thr_later",
        title: "Shared context",
      }),
      makeThread({
        id: "thr_earlier",
        title: "Shared context",
      }),
    ];

    expect(
      getSuggestionThreadIds({
        threads,
        query: "shared",
      }),
    ).toEqual(["thr_earlier", "thr_later"]);
  });

  it("ranks directly related, same-parent, and same-project thread matches together", () => {
    const threads = [
      makeThread({
        id: "thr_current",
        parentThreadId: "thr_parent",
        title: "Shared context",
      }),
      makeThread({
        id: "thr_other_project_parent",
        projectId: "proj-2",
        title: "Shared context",
      }),
      makeThread({
        id: "thr_same_project",
        title: "Shared context",
      }),
      makeThread({
        id: "thr_sibling",
        parentThreadId: "thr_parent",
        title: "Shared context",
      }),
      makeThread({
        id: "thr_parent",
        title: "Shared context",
      }),
    ];

    expect(
      getSuggestionThreadIds({
        threads,
        query: "shared",
        currentProjectId: "proj-1",
        currentThreadId: "thr_current",
      }),
    ).toEqual([
      "thr_parent",
      "thr_sibling",
      "thr_same_project",
      "thr_other_project_parent",
    ]);
  });

  it("ranks children of the current parent as directly related", () => {
    const threads = [
      makeThread({
        id: "thr_parent",
        title: "Shared context",
      }),
      makeThread({
        id: "thr_same_project_parent",
        title: "Shared context",
      }),
      makeThread({
        id: "thr_child",
        parentThreadId: "thr_parent",
        title: "Shared context",
      }),
      makeThread({
        id: "thr_other_project_parent",
        projectId: "proj-2",
        title: "Shared context",
      }),
    ];

    expect(
      getSuggestionThreadIds({
        threads,
        query: "shared",
        currentProjectId: "proj-1",
        currentThreadId: "thr_parent",
      }),
    ).toEqual([
      "thr_child",
      "thr_same_project_parent",
      "thr_other_project_parent",
    ]);
  });

  it("adds project names only for threads outside the current project", () => {
    const suggestions = buildThreadMentionSuggestions({
      threads: [
        makeThread({
          id: "thr_current_project",
          projectId: "proj-1",
          title: "Shared context",
        }),
        makeThread({
          id: "thr_other_project",
          projectId: "proj-2",
          title: "Shared context",
        }),
      ],
      query: "shared",
      currentProjectId: "proj-1",
      projectNamesById: new Map([
        ["proj-1", "Core App"],
        ["proj-2", "Docs Site"],
      ]),
      limit: 8,
    });

    expect(
      suggestions.map((suggestion) => ({
        projectId: suggestion.projectId,
        projectName: suggestion.projectName,
        threadId: suggestion.threadId,
      })),
    ).toEqual([
      {
        projectId: "proj-1",
        projectName: undefined,
        threadId: "thr_current_project",
      },
      {
        projectId: "proj-2",
        projectName: "Docs Site",
        threadId: "thr_other_project",
      },
    ]);
  });

  it("adds project names when the current project is unknown", () => {
    const suggestions = buildThreadMentionSuggestions({
      threads: [
        makeThread({
          id: "thr_first_project",
          projectId: "proj-1",
          title: "Shared context",
        }),
        makeThread({
          id: "thr_second_project",
          projectId: "proj-2",
          title: "Shared context",
        }),
      ],
      query: "shared",
      projectNamesById: new Map([
        ["proj-1", "Core App"],
        ["proj-2", "Docs Site"],
      ]),
      limit: 8,
    });

    expect(
      suggestions.map((suggestion) => ({
        projectId: suggestion.projectId,
        projectName: suggestion.projectName,
        threadId: suggestion.threadId,
      })),
    ).toEqual([
      {
        projectId: "proj-1",
        projectName: "Core App",
        threadId: "thr_first_project",
      },
      {
        projectId: "proj-2",
        projectName: "Docs Site",
        threadId: "thr_second_project",
      },
    ]);
  });

  it("does not add the personal project name to projectless thread suggestions", () => {
    const suggestions = buildThreadMentionSuggestions({
      threads: [
        makeThread({
          id: "thr_personal",
          projectId: PERSONAL_PROJECT_ID,
          title: "Shared context",
        }),
        makeThread({
          id: "thr_project",
          projectId: "proj-2",
          title: "Shared context",
        }),
      ],
      query: "shared",
      currentProjectId: "proj-1",
      projectNamesById: new Map([
        [PERSONAL_PROJECT_ID, "Personal"],
        ["proj-2", "Docs Site"],
      ]),
      limit: 8,
    });

    expect(
      suggestions.map((suggestion) => ({
        projectId: suggestion.projectId,
        projectName: suggestion.projectName,
        threadId: suggestion.threadId,
      })),
    ).toEqual([
      {
        projectId: PERSONAL_PROJECT_ID,
        projectName: undefined,
        threadId: "thr_personal",
      },
      {
        projectId: "proj-2",
        projectName: "Docs Site",
        threadId: "thr_project",
      },
    ]);
  });
});
