import { describe, expect, it } from "vitest";
import type { PromptInput } from "@bb/core";
import {
  extractThreadQueuedMessages,
  formatQueuedFollowUpPreview,
  queuedInputToDraft,
} from "./threadQueuedMessages";

describe("threadQueuedMessages", () => {
  it("formats text previews from queued inputs", () => {
    const input: PromptInput[] = [
      { type: "text", text: "  First line  " },
      { type: "text", text: "Second line" },
    ];

    expect(formatQueuedFollowUpPreview(input)).toBe("First line\n\nSecond line");
  });

  it("falls back to attachment summaries when no text is present", () => {
    const input: PromptInput[] = [
      {
        type: "localFile",
        path: "/tmp/notes.md",
        name: "notes.md",
        sizeBytes: 10,
      },
    ];

    expect(formatQueuedFollowUpPreview(input)).toBe("Attachment only (notes.md)");
  });

  it("restores editable drafts from queued messages", () => {
    const draft = queuedInputToDraft([
      { type: "text", text: "Follow up" },
      {
        type: "localImage",
        path: "/tmp/image.png",
      },
    ]);

    expect(draft).toEqual({
      text: "Follow up",
      attachments: [
        {
          type: "localImage",
          path: "/tmp/image.png",
          name: "image.png",
          sizeBytes: 0,
        },
      ],
    });
  });

  it("ignores malformed queued messages during extraction", () => {
    expect(
      extractThreadQueuedMessages({
        queuedMessages: [
          { id: "good", input: [{ type: "text", text: "hello" }] },
          { id: "bad", input: [{ type: "localFile" }] },
        ],
      }),
    ).toEqual([{ id: "good", input: [{ type: "text", text: "hello" }] }]);
  });
});
