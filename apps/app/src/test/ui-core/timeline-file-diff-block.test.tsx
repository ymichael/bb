// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePatchFiles } from "@pierre/diffs";
import type { FileDiffMetadata, ParsedPatch } from "@pierre/diffs";
import type { BaseDiffOptions } from "@pierre/diffs/react";
import type { TimelineFileChange } from "@bb/server-contract";
import { TimelineFileDiffBlock } from "@/components/thread-timeline/TimelineFileDiffBlock";

interface MockFileDiffProps {
  fileDiff: FileDiffMetadata;
  options: BaseDiffOptions;
}

interface TimelineFileChangeOverrides {
  diffStats?: {
    added: number;
    removed: number;
  };
  kind?: string;
  movePath?: string | null;
  path?: string;
}

vi.mock("@pierre/diffs", async (importOriginal) => {
  const original = await importOriginal<typeof import("@pierre/diffs")>();
  return {
    ...original,
    parsePatchFiles: vi.fn(),
  };
});

vi.mock("@pierre/diffs/react", () => ({
  FileDiff({ fileDiff, options }: MockFileDiffProps) {
    return (
      <div
        data-disable-line-numbers={String(options.disableLineNumbers)}
        data-testid="file-diff"
      >
        {fileDiff.name}
      </div>
    );
  },
}));

const parsedFileDiff: FileDiffMetadata = {
  name: "src/app.ts",
  prevName: undefined,
  type: "change",
  hunks: [],
  splitLineCount: 0,
  unifiedLineCount: 0,
};

const parsedPatch: ParsedPatch = {
  files: [parsedFileDiff],
};

function parsePatchFilesMock() {
  return vi.mocked(parsePatchFiles);
}

function timelineFileChange(
  diff: string,
  overrides: TimelineFileChangeOverrides = {},
): TimelineFileChange {
  return {
    path: overrides.path ?? "src/app.ts",
    kind: overrides.kind ?? "update",
    movePath: overrides.movePath ?? null,
    diff,
    diffStats: overrides.diffStats ?? {
      added: 1,
      removed: 1,
    },
  };
}

afterEach(() => {
  cleanup();
  parsePatchFilesMock().mockReset();
});

describe("TimelineFileDiffBlock", () => {
  it("reuses a parsed renderable patch across remounts with the same change object", () => {
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");
    const change = timelineFileChange(diff);
    parsePatchFilesMock().mockReturnValue([parsedPatch]);

    const firstView = render(
      <TimelineFileDiffBlock change={change} themeType="light" />,
    );

    expect(screen.getByTestId("file-diff").textContent ?? "").toBe(
      "src/app.ts",
    );
    expect(parsePatchFilesMock()).toHaveBeenCalledTimes(1);

    firstView.unmount();
    render(<TimelineFileDiffBlock change={change} themeType="light" />);

    expect(screen.getByTestId("file-diff").textContent ?? "").toBe(
      "src/app.ts",
    );
    expect(parsePatchFilesMock()).toHaveBeenCalledTimes(1);
  });

  it("parses equivalent new change objects independently", () => {
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");
    parsePatchFilesMock().mockReturnValue([parsedPatch]);

    const firstView = render(
      <TimelineFileDiffBlock
        change={timelineFileChange(diff)}
        themeType="light"
      />,
    );

    firstView.unmount();
    render(
      <TimelineFileDiffBlock
        change={timelineFileChange(diff)}
        themeType="light"
      />,
    );

    expect(parsePatchFilesMock()).toHaveBeenCalledTimes(2);
  });

  it("filters context and removed lines from synthetic created-file patches", () => {
    const diff = [
      " preserved context",
      "+created line",
      "-removed line",
      "plain created line",
    ].join("\n");
    parsePatchFilesMock().mockReturnValue([parsedPatch]);

    render(
      <TimelineFileDiffBlock
        change={timelineFileChange(diff, {
          kind: "create",
          diffStats: {
            added: 2,
            removed: 0,
          },
        })}
        themeType="light"
      />,
    );

    expect(parsePatchFilesMock()).toHaveBeenCalledWith(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- /dev/null",
        "+++ b/src/app.ts",
        "@@ -1,0 +1,2 @@",
        "+created line",
        "+plain created line",
        "",
      ].join("\n"),
    );
  });

  it("filters context and added lines from synthetic deleted-file patches", () => {
    const diff = [
      " preserved context",
      "-deleted line",
      "+added line",
      "plain deleted line",
    ].join("\n");
    parsePatchFilesMock().mockReturnValue([parsedPatch]);

    render(
      <TimelineFileDiffBlock
        change={timelineFileChange(diff, {
          kind: "delete",
          diffStats: {
            added: 0,
            removed: 2,
          },
        })}
        themeType="light"
      />,
    );

    expect(parsePatchFilesMock()).toHaveBeenCalledWith(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ /dev/null",
        "@@ -1,2 +1,0 @@",
        "-deleted line",
        "-plain deleted line",
        "",
      ].join("\n"),
    );
  });

  it("falls back to plain text when a patch cannot be parsed as one file", () => {
    const diff = "diff --git a/src/app.ts b/src/app.ts\nnot a valid patch";
    parsePatchFilesMock().mockReturnValue([{ files: [] }]);

    const view = render(
      <TimelineFileDiffBlock
        change={timelineFileChange(diff)}
        themeType="light"
      />,
    );

    expect(
      view.container.querySelector("[data-timeline-file-diff]"),
    ).toBeNull();
    expect(view.container.textContent ?? "").toContain("not a valid patch");
  });
});
