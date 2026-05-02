// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePatchFiles } from "@pierre/diffs";
import type { FileDiffMetadata, ParsedPatch } from "@pierre/diffs";
import type { BaseDiffOptions } from "@pierre/diffs/react";
import type { TimelineFileChange } from "@bb/server-contract";
import { TimelineFileDiffBlock } from "../src/thread-timeline/TimelineFileDiffBlock.js";

interface MockFileDiffProps {
  fileDiff: FileDiffMetadata;
  options: BaseDiffOptions;
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

function timelineFileChange(diff: string): TimelineFileChange {
  return {
    path: "src/app.ts",
    kind: "update",
    movePath: null,
    diff,
    diffStats: {
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
  it("parses a renderable patch once across remounts with equivalent changes", () => {
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
    render(
      <TimelineFileDiffBlock
        change={timelineFileChange(diff)}
        themeType="light"
      />,
    );

    expect(screen.getByTestId("file-diff").textContent ?? "").toBe(
      "src/app.ts",
    );
    expect(parsePatchFilesMock()).toHaveBeenCalledTimes(1);
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

    expect(view.container.querySelector("[data-timeline-file-diff]")).toBeNull();
    expect(view.container.textContent ?? "").toContain("not a valid patch");
  });
});
