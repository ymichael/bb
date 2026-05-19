import type { Thread } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  buildThreadMentionSuggestions,
  getThreadMentionSectionMode,
  type ThreadSuggestionMode,
} from "./threadMentionSuggestions";

interface ThreadFixtureOptions {
  id: string;
  type: Thread["type"];
  title: string | null;
  titleFallback?: string | null;
}

interface BuildSuggestionFixtureArgs {
  threads: readonly Thread[];
  query: string;
  mode: ThreadSuggestionMode;
  currentThreadId?: string;
  limit?: number;
}

function makeThread(options: ThreadFixtureOptions): Thread {
  return {
    id: options.id,
    projectId: "proj-1",
    environmentId: "env-1",
    automationId: null,
    providerId: "openai",
    type: options.type,
    title: options.title,
    titleFallback: options.titleFallback ?? null,
    status: "idle",
    parentThreadId: null,
    archivedAt: null,
    stopRequestedAt: null,
    deletedAt: null,
    lastReadAt: null,
    latestAttentionAt: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

function getSuggestionThreadIds(
  args: BuildSuggestionFixtureArgs,
): readonly string[] {
  return buildThreadMentionSuggestions({
    threads: args.threads,
    query: args.query,
    mode: args.mode,
    currentThreadId: args.currentThreadId,
    limit: args.limit ?? 8,
  }).map((suggestion) => suggestion.threadId);
}

describe("buildThreadMentionSuggestions", () => {
  it("matches non-contiguous title queries", () => {
    const threads = [
      makeThread({
        id: "thr_research",
        type: "standard",
        title: "Research notes",
      }),
      makeThread({
        id: "thr_prompt",
        type: "manager",
        title: "Prompt mention improvements",
      }),
      makeThread({
        id: "thr_release",
        type: "standard",
        title: "Release checklist",
      }),
    ];

    expect(
      getSuggestionThreadIds({
        threads,
        query: "pmi",
        mode: "all",
      }),
    ).toEqual(["thr_prompt"]);
  });

  it("matches thread ids", () => {
    const threads = [
      makeThread({
        id: "thr_alpha",
        type: "manager",
        title: "Design review",
      }),
      makeThread({
        id: "thr_beta",
        type: "standard",
        title: "Implementation plan",
      }),
    ];

    expect(
      getSuggestionThreadIds({
        threads,
        query: "beta",
        mode: "all",
      }),
    ).toEqual(["thr_beta"]);
  });

  it("excludes the current thread", () => {
    const threads = [
      makeThread({
        id: "thr_current",
        type: "manager",
        title: "Prompt mention improvements",
      }),
      makeThread({
        id: "thr_other",
        type: "manager",
        title: "Prompt mention rollout",
      }),
    ];

    expect(
      getSuggestionThreadIds({
        threads,
        query: "prompt",
        mode: "managers",
        currentThreadId: "thr_current",
      }),
    ).toEqual(["thr_other"]);
  });

  it("returns only managers in manager-only mode", () => {
    const threads = [
      makeThread({
        id: "thr_manager",
        type: "manager",
        title: "Shared context",
      }),
      makeThread({
        id: "thr_standard",
        type: "standard",
        title: "Shared context",
      }),
    ];

    expect(
      getSuggestionThreadIds({
        threads,
        query: "shared",
        mode: "managers",
      }),
    ).toEqual(["thr_manager"]);
  });

  it("returns managers and standard threads in all mode with deterministic ties", () => {
    const threads = [
      makeThread({
        id: "thr_standard",
        type: "standard",
        title: "Shared context",
      }),
      makeThread({
        id: "thr_manager",
        type: "manager",
        title: "Shared context",
      }),
    ];

    expect(
      getSuggestionThreadIds({
        threads,
        query: "shared",
        mode: "all",
      }),
    ).toEqual(["thr_manager", "thr_standard"]);
  });
});

describe("getThreadMentionSectionMode", () => {
  it("keeps all-mode thread suggestions semantic", () => {
    expect(getThreadMentionSectionMode("all")).toBe("all");
  });

  it("keeps manager-only thread suggestions semantic", () => {
    expect(getThreadMentionSectionMode("managers")).toBe("managers");
  });

  it("falls back to threads when thread suggestions are disabled", () => {
    expect(getThreadMentionSectionMode("none")).toBe("threads");
  });
});
