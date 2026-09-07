const MAX_LOCAL_PREVIEWS = 24;

const localPreviewUrlsByPath = new Map<string, string>();

function canCreateObjectUrls(): boolean {
  return (
    typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
  );
}

export function registerLocalAttachmentPreview(path: string, file: Blob): void {
  if (!canCreateObjectUrls() || !file.type.startsWith("image/")) {
    return;
  }
  const previous = localPreviewUrlsByPath.get(path);
  if (previous !== undefined) {
    URL.revokeObjectURL(previous);
    localPreviewUrlsByPath.delete(path);
  }
  localPreviewUrlsByPath.set(path, URL.createObjectURL(file));
  while (localPreviewUrlsByPath.size > MAX_LOCAL_PREVIEWS) {
    const oldest = localPreviewUrlsByPath.keys().next();
    if (oldest.done) {
      break;
    }
    releaseLocalAttachmentPreview(oldest.value);
  }
}

export function getLocalAttachmentPreviewSrc(path: string): string | null {
  return localPreviewUrlsByPath.get(path) ?? null;
}

export function releaseLocalAttachmentPreview(path: string): void {
  const url = localPreviewUrlsByPath.get(path);
  if (url === undefined) {
    return;
  }
  localPreviewUrlsByPath.delete(path);
  URL.revokeObjectURL(url);
}

export function clearLocalAttachmentPreviews(): void {
  for (const path of [...localPreviewUrlsByPath.keys()]) {
    releaseLocalAttachmentPreview(path);
  }
}
