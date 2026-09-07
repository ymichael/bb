import { Platform, Share } from "react-native";

export interface ThreadShareContent {
  title: string;
  url: string;
}

export interface SharePayload {
  content: { title: string; url: string } | { title: string; message: string };
  options: { dialogTitle: string; subject: string };
}

function buildSharePayload(
  platform: "ios" | "android" | "web" | "windows" | "macos",
  { title, url }: ThreadShareContent,
): SharePayload {
  const label = title.trim().length > 0 ? title.trim() : "bb thread";
  return {
    content:
      platform === "ios"
        ? { title: label, url }
        : { title: label, message: url },
    options: { dialogTitle: `Share ${label}`, subject: label },
  };
}

export type ShareOutcome = "shared" | "dismissed";

export async function shareThreadLink(
  content: ThreadShareContent,
): Promise<ShareOutcome> {
  const payload = buildSharePayload(Platform.OS, content);
  const result = await Share.share(payload.content, payload.options);
  return result.action === Share.dismissedAction ? "dismissed" : "shared";
}
