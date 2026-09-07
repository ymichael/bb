export const BB_MOBILE_IOS_APP_ID = "9QCU24SXK5.app.getbb.mobile";
export const BB_MOBILE_ANDROID_PACKAGE = "app.getbb.mobile";

const BB_MOBILE_APP_LINK_PATHS: readonly string[] = [
  "/threads/*",
  "/projects/*",
  "/settings/*",
];

export const APPLE_APP_SITE_ASSOCIATION_PATH =
  "/.well-known/apple-app-site-association";
export const ANDROID_ASSET_LINKS_PATH = "/.well-known/assetlinks.json";

function buildAppleAppSiteAssociation(): Record<string, unknown> {
  return {
    applinks: {
      details: [
        {
          appIDs: [BB_MOBILE_IOS_APP_ID],
          components: BB_MOBILE_APP_LINK_PATHS.map((path) => ({
            "/": path,
          })),
        },
      ],
    },
  };
}

export function parseAssetLinksFingerprints(
  value: string | undefined | null,
): string[] {
  if (!value) return [];
  return value
    .split(/[\s,]+/u)
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry) => entry.length > 0);
}

function buildAndroidAssetLinks(
  sha256CertFingerprints: readonly string[],
): unknown[] {
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: BB_MOBILE_ANDROID_PACKAGE,
        sha256_cert_fingerprints: [...sha256CertFingerprints],
      },
    },
  ];
}

export function handleAppLinkAssociationRequest(
  request: { method: string; url: string },
  env: { ASSETLINKS_SHA256_FINGERPRINTS?: string },
): Response | null {
  const { pathname } = new URL(request.url);
  let body: unknown;
  if (pathname === APPLE_APP_SITE_ASSOCIATION_PATH) {
    body = buildAppleAppSiteAssociation();
  } else if (pathname === ANDROID_ASSET_LINKS_PATH) {
    body = buildAndroidAssetLinks(
      parseAssetLinksFingerprints(env.ASSETLINKS_SHA256_FINGERPRINTS),
    );
  } else {
    return null;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed\n", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }
  return new Response(request.method === "HEAD" ? null : JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=3600",
    },
  });
}
