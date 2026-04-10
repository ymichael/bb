import type {
  ProviderUnhandledEvent,
} from "@bb/domain";

const HUMANIZED_EVENT_TOKEN_MAP: Record<string, string> = {
  api: "API",
  chatgpt: "ChatGPT",
  id: "ID",
  mcp: "MCP",
  oauth: "OAuth",
  sdk: "SDK",
  ui: "UI",
  url: "URL",
};

function splitCamelCaseToken(token: string): string[] {
  return token
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(" ")
    .filter((part) => part.length > 0);
}

function humanizeEventToken(token: string): string {
  const normalized = token.toLowerCase();
  const mapped = HUMANIZED_EVENT_TOKEN_MAP[normalized];
  if (mapped) {
    return mapped;
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function humanizeRawType(rawType: string): string {
  const tokens = rawType
    .split(/[:/._-]+/u)
    .flatMap((token) => splitCamelCaseToken(token))
    .filter((token) => token.length > 0);
  return tokens.map((token) => humanizeEventToken(token)).join(" ");
}

export function buildProviderUnhandledDetail(
  event: ProviderUnhandledEvent,
): string {
  return [
    humanizeRawType(event.rawType),
    `Raw event: ${event.rawType}`,
    "Payload:",
    JSON.stringify(event.rawEvent, null, 2),
  ].join("\n");
}
