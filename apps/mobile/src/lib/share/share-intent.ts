export type ShareIntentKind = "text" | "weburl" | "media" | "file";

export interface InboundShareIntent {
  type: ShareIntentKind;
  text?: string | null;
  webUrl?: string | null;
  files?:
    | readonly { path: string; mimeType: string; fileName?: string | null }[]
    | null;
}

export interface ShareIntentHookResult {
  hasShareIntent: boolean;
  shareIntent: InboundShareIntent;
  resetShareIntent: () => void;
  error: string | null;
}

export interface ShareIntentModule {
  useShareIntent: (options?: {
    debug?: boolean;
    resetOnBackground?: boolean;
  }) => ShareIntentHookResult;
}

function isShareIntentModule(value: unknown): value is ShareIntentModule {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { useShareIntent?: unknown }).useShareIntent === "function"
  );
}

let cached: ShareIntentModule | null | undefined;

export function loadShareIntentModule(): ShareIntentModule | null {
  if (cached !== undefined) return cached;
  try {
    const candidate: unknown = require("expo-share-intent");
    cached = isShareIntentModule(candidate) ? candidate : null;
  } catch {
    cached = null;
  }
  return cached;
}

export function composeSeedFromShareIntent(
  intent: InboundShareIntent,
): { initialPrompt: string } | null {
  const text = intent.text?.trim() ?? "";
  const url = intent.webUrl?.trim() ?? "";
  if (intent.type === "media" || intent.type === "file") {
    return null;
  }
  const parts = [text, url && url !== text ? url : ""].filter(
    (part) => part.length > 0,
  );
  if (parts.length === 0) return null;
  return { initialPrompt: parts.join("\n\n") };
}
