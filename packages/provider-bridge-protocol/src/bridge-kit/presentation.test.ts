import { THREAD_EVENT_ITEM_PRESENTATION_DETAIL_MAX_LENGTH } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  PRESENTATION_TITLE_MAX_LENGTH,
  fileReadPresentation,
  presentationDetail,
  presentationFileName,
  presentationTitle,
  webSearchPresentation,
  withTitle,
} from "./presentation.js";

describe("bridge-kit presentation", () => {
  it("keeps the headline to one short line and omits it when there is none", () => {
    expect(presentationTitle("  first line\nsecond line  ")).toBe("first line");
    expect(presentationTitle("\n\n")).toBeUndefined();
    const title = presentationTitle("x".repeat(400));
    expect(title).toHaveLength(PRESENTATION_TITLE_MAX_LENGTH);
    expect(title?.endsWith("…")).toBe(true);
    expect(
      withTitle(
        { label: { pending: "a", completed: "b" }, icon: { glyph: "X" } },
        undefined,
      ),
    ).not.toHaveProperty("title");
    expect(webSearchPresentation(undefined)).not.toHaveProperty("title");
  });

  it("caps the detail at the persisted presentation schema's limit", () => {
    const detail = presentationDetail(
      "d".repeat(THREAD_EVENT_ITEM_PRESENTATION_DETAIL_MAX_LENGTH + 50),
    );
    expect(detail).toHaveLength(
      THREAD_EVENT_ITEM_PRESENTATION_DETAIL_MAX_LENGTH,
    );
    expect(detail.endsWith("…")).toBe(true);
    expect(presentationDetail("short")).toBe("short");
  });

  it("headlines a file by its name, not its directory", () => {
    expect(presentationFileName("/repo/src/a.ts")).toBe("a.ts");
    expect(presentationFileName("/repo/src/")).toBe("src");
    expect(presentationFileName("")).toBe("");
    expect(fileReadPresentation("/repo/src/a.ts")).toEqual({
      label: { pending: "Reading file", completed: "Read file" },
      icon: { glyph: "FileText" },
      title: "a.ts",
    });
  });
});
