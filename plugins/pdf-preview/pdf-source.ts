import type { PluginFileOpenerSource } from "@get-bb/plugin-sdk/app";

const PDF_MIME_TYPE = "application/pdf";

type PdfReadTarget =
  | { kind: "raw"; url: string }
  | { kind: "workspace-json"; url: string };

interface EnvironmentFileResponse {
  content: string;
  contentEncoding: "base64" | "utf8";
  mimeType: string;
}

function encodePathSegments(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function queryUrl(path: string, values: Record<string, string>): string {
  return `${path}?${new URLSearchParams(values).toString()}`;
}

export function resolvePdfReadTarget(
  path: string,
  source: PluginFileOpenerSource,
): PdfReadTarget | null {
  switch (source.kind) {
    case "workspace":
      if (source.threadId !== null) {
        return {
          kind: "raw",
          url: `/api/v1/threads/${encodeURIComponent(source.threadId)}/worktree/files/${encodePathSegments(path)}`,
        };
      }
      if (source.environmentId !== null) {
        return {
          kind: "workspace-json",
          url: queryUrl(
            `/api/v1/environments/${encodeURIComponent(source.environmentId)}/diff/file`,
            { target: "uncommitted", path, side: "new" },
          ),
        };
      }
      if (source.projectId !== null) {
        return {
          kind: "raw",
          url: queryUrl(
            `/api/v1/projects/${encodeURIComponent(source.projectId)}/files/content`,
            {
              path,
              ...(source.experimental_hostId
                ? { hostId: source.experimental_hostId }
                : {}),
            },
          ),
        };
      }
      return null;
    case "host":
      return source.threadId === null
        ? null
        : {
            kind: "raw",
            url: queryUrl(
              `/api/v1/threads/${encodeURIComponent(source.threadId)}/host-files/content`,
              { path },
            ),
          };
    case "thread-storage":
      return source.threadId === null
        ? null
        : {
            kind: "raw",
            url: `/api/v1/threads/${encodeURIComponent(source.threadId)}/thread-storage/files/${encodePathSegments(path)}`,
          };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMimeType(value: string): string {
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

function requirePdfMimeType(value: string | null): void {
  if (value === null || normalizeMimeType(value) !== PDF_MIME_TYPE) {
    throw new Error("The file response was not a PDF.");
  }
}

function parseEnvironmentFileResponse(value: unknown): EnvironmentFileResponse {
  if (!isRecord(value)) {
    throw new Error("The workspace returned an invalid file response.");
  }
  const { content, contentEncoding, mimeType } = value;
  if (
    typeof content !== "string" ||
    (contentEncoding !== "base64" && contentEncoding !== "utf8") ||
    typeof mimeType !== "string"
  ) {
    throw new Error("The workspace returned an invalid file response.");
  }
  requirePdfMimeType(mimeType);
  return { content, contentEncoding, mimeType };
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function requireOk(response: Response): Promise<Response> {
  if (!response.ok) {
    throw new Error(`PDF request failed with status ${response.status}.`);
  }
  return response;
}

export async function loadPdfBlob(
  target: PdfReadTarget,
  signal: AbortSignal,
): Promise<Blob> {
  const response = await requireOk(
    await fetch(target.url, { credentials: "same-origin", signal }),
  );

  if (target.kind === "raw") {
    requirePdfMimeType(response.headers.get("content-type"));
    return response.blob();
  }

  const file = parseEnvironmentFileResponse(await response.json());
  const bytes =
    file.contentEncoding === "base64"
      ? decodeBase64(file.content)
      : new TextEncoder().encode(file.content);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], { type: PDF_MIME_TYPE });
}
