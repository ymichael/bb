import type { PromptInput, ThreadDetailRow, UIUserMessage } from "@bb/domain"

interface FollowUpAttachmentsSignature {
  webImages: number
  localImages: number
  localFiles: number
  imageUrls?: string[]
  localImagePaths?: string[]
  localFilePaths?: string[]
}

function normalizeFollowUpAttachmentsSignature(
  attachments: FollowUpAttachmentsSignature | null | undefined,
): FollowUpAttachmentsSignature | null {
  if (!attachments) {
    return null
  }

  const webImages = attachments.webImages ?? 0
  const localImages = attachments.localImages ?? 0
  const localFiles = attachments.localFiles ?? 0
  const imageUrls = attachments.imageUrls?.filter((entry) => entry.trim().length > 0) ?? []
  const localImagePaths =
    attachments.localImagePaths?.filter((entry) => entry.trim().length > 0) ?? []
  const localFilePaths =
    attachments.localFilePaths?.filter((entry) => entry.trim().length > 0) ?? []

  if (
    webImages === 0 &&
    localImages === 0 &&
    localFiles === 0 &&
    imageUrls.length === 0 &&
    localImagePaths.length === 0 &&
    localFilePaths.length === 0
  ) {
    return null
  }

  return {
    webImages,
    localImages,
    localFiles,
    ...(imageUrls.length > 0 ? { imageUrls } : {}),
    ...(localImagePaths.length > 0 ? { localImagePaths } : {}),
    ...(localFilePaths.length > 0 ? { localFilePaths } : {}),
  }
}

function buildFollowUpText(input: PromptInput[]): string {
  return input
    .filter((entry): entry is Extract<PromptInput, { type: "text" }> => entry.type === "text")
    .map((entry) => entry.text.trim())
    .filter((entry) => entry.length > 0)
    .join("\n\n")
}

function buildFollowUpAttachmentsSignature(input: PromptInput[]): FollowUpAttachmentsSignature | null {
  let webImages = 0
  let localImages = 0
  let localFiles = 0
  const imageUrls: string[] = []
  const localImagePaths: string[] = []
  const localFilePaths: string[] = []

  for (const entry of input) {
    switch (entry.type) {
      case "text":
        break
      case "image":
        webImages += 1
        imageUrls.push(entry.url)
        break
      case "localImage":
        localImages += 1
        localImagePaths.push(entry.path)
        break
      case "localFile":
        localFiles += 1
        localFilePaths.push(entry.path)
        break
    }
  }

  return normalizeFollowUpAttachmentsSignature({
    webImages,
    localImages,
    localFiles,
    ...(imageUrls.length > 0 ? { imageUrls } : {}),
    ...(localImagePaths.length > 0 ? { localImagePaths } : {}),
    ...(localFilePaths.length > 0 ? { localFilePaths } : {}),
  })
}

function buildFollowUpSignature(text: string, attachments: FollowUpAttachmentsSignature | null): string {
  return JSON.stringify({
    text,
    attachments,
  })
}

export function buildFollowUpSignatureFromInput(input: PromptInput[]): string {
  return buildFollowUpSignature(
    buildFollowUpText(input),
    buildFollowUpAttachmentsSignature(input),
  )
}

function getUserMessageAttachmentsSignature(
  message: UIUserMessage,
): FollowUpAttachmentsSignature | null {
  return normalizeFollowUpAttachmentsSignature(message.attachments)
}

export function buildFollowUpSignatureFromRow(row: ThreadDetailRow): string | null {
  if (row.kind !== "message" || row.message.kind !== "user") {
    return null
  }

  return buildFollowUpSignature(
    row.message.text,
    getUserMessageAttachmentsSignature(row.message),
  )
}
