import type { BridgeSharePayload } from "@bb/mobile-bridge";

export interface NativeSharePayload {
  content:
    | { title?: string; url: string }
    | { title?: string; message: string };
  options: { dialogTitle: string; subject?: string };
}

export function buildBridgeSharePayload(
  platform: string,
  payload: BridgeSharePayload,
): NativeSharePayload {
  const title = payload.title?.trim();
  const text = payload.text?.trim() ?? "";
  const url = payload.url ?? "";
  const dialogTitle = title && title.length > 0 ? `Share ${title}` : "Share";
  if (platform === "ios" && url.length > 0 && text.length === 0) {
    return {
      content: { title, url },
      options: { dialogTitle, subject: title },
    };
  }
  const message = [text, url && url !== text ? url : ""]
    .filter((part) => part.length > 0)
    .join("\n\n");
  return {
    content: { title, message },
    options: { dialogTitle, subject: title },
  };
}
