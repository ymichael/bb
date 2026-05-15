import { describe, expect, it } from "vitest";
import type { PromptInput } from "@bb/domain";
import {
  formatQueuedMessagePreview,
  queuedInputToDraft,
} from "./threadQueuedMessages";

describe("threadQueuedMessages", () => {
  it("formats text previews from queued inputs", () => {
    const input: PromptInput[] = [
      { type: "text", text: "  First line  " },
      { type: "text", text: "Second line" },
    ];

    expect(formatQueuedMessagePreview(input)).toBe("First line\n\nSecond line");
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

    expect(formatQueuedMessagePreview(input)).toBe(
      "Attachment only (notes.md)",
    );
  });

  it("preserves the attachment fallback for blank paths", () => {
    const input: PromptInput[] = [
      {
        type: "localImage",
        path: "  ",
      },
    ];

    expect(formatQueuedMessagePreview(input)).toBe(
      "Attachment only (Attachment)",
    );
    expect(queuedInputToDraft(input).attachments[0]?.name).toBe("Attachment");
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
});
