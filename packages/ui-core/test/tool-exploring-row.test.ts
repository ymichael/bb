import { describe, expect, it } from "vitest";
import {
  buildExploringDetailLines,
  formatExploringIntentLine,
  summarizeExploringCounts,
} from "@bb/core-ui";
import type { ViewToolExploringMessage, ViewToolParsedIntent } from "@bb/domain";

function buildCall(
  callId: string,
  parsedCmd: ViewToolParsedIntent[],
): ViewToolExploringMessage["calls"][number] {
  return {
    callId,
    parsedCmd,
    status: "completed",
  };
}

describe("ToolExploringRow helpers", () => {
  it("formats read intents with the concrete file path", () => {
    expect(
      formatExploringIntentLine({
        type: "read",
        cmd: "Read packages/excalidraw/components/SearchMenu.tsx",
        name: "Read",
        path: "packages/excalidraw/components/SearchMenu.tsx",
      }),
    ).toBe("Read packages/excalidraw/components/SearchMenu.tsx");
  });

  it("formats search intents directly from the structured query", () => {
    expect(
      formatExploringIntentLine({
        type: "search",
        cmd: "Grep 'SearchMenu' in packages/excalidraw",
        query: "SearchMenu",
        path: "packages/excalidraw",
      }),
    ).toBe("Search SearchMenu in packages/excalidraw");
  });

  it("formats list intents directly from the structured path", () => {
    expect(
      formatExploringIntentLine({
        type: "list_files",
        cmd: "Glob **/*.tsx",
        path: "packages/excalidraw/components",
      }),
    ).toBe("List packages/excalidraw/components");
  });

  it("collapses consecutive reads into a single detail line", () => {
    expect(
      buildExploringDetailLines([
        buildCall("read-1", [
          {
            type: "read",
            cmd: "Read packages/excalidraw/components/SearchMenu.tsx",
            name: "Read",
            path: "packages/excalidraw/components/SearchMenu.tsx",
          },
        ]),
        buildCall("read-2", [
          {
            type: "read",
            cmd: "Read packages/excalidraw/tests/search.test.tsx",
            name: "Read",
            path: "packages/excalidraw/tests/search.test.tsx",
          },
        ]),
      ]),
    ).toEqual([
      "Read packages/excalidraw/components/SearchMenu.tsx, packages/excalidraw/tests/search.test.tsx",
    ]);
  });

  it("keeps mixed read and search activity as separate lines", () => {
    expect(
      buildExploringDetailLines([
        buildCall("read-1", [
          {
            type: "read",
            cmd: "Read packages/excalidraw/components/SearchMenu.tsx",
            name: "Read",
            path: "packages/excalidraw/components/SearchMenu.tsx",
          },
        ]),
        buildCall("search-1", [
          {
            type: "search",
            cmd: "Grep 'focusIndex' in packages/excalidraw/components",
            query: "focusIndex",
            path: "packages/excalidraw/components",
          },
        ]),
      ]),
    ).toEqual([
      "Read packages/excalidraw/components/SearchMenu.tsx",
      "Search focusIndex in packages/excalidraw/components",
    ]);
  });

  it("does not dedupe reads that share a basename but have different paths", () => {
    expect(
      buildExploringDetailLines([
        buildCall("read-1", [
          {
            type: "read",
            cmd: "Read packages/excalidraw/src/index.ts",
            name: "Read",
            path: "packages/excalidraw/src/index.ts",
          },
        ]),
        buildCall("read-2", [
          {
            type: "read",
            cmd: "Read packages/excalidraw/tests/index.ts",
            name: "Read",
            path: "packages/excalidraw/tests/index.ts",
          },
        ]),
      ]),
    ).toEqual([
      "Read packages/excalidraw/src/index.ts, packages/excalidraw/tests/index.ts",
    ]);
  });

  it("summarizes file, search, and list counts from structured intents", () => {
    expect(
      summarizeExploringCounts([
        buildCall("read-1", [
          {
            type: "read",
            cmd: "Read packages/excalidraw/components/SearchMenu.tsx",
            name: "Read",
            path: "packages/excalidraw/components/SearchMenu.tsx",
          },
        ]),
        buildCall("read-2", [
          {
            type: "read",
            cmd: "Read packages/excalidraw/tests/search.test.tsx",
            name: "Read",
            path: "packages/excalidraw/tests/search.test.tsx",
          },
        ]),
        buildCall("search-1", [
          {
            type: "search",
            cmd: "Grep 'focusIndex' in packages/excalidraw/components",
            query: "focusIndex",
            path: "packages/excalidraw/components",
          },
        ]),
        buildCall("list-1", [
          {
            type: "list_files",
            cmd: "Glob **/*.tsx",
            path: "packages/excalidraw/components",
          },
        ]),
      ]),
    ).toEqual({
      filesRead: 2,
      searches: 1,
      lists: 1,
    });
  });

  it("supports basename-only read details for React rows", () => {
    expect(
      buildExploringDetailLines(
        [
          buildCall("read-1", [
            {
              type: "read",
              cmd: "Read packages/excalidraw/components/SearchMenu.tsx",
              name: "Read",
              path: "packages/excalidraw/components/SearchMenu.tsx",
            },
          ]),
        ],
        { readPathStyle: "basename" },
      ),
    ).toEqual(["Read SearchMenu.tsx"]);
  });
});
