import { describe, expect, it } from "vitest"
import type { PromptInput, ThreadDetailRow } from "@bb/core"
import {
  buildFollowUpSignatureFromInput,
  buildFollowUpSignatureFromRow,
} from "./thread-follow-up-signature"

function makeUserRow(args: {
  text: string
  attachments?: {
    webImages: number
    localImages: number
    localFiles: number
    imageUrls?: string[]
    localImagePaths?: string[]
    localFilePaths?: string[]
  }
}): ThreadDetailRow {
  return {
    kind: "message",
    id: "user-1",
    message: {
      id: "user-1",
      threadId: "thread-1",
      kind: "user",
      text: args.text,
      ...(args.attachments ? { attachments: args.attachments } : {}),
      sourceSeqStart: 1,
      sourceSeqEnd: 1,
      createdAt: 1,
      turnId: "turn-1",
    },
  }
}

describe("thread-follow-up-signature", () => {
  it("treats empty attachment payloads as equivalent to no attachments", () => {
    const input: PromptInput[] = [{ type: "text", text: "Please make this tweak" }]
    const row = makeUserRow({
      text: "Please make this tweak",
      attachments: {
        webImages: 0,
        localImages: 0,
        localFiles: 0,
      },
    })

    expect(buildFollowUpSignatureFromInput(input)).toBe(buildFollowUpSignatureFromRow(row))
  })

  it("preserves non-empty attachment signatures for matching acknowledgements", () => {
    const input: PromptInput[] = [
      { type: "text", text: "Review these" },
      { type: "image", url: "https://example.com/a.png" },
      { type: "localImage", path: "/tmp/b.png" },
      { type: "localFile", path: "/tmp/spec.md" },
    ]
    const row = makeUserRow({
      text: "Review these",
      attachments: {
        webImages: 1,
        localImages: 1,
        localFiles: 1,
        imageUrls: ["https://example.com/a.png"],
        localImagePaths: ["/tmp/b.png"],
        localFilePaths: ["/tmp/spec.md"],
      },
    })

    expect(buildFollowUpSignatureFromInput(input)).toBe(buildFollowUpSignatureFromRow(row))
  })
})
