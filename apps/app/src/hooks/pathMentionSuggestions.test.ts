import { describe, expect, it } from "vitest";
import { buildPathMentionSuggestions } from "./pathMentionSuggestions";
import type { PathSuggestion } from "./usePathSuggestions";

interface PathSuggestionFixture {
  source: PathSuggestion["source"];
  entryKind: PathSuggestion["entryKind"];
  path: string;
  name: string;
}

function makePathSuggestion(fixture: PathSuggestionFixture): PathSuggestion {
  return {
    source: fixture.source,
    entryKind: fixture.entryKind,
    path: fixture.path,
    name: fixture.name,
    score: 1,
    positions: [],
  };
}

describe("buildPathMentionSuggestions", () => {
  it("keeps workspace file replacements unchanged", () => {
    expect(
      buildPathMentionSuggestions({
        paths: [
          makePathSuggestion({
            source: "workspace",
            entryKind: "file",
            path: "src/index.ts",
            name: "index.ts",
          }),
        ],
      }),
    ).toEqual([
      {
        kind: "path",
        source: "workspace",
        entryKind: "file",
        path: "src/index.ts",
        name: "index.ts",
        replacement: "src/index.ts",
      },
    ]);
  });

  it("adds trailing slashes to workspace folders", () => {
    expect(
      buildPathMentionSuggestions({
        paths: [
          makePathSuggestion({
            source: "workspace",
            entryKind: "directory",
            path: "src/components",
            name: "components",
          }),
        ],
      })[0]?.replacement,
    ).toBe("src/components/");
  });

  it("qualifies thread-storage file replacements", () => {
    expect(
      buildPathMentionSuggestions({
        paths: [
          makePathSuggestion({
            source: "thread-storage",
            entryKind: "file",
            path: "notes/status.md",
            name: "status.md",
          }),
        ],
      })[0]?.replacement,
    ).toBe("thread-storage:notes/status.md");
  });

  it("qualifies thread-storage folder replacements with a trailing slash", () => {
    expect(
      buildPathMentionSuggestions({
        paths: [
          makePathSuggestion({
            source: "thread-storage",
            entryKind: "directory",
            path: "notes",
            name: "notes",
          }),
        ],
      })[0]?.replacement,
    ).toBe("thread-storage:notes/");
  });
});
