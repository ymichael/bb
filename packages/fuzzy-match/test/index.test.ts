import { describe, expect, it } from "vitest";
import {
  FUZZY_MATCH_QUERY_MAX_LENGTH,
  fuzzyMatchPaths,
  fuzzyMatchText,
} from "../src/index.js";

describe("fuzzyMatchPaths", () => {
  it("returns the first limited paths for an empty query", () => {
    const paths = ["src/a.ts", "src/b.ts", "src/c.ts"];

    expect(
      fuzzyMatchPaths({
        items: paths,
        query: "",
        getPath: (path) => path,
        limit: 2,
      }).map((match) => match.item),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("returns no matches for an empty item list", () => {
    expect(
      fuzzyMatchPaths({
        items: [],
        query: "prompt",
        getPath: (path) => path,
        limit: 8,
      }),
    ).toEqual([]);
  });

  it("returns no matches when the limit is zero", () => {
    expect(
      fuzzyMatchPaths({
        items: ["src/a.ts"],
        query: "a",
        getPath: (path) => path,
        limit: 0,
      }),
    ).toEqual([]);
  });

  it("ranks direct filename and path-boundary matches first", () => {
    const paths = [
      "fixtures/generated/prompt-log.ts",
      "apps/app/src/components/promptbox/PromptBox.tsx",
      "apps/app/src/components/promptbox/PromptMentionMenu.tsx",
      "apps/app/src/hooks/usePromptDraftStorage.ts",
    ];

    const matches = fuzzyMatchPaths({
      items: paths,
      query: "prompt",
      getPath: (path) => path,
      limit: 3,
    });

    expect(matches.map((match) => match.item)).toEqual([
      "apps/app/src/components/promptbox/PromptBox.tsx",
      "apps/app/src/components/promptbox/PromptMentionMenu.tsx",
      "fixtures/generated/prompt-log.ts",
    ]);
  });

  it("matches subsequence queries", () => {
    const matches = fuzzyMatchPaths({
      items: [
        "apps/app/src/components/promptbox/PromptBox.tsx",
        "apps/app/src/components/promptbox/PromptMentionMenu.tsx",
      ],
      query: "pmtbx",
      getPath: (path) => path,
      limit: 5,
    });

    expect(matches[0].item).toBe(
      "apps/app/src/components/promptbox/PromptBox.tsx",
    );
    expect(matches[0].positions.length).toBeGreaterThan(0);
  });

  it("supports slash queries when paths use backslash separators", () => {
    const matches = fuzzyMatchPaths({
      items: [
        "apps\\app\\src\\components\\promptbox\\PromptBox.tsx",
        "apps\\app\\src\\views\\PromptBox.tsx",
      ],
      query: "comp/prompt",
      getPath: (path) => path,
      limit: 5,
    });

    expect(matches.map((match) => match.item)).toEqual([
      "apps\\app\\src\\components\\promptbox\\PromptBox.tsx",
    ]);
  });

  it("treats exact directory prefixes as scoped path searches", () => {
    const matches = fuzzyMatchPaths({
      items: [
        "apps/cli/src/commands/guide.ts",
        "plans/c.md",
        "plans/b.md",
        "plans/a.md",
        "apps/cli/src/commands/status.ts",
      ],
      query: "plans/",
      getPath: (path) => path,
      limit: 8,
    });

    expect(matches.map((match) => match.item)).toEqual([
      "plans/a.md",
      "plans/b.md",
      "plans/c.md",
    ]);
  });

  it("fuzzy matches the leaf inside an exact directory prefix", () => {
    const matches = fuzzyMatchPaths({
      items: [
        "plans/code-quality-follow-ups.md",
        "plans/timeline-bundle-unification.md",
        "packages/generated/unification.ts",
      ],
      query: "plans/uni",
      getPath: (path) => path,
      limit: 8,
    });

    expect(matches.map((match) => match.item)).toEqual([
      "plans/timeline-bundle-unification.md",
    ]);
  });

  it("fuzzy matches typoed directory segments in order", () => {
    const matches = fuzzyMatchPaths({
      items: [
        "packages/generated/unification.ts",
        "plans/timeline-bundle-unification.md",
        "docs/plans-unification.md",
      ],
      query: "plaxs/uni",
      getPath: (path) => path,
      limit: 8,
    });

    expect(matches[0].item).toBe("plans/timeline-bundle-unification.md");
  });

  it("fuzzy matches transposed directory segment typos", () => {
    const matches = fuzzyMatchPaths({
      items: [
        "packages/generated/unification.ts",
        "plans/timeline-bundle-unification.md",
        "docs/plans-unification.md",
      ],
      query: "plnas/uni",
      getPath: (path) => path,
      limit: 8,
    });

    expect(matches[0].item).toBe("plans/timeline-bundle-unification.md");
  });

  it("boosts basename matches for the final path segment", () => {
    const matches = fuzzyMatchPaths({
      items: [
        "apps/app/src/components/promptbox/HostPicker.tsx",
        "apps/app/src/views/PromptBox.tsx",
        "apps/app/src/components/promptbox/PromptBox.tsx",
      ],
      query: "app/comp/pmtbx",
      getPath: (path) => path,
      limit: 8,
    });

    expect(matches[0].item).toBe(
      "apps/app/src/components/promptbox/PromptBox.tsx",
    );
  });

  it("merges exact-prefix and structured path matches", () => {
    const matches = fuzzyMatchPaths({
      items: ["src/test/test/file.ts", "src/test/file.ts", "test/src/file.ts"],
      query: "test/file",
      getPath: (path) => path,
      limit: 10,
    });

    expect(matches.map((match) => match.item)).toEqual([
      "test/src/file.ts",
      "src/test/file.ts",
      "src/test/test/file.ts",
    ]);
  });

  it("includes directory-prefix positions when matching a leaf query", () => {
    const matches = fuzzyMatchPaths({
      items: ["src/foo/util-helper.ts"],
      query: "src/util",
      getPath: (path) => path,
      limit: 10,
    });

    expect(matches[0].positions).toEqual([0, 1, 2, 3, 8, 9, 10, 11]);
  });

  it("does not fabricate highlight positions for typo segment matches", () => {
    const matches = fuzzyMatchPaths({
      items: ["plans-foo-bar/file.ts"],
      query: "plnas/file",
      getPath: (path) => path,
      limit: 10,
    });

    expect(matches[0].item).toBe("plans-foo-bar/file.ts");
    expect(matches[0].positions).toEqual([14, 15, 16, 17]);
  });

  it("returns no matches for slash-only queries", () => {
    const matches = fuzzyMatchPaths({
      items: ["src/a.ts", "plans/a.md"],
      query: "///",
      getPath: (path) => path,
      limit: 10,
    });

    expect(matches).toEqual([]);
  });

  it("handles repeated slashes between path query segments", () => {
    const matches = fuzzyMatchPaths({
      items: ["src/foo/util-helper.ts", "src/other/readme.md"],
      query: "src//util",
      getPath: (path) => path,
      limit: 10,
    });

    expect(matches.map((match) => match.item)).toEqual([
      "src/foo/util-helper.ts",
    ]);
  });

  it("matches unicode path queries", () => {
    const matches = fuzzyMatchPaths({
      items: ["docs/café.md", "docs/cafe-notes.md"],
      query: "café",
      getPath: (path) => path,
      limit: 10,
    });

    expect(matches[0].item).toBe("docs/café.md");
  });

  it("rejects overlong queries before running path matching", () => {
    const matches = fuzzyMatchPaths({
      items: ["src/a.ts"],
      query: "a".repeat(FUZZY_MATCH_QUERY_MAX_LENGTH + 1),
      getPath: (path) => path,
      limit: 10,
    });

    expect(matches).toEqual([]);
  });
});

interface ThreadSearchFixture {
  id: string;
  title: string;
}

function getThreadSearchTexts(thread: ThreadSearchFixture): readonly string[] {
  return [thread.title, thread.id];
}

describe("fuzzyMatchText", () => {
  it("returns the first limited items for an empty query", () => {
    const items = ["Alpha", "Beta", "Gamma"];

    expect(
      fuzzyMatchText({
        items,
        query: "",
        getText: (item) => item,
        limit: 2,
      }).map((match) => match.item),
    ).toEqual(["Alpha", "Beta"]);
  });

  it("matches non-contiguous title queries", () => {
    const threads: ThreadSearchFixture[] = [
      { id: "thr_research", title: "Research notes" },
      { id: "thr_prompt", title: "Prompt mention improvements" },
      { id: "thr_release", title: "Release checklist" },
    ];

    const matches = fuzzyMatchText({
      items: threads,
      query: "pmi",
      getText: getThreadSearchTexts,
      limit: 3,
    });

    expect(matches.map((match) => match.item.id)).toEqual(["thr_prompt"]);
    expect(matches[0].positions.length).toBeGreaterThan(0);
  });

  it("matches secondary text values such as ids", () => {
    const threads: ThreadSearchFixture[] = [
      { id: "thr_alpha", title: "Design review" },
      { id: "thr_beta", title: "Implementation plan" },
    ];

    expect(
      fuzzyMatchText({
        items: threads,
        query: "beta",
        getText: getThreadSearchTexts,
        limit: 3,
      }).map((match) => match.item.id),
    ).toEqual(["thr_beta"]);
  });

  it("keeps deterministic ordering for equal text matches", () => {
    const threads: ThreadSearchFixture[] = [
      { id: "thr_b", title: "Shared title" },
      { id: "thr_a", title: "Shared title" },
    ];

    expect(
      fuzzyMatchText({
        items: threads,
        query: "shared",
        getText: getThreadSearchTexts,
        limit: 3,
      }).map((match) => match.item.id),
    ).toEqual(["thr_b", "thr_a"]);
  });

  it("returns no matches when the query is too long", () => {
    expect(
      fuzzyMatchText({
        items: ["Alpha"],
        query: "a".repeat(FUZZY_MATCH_QUERY_MAX_LENGTH + 1),
        getText: (item) => item,
        limit: 3,
      }),
    ).toEqual([]);
  });
});
