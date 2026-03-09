import { describe, expect, it } from "vitest";
import {
  emptyPromptDraftState,
  parsePromptDraftStorage,
  promptDraftToInput,
  serializePromptDraftStorage,
} from "./prompt-draft";

describe("prompt draft helpers", () => {
  it("drops invalid legacy raw text drafts", () => {
    const parsed = parsePromptDraftStorage("Investigate flaky login redirect");
    expect(parsed).toEqual({
      text: "",
      attachments: [],
    });
  });

  it("parses structured drafts with attachments", () => {
    const parsed = parsePromptDraftStorage(JSON.stringify({
      text: "Review",
      attachments: [
        {
          type: "localImage",
          path: "/tmp/image.png",
          name: "image.png",
          sizeBytes: 12,
          mimeType: "image/png",
        },
      ],
    }));

    expect(parsed).toEqual({
      text: "Review",
      attachments: [
        {
          type: "localImage",
          path: "/tmp/image.png",
          name: "image.png",
          sizeBytes: 12,
          mimeType: "image/png",
        },
      ],
    });
  });

  it("serializes empty drafts as null storage", () => {
    expect(serializePromptDraftStorage(emptyPromptDraftState())).toBeNull();
  });

  it("maps draft text and attachments to prompt input list", () => {
    const input = promptDraftToInput({
      text: "  Ship this patch  ",
      attachments: [
        {
          type: "localImage",
          path: "/tmp/image.png",
          name: "image.png",
          sizeBytes: 32,
          mimeType: "image/png",
        },
        {
          type: "localFile",
          path: "/tmp/spec.md",
          name: "spec.md",
          sizeBytes: 42,
          mimeType: "text/markdown",
        },
      ],
    });

    expect(input).toEqual([
      { type: "text", text: "Ship this patch" },
      { type: "localImage", path: "/tmp/image.png" },
      {
        type: "localFile",
        path: "/tmp/spec.md",
        name: "spec.md",
        sizeBytes: 42,
        mimeType: "text/markdown",
      },
    ]);
  });
});
