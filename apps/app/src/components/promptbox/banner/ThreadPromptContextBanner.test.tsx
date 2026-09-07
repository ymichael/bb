// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ThreadPullRequest } from "@bb/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  isThreadDisplayStatusBannerActive,
  ThreadPromptContextBanner,
  type ThreadPromptGitSection,
} from "./ThreadPromptContextBanner";

const noop = () => {};

const changedFile = {
  path: "apps/app/src/components/promptbox/banner/ThreadPromptContextBanner.tsx",
  status: "M" as const,
  insertions: 2,
  deletions: 0,
};

const pullRequestFixture: ThreadPullRequest = {
  number: 128,
  title: "Show pull request status in the prompt context banner",
  state: "open",
  url: "https://github.com/acme/bb/pull/128",
  baseRefName: "main",
  headRefName: "bb/pr-context-banner",
  updatedAt: "2026-06-16T12:30:00Z",
  checks: {
    state: "passing",
    totalCount: 1,
    passedCount: 1,
    failedCount: 0,
    pendingCount: 0,
  },
  review: {
    state: "none",
    reviewRequestCount: 0,
  },
  mergeability: {
    state: "mergeable",
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
  },
  attention: "ready_to_merge",
};

function makeGitSection(
  kind: ThreadPromptGitSection["changedFiles"]["kind"] = "uncommitted",
  mergeBase: ThreadPromptGitSection["mergeBase"] = null,
): ThreadPromptGitSection {
  return {
    changedFiles: {
      kind,
      label: kind === "committed" ? "Committed" : "Uncommitted",
      files: [changedFile],
      mergeBaseRef: kind === "committed" ? "abc1234" : null,
      stats: {
        insertions: 2,
        deletions: 0,
        lineStatsComplete: true,
        files: [changedFile],
      },
    },
    mergeBase,
    onPromptBannerFileClick: noop,
  };
}

afterEach(cleanup);

describe("ThreadPromptContextBanner", () => {
  it("renders the archived read-only status without an action", () => {
    const markup = renderToStaticMarkup(
      <ThreadPromptContextBanner
        gitSection={null}
        gitSectionPending={false}
        archivedSection={{ archivedAt: 1_731_456_000_000 }}
        environmentGoneSection={null}
        parentThreadSection={null}
        childThreadsSection={null}
        pullRequestSection={null}
        expandedSection={null}
        onToggleSection={noop}
      />,
    );

    expect(markup).toContain("Thread is archived");
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain("<button");
  });

  it("renders the environment-gone read-only status without a provision action", () => {
    const markup = renderToStaticMarkup(
      <ThreadPromptContextBanner
        gitSection={null}
        gitSectionPending={false}
        archivedSection={null}
        environmentGoneSection={{ status: "destroyed" }}
        parentThreadSection={null}
        childThreadsSection={null}
        pullRequestSection={null}
        expandedSection={null}
        onToggleSection={noop}
      />,
    );

    expect(markup).toContain("Environment archived");
    expect(markup).toContain("This environment has been archived.");
    expect(markup).not.toContain("to keep working");
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("Provision");
  });

  it.each([
    {
      label: "archived",
      archivedSection: { archivedAt: 1_731_456_000_000 },
      environmentGoneSection: null,
      expectedLabel: "Thread is archived",
    },
    {
      label: "environment archived",
      archivedSection: null,
      environmentGoneSection: { status: "destroyed" as const },
      expectedLabel: "Environment archived",
    },
  ])(
    "keeps the $label read-only status visible in compact mode",
    ({ archivedSection, environmentGoneSection, expectedLabel }) => {
      const markup = renderToStaticMarkup(
        <MemoryRouter>
          <ThreadPromptContextBanner
            gitSection={null}
            gitSectionPending={false}
            archivedSection={archivedSection}
            environmentGoneSection={environmentGoneSection}
            parentThreadSection={{
              parentThreadTitle: "Parent thread",
              href: "/threads/thr_parent",
              relationship: "parent",
            }}
            childThreadsSection={null}
            pullRequestSection={null}
            expandedSection={null}
            onToggleSection={noop}
          />
        </MemoryRouter>,
      );

      expect(markup).toContain(expectedLabel);
      expect(markup).not.toContain(
        `data-promptbox-hide-compact="">${expectedLabel}`,
      );
    },
  );

  it("prioritizes the archived-environment status over unarchiving", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ThreadPromptContextBanner
          gitSection={null}
          gitSectionPending={false}
          archivedSection={{
            archivedAt: 1_731_456_000_000,
            onUnarchive: noop,
          }}
          environmentGoneSection={{ status: "destroyed" }}
          parentThreadSection={{
            parentThreadTitle: "Parent thread",
            href: "/threads/thr_parent",
            relationship: "parent",
          }}
          childThreadsSection={null}
          pullRequestSection={null}
          expandedSection={null}
          onToggleSection={noop}
        />
      </MemoryRouter>,
    );

    expect(markup).toContain("Environment archived");
    expect(markup).not.toContain("Thread is archived");
    expect(markup).not.toContain(">Unarchive<");
  });

  it("labels a standalone pull request without non-actionable attention text", () => {
    const markup = renderToStaticMarkup(
      <ThreadPromptContextBanner
        gitSection={null}
        gitSectionPending={false}
        archivedSection={null}
        environmentGoneSection={null}
        parentThreadSection={null}
        childThreadsSection={null}
        pullRequestSection={{ pullRequest: pullRequestFixture }}
        expandedSection={null}
        onToggleSection={noop}
      />,
    );

    expect(markup).toContain("PR #128");
    expect(markup).not.toContain("PR #128 · Open");
    expect(markup).not.toContain("· Ready to merge");
    expect(markup).not.toContain('alt="Checks success"');
  });

  it("uses the selected pull request merge method as the action label", () => {
    const markup = renderToStaticMarkup(
      <ThreadPromptContextBanner
        gitSection={null}
        gitSectionPending={false}
        archivedSection={null}
        environmentGoneSection={null}
        parentThreadSection={null}
        childThreadsSection={null}
        pullRequestSection={{
          pullRequest: pullRequestFixture,
          actions: {
            onMerge: noop,
            selectedMergeMethod: "squash",
          },
        }}
        expandedSection={null}
        onToggleSection={noop}
      />,
    );

    expect(markup).toContain("Squash merge");
  });

  it("does not label standalone pending checks", () => {
    const markup = renderToStaticMarkup(
      <ThreadPromptContextBanner
        gitSection={null}
        gitSectionPending={false}
        archivedSection={null}
        environmentGoneSection={null}
        parentThreadSection={null}
        childThreadsSection={null}
        pullRequestSection={{
          pullRequest: {
            ...pullRequestFixture,
            checks: {
              state: "pending",
              totalCount: 1,
              passedCount: 0,
              failedCount: 0,
              pendingCount: 1,
            },
            attention: "checks_pending",
          },
        }}
        expandedSection={null}
        onToggleSection={noop}
      />,
    );

    expect(markup).toContain("PR #128");
    expect(markup).not.toContain("PR #128 · Open");
    expect(markup).not.toContain("· Checks pending");
    expect(markup).not.toContain('alt="Checks pending"');
  });

  it("keeps useful standalone terminal pull request state labels", () => {
    const markup = renderToStaticMarkup(
      <ThreadPromptContextBanner
        gitSection={null}
        gitSectionPending={false}
        archivedSection={null}
        environmentGoneSection={null}
        parentThreadSection={null}
        childThreadsSection={null}
        pullRequestSection={{
          pullRequest: {
            ...pullRequestFixture,
            state: "closed",
            attention: "closed",
          },
        }}
        expandedSection={null}
        onToggleSection={noop}
      />,
    );

    expect(markup).toContain("PR #128 · Closed");
  });

  it("summarizes child work without flashing the banner", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ThreadPromptContextBanner
          gitSection={null}
          gitSectionPending={false}
          archivedSection={null}
          environmentGoneSection={null}
          parentThreadSection={null}
          childThreadsSection={{
            items: [
              {
                id: "thr_child",
                title: "Investigate failing checks",
                href: "/threads/thr_child",
                hasPendingInteraction: false,
              },
            ],
          }}
          pullRequestSection={null}
          expandedSection={null}
          onToggleSection={noop}
        />
      </MemoryRouter>,
    );

    expect(markup).toContain('aria-label="Child threads"');
    expect(markup).toContain(
      "1 active child thread: Investigate failing checks",
    );
    expect(markup).toContain("Active child thread:");
    expect(markup).toContain("Investigate failing checks");
    expect(markup).toContain('data-icon="UserRound"');
    expect(markup).toContain("animate-shine-icon");
    expect(markup).not.toContain("animate-shine font-medium");
  });

  it("summarizes additional active child threads", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ThreadPromptContextBanner
          gitSection={null}
          gitSectionPending={false}
          archivedSection={null}
          environmentGoneSection={null}
          parentThreadSection={null}
          childThreadsSection={{
            items: [
              {
                id: "thr_primary",
                title: "Investigate failing checks",
                href: "/threads/thr_primary",
                hasPendingInteraction: false,
              },
              {
                id: "thr_other",
                title: "Review the release notes",
                href: "/threads/thr_other",
                hasPendingInteraction: false,
              },
            ],
          }}
          pullRequestSection={null}
          expandedSection={null}
          onToggleSection={noop}
        />
      </MemoryRouter>,
    );

    expect(markup).toContain(
      "2 active child threads: Investigate failing checks",
    );
    expect(markup).toContain("+1 more");
  });

  it("lets combined child and context cards shrink inside the composer stack", () => {
    render(
      <MemoryRouter>
        <ThreadPromptContextBanner
          gitSection={makeGitSection("uncommitted")}
          gitSectionPending={false}
          archivedSection={null}
          environmentGoneSection={null}
          parentThreadSection={null}
          childThreadsSection={{
            items: [
              {
                id: "thr_child",
                title: "Host-owned SourceCode and Diff renderers",
                href: "/threads/thr_child",
                hasPendingInteraction: false,
              },
            ],
          }}
          pullRequestSection={null}
          expandedSection={null}
          onToggleSection={noop}
        />
      </MemoryRouter>,
    );

    const childCard = screen.getByRole("region", { name: "Child threads" });
    const contextCard = screen.getByRole("region", {
      name: "Thread context before sending",
    });

    expect(childCard.parentElement).toBe(contextCard.parentElement);
    expect(childCard.parentElement?.classList.contains("min-w-0")).toBe(true);
  });

  it("uses neutral active copy for a child waiting for a host", () => {
    expect(isThreadDisplayStatusBannerActive("waiting-for-host")).toBe(true);

    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ThreadPromptContextBanner
          gitSection={null}
          gitSectionPending={false}
          archivedSection={null}
          environmentGoneSection={null}
          parentThreadSection={null}
          childThreadsSection={{
            items: [
              {
                id: "thr_waiting",
                title: "Waiting for build host",
                href: "/threads/thr_waiting",
                hasPendingInteraction: false,
              },
            ],
          }}
          pullRequestSection={null}
          expandedSection={null}
          onToggleSection={noop}
        />
      </MemoryRouter>,
    );

    expect(markup).toContain("1 active child thread: Waiting for build host");
    expect(markup).toContain("Active child thread:");
    expect(markup).not.toContain("Running child thread:");
  });

  it("labels a child blocked on approval instead of active work", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ThreadPromptContextBanner
          gitSection={null}
          gitSectionPending={false}
          archivedSection={null}
          environmentGoneSection={null}
          parentThreadSection={null}
          childThreadsSection={{
            items: [
              {
                id: "thr_blocked",
                title: "Install workspace tools",
                href: "/threads/thr_blocked",
                hasPendingInteraction: true,
              },
            ],
          }}
          pullRequestSection={null}
          expandedSection={null}
          onToggleSection={noop}
        />
      </MemoryRouter>,
    );

    expect(markup).toContain(
      "1 child thread needs input: Install workspace tools",
    );
    expect(markup).toContain("Needs your input:");
    expect(markup).toContain("Install workspace tools");
    expect(markup).toContain('data-icon="CircleQuestion"');
    expect(markup).not.toContain("Active child thread:");
    expect(markup).not.toContain("animate-shine-icon");
  });

  it("labels standalone actionable pull request attention", () => {
    const markup = renderToStaticMarkup(
      <ThreadPromptContextBanner
        gitSection={null}
        gitSectionPending={false}
        archivedSection={null}
        environmentGoneSection={null}
        parentThreadSection={null}
        childThreadsSection={null}
        pullRequestSection={{
          pullRequest: {
            ...pullRequestFixture,
            checks: {
              state: "failing",
              totalCount: 1,
              passedCount: 0,
              failedCount: 1,
              pendingCount: 0,
            },
            attention: "checks_failed",
          },
        }}
        expandedSection={null}
        onToggleSection={noop}
      />,
    );

    expect(markup).toContain("PR #128");
    expect(markup).toContain("· Checks failing");
    expect(markup).not.toContain("Checks failure");
  });

  it("shows pull request and diff labels together when only PR and git context are visible", () => {
    const markup = renderToStaticMarkup(
      <ThreadPromptContextBanner
        gitSection={makeGitSection("uncommitted")}
        gitSectionPending={false}
        archivedSection={null}
        environmentGoneSection={null}
        parentThreadSection={null}
        childThreadsSection={null}
        pullRequestSection={{ pullRequest: pullRequestFixture }}
        expandedSection={null}
        onToggleSection={noop}
      />,
    );

    expect(markup).toContain("PR #128");
    expect(markup).not.toContain("Open PR #128");
    expect(markup).not.toContain("· Ready to merge");
    expect(markup).toContain("Uncommitted");
    expect(markup).toContain("1 file");
  });

  it("keeps the pull request action visible beside other context segments", () => {
    const markup = renderToStaticMarkup(
      <ThreadPromptContextBanner
        gitSection={makeGitSection("uncommitted")}
        gitSectionPending={false}
        archivedSection={null}
        environmentGoneSection={null}
        parentThreadSection={null}
        childThreadsSection={null}
        pullRequestSection={{
          pullRequest: pullRequestFixture,
          actions: {
            onMerge: noop,
            selectedMergeMethod: "rebase",
          },
        }}
        expandedSection={null}
        onToggleSection={noop}
      />,
    );

    expect(markup).toContain("PR #128");
    expect(markup).toContain("Uncommitted");
    expect(markup).toContain("Rebase and merge");
  });

  it("uses the shared committed git label beside pull request context", () => {
    const markup = renderToStaticMarkup(
      <ThreadPromptContextBanner
        gitSection={makeGitSection("committed")}
        gitSectionPending={false}
        archivedSection={null}
        environmentGoneSection={null}
        parentThreadSection={null}
        childThreadsSection={null}
        pullRequestSection={{ pullRequest: pullRequestFixture }}
        expandedSection={null}
        onToggleSection={noop}
      />,
    );

    expect(markup).toContain("PR #128");
    expect(markup).toContain("Committed");
    expect(markup).toContain("1 file");
  });

  it.each([
    {
      label: "checked open",
      pullRequest: pullRequestFixture,
      expectedMinWidthClass: "min-w-13",
    },
    {
      label: "merged",
      pullRequest: {
        ...pullRequestFixture,
        state: "merged" as const,
        attention: "merged" as const,
      },
      expectedMinWidthClass: "min-w-8",
    },
    {
      label: "closed",
      pullRequest: {
        ...pullRequestFixture,
        state: "closed" as const,
        attention: "closed" as const,
      },
      expectedMinWidthClass: "min-w-8",
    },
  ])(
    "reserves only the width needed by a $label pull request status pill",
    ({ pullRequest, expectedMinWidthClass }) => {
      render(
        <MemoryRouter>
          <ThreadPromptContextBanner
            gitSection={makeGitSection("committed")}
            gitSectionPending={false}
            archivedSection={null}
            environmentGoneSection={null}
            parentThreadSection={null}
            childThreadsSection={null}
            pullRequestSection={{ pullRequest }}
            expandedSection={null}
            onToggleSection={noop}
          />
        </MemoryRouter>,
      );

      const pullRequestLink = screen.getByRole("link", {
        name: /Pull request 128:/,
      });
      expect(
        ["min-w-8", "min-w-13"].filter((className) =>
          pullRequestLink.classList.contains(className),
        ),
      ).toEqual([expectedMinWidthClass]);
    },
  );
});

describe("ThreadPromptContextBanner git section body", () => {
  function renderBanner(expandedSection: "git" | null) {
    return (
      <MemoryRouter>
        <ThreadPromptContextBanner
          gitSection={makeGitSection("uncommitted")}
          gitSectionPending={false}
          archivedSection={null}
          environmentGoneSection={null}
          parentThreadSection={null}
          childThreadsSection={null}
          pullRequestSection={null}
          expandedSection={expandedSection}
          onToggleSection={noop}
        />
      </MemoryRouter>
    );
  }

  it("does not mount the changed-files list until the section first expands", () => {
    const { rerender } = render(renderBanner(null));
    expect(screen.queryByRole("list", { hidden: true })).toBeNull();

    rerender(renderBanner("git"));
    expect(screen.getByRole("list")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: `Open ${changedFile.path}` }),
    ).toBeTruthy();

    rerender(renderBanner(null));
    expect(screen.getByRole("list", { hidden: true })).toBeTruthy();
  });
});
