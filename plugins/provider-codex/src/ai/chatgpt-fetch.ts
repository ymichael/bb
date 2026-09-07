const ALLOWED_CLOUDFLARE_COOKIE_NAMES = new Set([
  "__cf_bm",
  "__cflb",
  "__cfruid",
  "__cfseq",
  "__cfwaitingroom",
  "_cfuvid",
  "cf_clearance",
  "cf_ob_info",
  "cf_use_ob",
]);

const cloudflareCookiesByName = new Map<string, string>();

export interface ChatGptFetchArgs {
  url: string;
  init: (headers: Headers) => RequestInit;
}

function isAllowedChatGptHost(host: string): boolean {
  return (
    host === "chatgpt.com" ||
    host === "chat.openai.com" ||
    host === "chatgpt-staging.com" ||
    host.endsWith(".chatgpt.com") ||
    host.endsWith(".chatgpt-staging.com")
  );
}

function isAllowedChatGptUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && isAllowedChatGptHost(parsed.host);
  } catch {
    return false;
  }
}

function isAllowedCloudflareCookieName(name: string): boolean {
  return (
    ALLOWED_CLOUDFLARE_COOKIE_NAMES.has(name) || name.startsWith("cf_chl_")
  );
}

function splitSetCookieHeader(header: string): string[] {
  return header
    .split(/,(?=\s*[^;,=\s]+=[^;,]*)/u)
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie.length > 0);
}

function parseCookieNameValue(setCookie: string): string | null {
  const [nameValue] = setCookie.split(";", 1);
  if (!nameValue) {
    return null;
  }
  const [name] = nameValue.split("=", 1);
  const trimmedName = name?.trim();
  if (!trimmedName || !isAllowedCloudflareCookieName(trimmedName)) {
    return null;
  }
  return nameValue.trim();
}

function storeChatGptCloudflareCookies(url: string, headers: Headers): void {
  if (!isAllowedChatGptUrl(url)) {
    return;
  }

  const setCookie = headers.get("set-cookie");
  if (!setCookie) {
    return;
  }

  for (const cookie of splitSetCookieHeader(setCookie)) {
    const nameValue = parseCookieNameValue(cookie);
    if (!nameValue) {
      continue;
    }
    const [name] = nameValue.split("=", 1);
    if (name) {
      cloudflareCookiesByName.set(name, nameValue);
    }
  }
}

function getChatGptCloudflareCookieHeader(url: string): string | null {
  if (!isAllowedChatGptUrl(url) || cloudflareCookiesByName.size === 0) {
    return null;
  }
  return [...cloudflareCookiesByName.values()].join("; ");
}

export function isCloudflareChallenge(response: Response): boolean {
  return (
    response.status === 403 &&
    response.headers.get("cf-mitigated")?.toLowerCase() === "challenge"
  );
}

export async function fetchChatGpt(args: ChatGptFetchArgs): Promise<Response> {
  const fetchOnce = async (): Promise<Response> => {
    const headers = new Headers();
    const cookie = getChatGptCloudflareCookieHeader(args.url);
    if (cookie) {
      headers.set("Cookie", cookie);
    }
    const init = args.init(headers);
    const response = await fetch(args.url, init);
    storeChatGptCloudflareCookies(args.url, response.headers);
    return response;
  };

  const response = await fetchOnce();
  if (!isCloudflareChallenge(response)) {
    return response;
  }
  return fetchOnce();
}

export function resetChatGptCloudflareCookiesForTests(): void {
  cloudflareCookiesByName.clear();
}
