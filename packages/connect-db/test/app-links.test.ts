import { describe, expect, it } from "vitest";
import {
  ANDROID_ASSET_LINKS_PATH,
  APPLE_APP_SITE_ASSOCIATION_PATH,
  BB_MOBILE_ANDROID_PACKAGE,
  BB_MOBILE_IOS_APP_ID,
  handleAppLinkAssociationRequest,
  parseAssetLinksFingerprints,
} from "../src/app-links.js";

describe("app link association files", () => {
  it("serves the AASA as application/json with the app id and path allowlist", async () => {
    const response = handleAppLinkAssociationRequest(
      {
        method: "GET",
        url: `https://sawyer.getbb.app${APPLE_APP_SITE_ASSOCIATION_PATH}`,
      },
      {},
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("application/json");
    const body = (await response?.json()) as {
      applinks: Record<string, unknown> & {
        details: Record<string, unknown>[];
      };
    };
    expect(body.applinks.details).toEqual([
      {
        appIDs: [BB_MOBILE_IOS_APP_ID],
        components: [
          { "/": "/threads/*" },
          { "/": "/projects/*" },
          { "/": "/settings/*" },
        ],
      },
    ]);
    expect(Object.keys(body.applinks)).toEqual(["details"]);
  });

  it("serves assetlinks.json with the fingerprints from the env (empty when unset)", async () => {
    const unset = handleAppLinkAssociationRequest(
      { method: "GET", url: `https://getbb.app${ANDROID_ASSET_LINKS_PATH}` },
      {},
    );
    const unsetBody = (await unset?.json()) as {
      target: { package_name: string; sha256_cert_fingerprints: string[] };
    }[];
    expect(unsetBody[0]?.target.package_name).toBe(BB_MOBILE_ANDROID_PACKAGE);
    expect(unsetBody[0]?.target.sha256_cert_fingerprints).toEqual([]);

    const set = handleAppLinkAssociationRequest(
      { method: "GET", url: `https://getbb.app${ANDROID_ASSET_LINKS_PATH}` },
      { ASSETLINKS_SHA256_FINGERPRINTS: "aa:bb:cc, dd:ee:ff\n11:22" },
    );
    const setBody = (await set?.json()) as {
      target: { sha256_cert_fingerprints: string[] };
    }[];
    expect(setBody[0]?.target.sha256_cert_fingerprints).toEqual([
      "AA:BB:CC",
      "DD:EE:FF",
      "11:22",
    ]);
    expect(parseAssetLinksFingerprints(undefined)).toEqual([]);
  });

  it("ignores other paths and refuses non-GET methods", () => {
    expect(
      handleAppLinkAssociationRequest(
        { method: "GET", url: "https://getbb.app/.well-known/other" },
        {},
      ),
    ).toBeNull();
    expect(
      handleAppLinkAssociationRequest(
        { method: "GET", url: "https://getbb.app/threads/x" },
        {},
      ),
    ).toBeNull();
    const post = handleAppLinkAssociationRequest(
      {
        method: "POST",
        url: `https://getbb.app${APPLE_APP_SITE_ASSOCIATION_PATH}`,
      },
      {},
    );
    expect(post?.status).toBe(405);
    const head = handleAppLinkAssociationRequest(
      {
        method: "HEAD",
        url: `https://getbb.app${APPLE_APP_SITE_ASSOCIATION_PATH}`,
      },
      {},
    );
    expect(head?.status).toBe(200);
    expect(head?.body).toBeNull();
  });
});
