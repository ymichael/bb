import {
  DOWNLOAD_MACOS_FALLBACK_URL,
  DOWNLOAD_MACOS_RELEASE_ASSET_BASE_URL,
  DOWNLOAD_MACOS_VERSION_FEED_URL,
} from "./site";
import type { CtaPlacement } from "./site";

const POSTHOG_CAPTURE_URL = "https://us.i.posthog.com/capture/?ip=0";
const DOWNLOAD_EVENT_NAME = "landing_download_macos_clicked";
const DOWNLOAD_TARGET = "macos";
const TRACKING_SOURCE = "landing_worker_redirect";
const MAX_URL_PROPERTY_LENGTH = 2048;
const RESEND_CONTACTS_URL = "https://api.resend.com/audiences";
const MAX_EMAIL_LENGTH = 254;
const MACOS_INSTALLER_EXTENSION = ".dmg";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type DownloadPlacement = CtaPlacement | "direct";

type MarketingEnv = {
  LANDING_POSTHOG_KEY?: string;
  RESEND_API_KEY?: string;
  RESEND_AUDIENCE_ID?: string;
};

type DownloadEventProperties = {
  $current_url: string;
  $referrer?: string;
  download_target: typeof DOWNLOAD_TARGET;
  placement: DownloadPlacement;
  tracking_source: typeof TRACKING_SOURCE;
  utm_campaign?: string;
  utm_content?: string;
  utm_medium?: string;
  utm_source?: string;
  utm_term?: string;
};

type PostHogCapturePayload = {
  api_key: string;
  distinct_id: string;
  event: typeof DOWNLOAD_EVENT_NAME;
  properties: DownloadEventProperties;
  timestamp: string;
};

type TrackDownloadClickArgs = {
  postHogKey: string | undefined;
  request: Request;
  requestUrl: URL;
};

export async function handleDownloadMacos(
  request: Request,
  env: MarketingEnv,
  waitUntil: (promise: Promise<void>) => void,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  waitUntil(
    trackDownloadClick({
      postHogKey: env.LANDING_POSTHOG_KEY,
      request,
      requestUrl,
    }),
  );
  const location = await resolveMacosDownloadUrl();
  return redirectResponse(location);
}

function jsonResponse(body: object, status: number): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "Cache-Control": "no-store",
      "content-type": "application/json",
    },
    status,
  });
}

export async function handleSubscribe(
  request: Request,
  env: MarketingEnv,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }
  if (!env.RESEND_API_KEY || !env.RESEND_AUDIENCE_ID) {
    return jsonResponse({ error: "Email signup is not configured." }, 503);
  }

  const email = await readEmail(request);
  if (!email) {
    return jsonResponse({ error: "Enter a valid email address." }, 400);
  }

  let resendResponse: Response;
  try {
    resendResponse = await fetch(
      `${RESEND_CONTACTS_URL}/${env.RESEND_AUDIENCE_ID}/contacts`,
      {
        body: JSON.stringify({ email, unsubscribed: false }),
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "content-type": "application/json",
        },
        method: "POST",
      },
    );
  } catch {
    return jsonResponse({ error: "Could not reach the signup service." }, 502);
  }

  if (resendResponse.ok || (await isAlreadySubscribed(resendResponse))) {
    return jsonResponse({ ok: true }, 200);
  }
  return jsonResponse({ error: "Could not add you to the list." }, 502);
}

async function readEmail(request: Request): Promise<string | null> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const value = (payload as { email?: unknown }).email;
  if (typeof value !== "string") {
    return null;
  }
  const email = value.trim();
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    return null;
  }
  return email;
}

async function isAlreadySubscribed(response: Response): Promise<boolean> {
  if (response.status !== 409 && response.status !== 422) {
    return false;
  }
  const body = await response.text();
  return /already/i.test(body);
}

function redirectResponse(location: string): Response {
  return new Response(null, {
    headers: {
      "Cache-Control": "no-store",
      Location: location,
    },
    status: 302,
  });
}

async function resolveMacosDownloadUrl(): Promise<string> {
  try {
    const response = await fetch(DOWNLOAD_MACOS_VERSION_FEED_URL, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return DOWNLOAD_MACOS_FALLBACK_URL;
    }

    const assetName = findMacosInstallerAssetName(await response.json());
    if (!assetName) {
      return DOWNLOAD_MACOS_FALLBACK_URL;
    }

    return `${DOWNLOAD_MACOS_RELEASE_ASSET_BASE_URL}/${encodeURIComponent(assetName)}`;
  } catch {
    return DOWNLOAD_MACOS_FALLBACK_URL;
  }
}

function findMacosInstallerAssetName(feed: unknown): string | null {
  if (!isRecord(feed) || !Array.isArray(feed.files)) {
    return null;
  }

  for (const file of feed.files) {
    if (!isRecord(file) || typeof file.url !== "string") {
      continue;
    }
    if (isMacosInstallerAssetName(file.url)) {
      return file.url;
    }
  }
  return null;
}

function isMacosInstallerAssetName(value: string): boolean {
  return (
    value.length > MACOS_INSTALLER_EXTENSION.length &&
    value.endsWith(MACOS_INSTALLER_EXTENSION) &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function trackDownloadClick(args: TrackDownloadClickArgs): Promise<void> {
  if (!args.postHogKey) {
    return;
  }

  const payload: PostHogCapturePayload = {
    api_key: args.postHogKey,
    distinct_id: crypto.randomUUID(),
    event: DOWNLOAD_EVENT_NAME,
    properties: buildDownloadEventProperties({
      request: args.request,
      requestUrl: args.requestUrl,
    }),
    timestamp: new Date().toISOString(),
  };

  await fetch(POSTHOG_CAPTURE_URL, {
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).catch(() => {});
}

type BuildDownloadEventPropertiesArgs = {
  request: Request;
  requestUrl: URL;
};

function buildDownloadEventProperties(
  args: BuildDownloadEventPropertiesArgs,
): DownloadEventProperties {
  const referrer = args.request.headers.get("referer");
  const referrerSearchParams = readReferrerSearchParams(referrer);
  const properties: DownloadEventProperties = {
    $current_url: truncateProperty(args.requestUrl.href),
    download_target: DOWNLOAD_TARGET,
    placement: parseDownloadPlacement(args.requestUrl.searchParams),
    tracking_source: TRACKING_SOURCE,
  };

  if (referrer) {
    properties.$referrer = truncateProperty(referrer);
  }

  addUtmProperties({
    properties,
    referrerSearchParams,
    requestSearchParams: args.requestUrl.searchParams,
  });

  return properties;
}

function parseDownloadPlacement(
  searchParams: URLSearchParams,
): DownloadPlacement {
  switch (searchParams.get("placement")) {
    case "nav":
      return "nav";
    case "hero":
      return "hero";
    case "closer":
      return "closer";
    case "footer":
      return "footer";
    default:
      return "direct";
  }
}

function readReferrerSearchParams(
  referrer: string | null,
): URLSearchParams | null {
  if (!referrer) {
    return null;
  }

  try {
    return new URL(referrer).searchParams;
  } catch {
    return null;
  }
}

type AddUtmPropertiesArgs = {
  properties: DownloadEventProperties;
  referrerSearchParams: URLSearchParams | null;
  requestSearchParams: URLSearchParams;
};

function addUtmProperties(args: AddUtmPropertiesArgs): void {
  const source = getTrackingParam({
    name: "utm_source",
    referrerSearchParams: args.referrerSearchParams,
    requestSearchParams: args.requestSearchParams,
  });
  const medium = getTrackingParam({
    name: "utm_medium",
    referrerSearchParams: args.referrerSearchParams,
    requestSearchParams: args.requestSearchParams,
  });
  const campaign = getTrackingParam({
    name: "utm_campaign",
    referrerSearchParams: args.referrerSearchParams,
    requestSearchParams: args.requestSearchParams,
  });
  const term = getTrackingParam({
    name: "utm_term",
    referrerSearchParams: args.referrerSearchParams,
    requestSearchParams: args.requestSearchParams,
  });
  const content = getTrackingParam({
    name: "utm_content",
    referrerSearchParams: args.referrerSearchParams,
    requestSearchParams: args.requestSearchParams,
  });

  if (source) {
    args.properties.utm_source = source;
  }
  if (medium) {
    args.properties.utm_medium = medium;
  }
  if (campaign) {
    args.properties.utm_campaign = campaign;
  }
  if (term) {
    args.properties.utm_term = term;
  }
  if (content) {
    args.properties.utm_content = content;
  }
}

type GetTrackingParamArgs = {
  name: string;
  referrerSearchParams: URLSearchParams | null;
  requestSearchParams: URLSearchParams;
};

function getTrackingParam(args: GetTrackingParamArgs): string | undefined {
  return (
    getNonEmptySearchParam(args.requestSearchParams, args.name) ??
    getNonEmptySearchParam(args.referrerSearchParams, args.name)
  );
}

function getNonEmptySearchParam(
  searchParams: URLSearchParams | null,
  name: string,
): string | undefined {
  const value = searchParams?.get(name);
  if (!value) {
    return undefined;
  }

  return truncateProperty(value);
}

function truncateProperty(value: string): string {
  if (value.length <= MAX_URL_PROPERTY_LENGTH) {
    return value;
  }

  return value.slice(0, MAX_URL_PROPERTY_LENGTH);
}
