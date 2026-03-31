const DEFAULT_MANAGER_WORKSPACE_MIME_TYPE = "application/octet-stream";
const textDecoder = new TextDecoder();

export type ManagerWorkspaceFileContentEncoding = "base64" | "utf8";

interface ManagerWorkspaceFilePreviewBase {
  kind: "image" | "text" | "unsupported";
  mimeType: string;
  path: string;
  sizeBytes: number;
}

export interface ManagerWorkspaceImagePreview extends ManagerWorkspaceFilePreviewBase {
  kind: "image";
  blob: Blob;
}

export interface ManagerWorkspaceTextPreview extends ManagerWorkspaceFilePreviewBase {
  kind: "text";
  content: string;
}

export interface ManagerWorkspaceUnsupportedPreview extends ManagerWorkspaceFilePreviewBase {
  kind: "unsupported";
}

export type ManagerWorkspaceFilePreview =
  | ManagerWorkspaceImagePreview
  | ManagerWorkspaceTextPreview
  | ManagerWorkspaceUnsupportedPreview;

export interface BuildManagerWorkspaceFilePreviewArgs {
  contentBytes: Uint8Array;
  contentEncoding?: ManagerWorkspaceFileContentEncoding;
  mimeType: string;
  path: string;
  sizeBytes: number;
}

function cloneManagerWorkspaceFileBytes(contentBytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(contentBytes).buffer;
}

export function normalizeManagerWorkspaceMimeType(value: string | null): string {
  const normalizedValue = value?.split(";")[0]?.trim().toLowerCase();
  return normalizedValue && normalizedValue.length > 0
    ? normalizedValue
    : DEFAULT_MANAGER_WORKSPACE_MIME_TYPE;
}

export function parseManagerWorkspaceContentEncodingHeader(
  value: string | null,
): ManagerWorkspaceFileContentEncoding | undefined {
  return value === "base64" || value === "utf8" ? value : undefined;
}

export function parseManagerWorkspaceSizeBytesHeader(
  value: string | null,
  fallbackSizeBytes: number,
): number {
  if (!value) {
    return fallbackSizeBytes;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallbackSizeBytes;
}

export function buildManagerWorkspaceFilePreview(
  args: BuildManagerWorkspaceFilePreviewArgs,
): ManagerWorkspaceFilePreview {
  if (args.mimeType.startsWith("image/")) {
    return {
      kind: "image",
      mimeType: args.mimeType,
      path: args.path,
      sizeBytes: args.sizeBytes,
      blob: new Blob([cloneManagerWorkspaceFileBytes(args.contentBytes)], {
        type: args.mimeType,
      }),
    };
  }

  if (args.contentEncoding === "utf8") {
    return {
      kind: "text",
      mimeType: args.mimeType,
      path: args.path,
      sizeBytes: args.sizeBytes,
      content: textDecoder.decode(args.contentBytes),
    };
  }

  return {
    kind: "unsupported",
    mimeType: args.mimeType,
    path: args.path,
    sizeBytes: args.sizeBytes,
  };
}
