import { useAtom } from "jotai";
import { createBooleanPreferenceAtom } from "./browser-storage";

const OPEN_LINKS_IN_APP_BROWSER_STORAGE_KEY = "bb.openLinksInAppBrowser";

const OPEN_LINKS_IN_APP_BROWSER_DEFAULT = true;

type UrlOpenTarget = "in-app-browser" | "external-browser" | "unhandled";

interface ResolveUrlOpenTargetArgs {
  desktopBrowserAvailable: boolean;
  openLinksInAppBrowser: boolean;
  url: string;
}

interface OpenUrlByPreferenceArgs extends ResolveUrlOpenTargetArgs {
  openExternalBrowser: (url: string) => void;
  openInAppBrowser: (url: string) => void;
}

const HTTP_URL_SCHEME_PATTERN = /^https?:\/\//iu;

export function isHttpOrHttpsUrl(url: string): boolean {
  return HTTP_URL_SCHEME_PATTERN.test(url);
}

export function resolveUrlOpenTarget({
  desktopBrowserAvailable,
  openLinksInAppBrowser,
  url,
}: ResolveUrlOpenTargetArgs): UrlOpenTarget {
  if (!isHttpOrHttpsUrl(url)) {
    return "unhandled";
  }
  if (desktopBrowserAvailable && openLinksInAppBrowser) {
    return "in-app-browser";
  }
  return "external-browser";
}

export function openUrlByPreference({
  desktopBrowserAvailable,
  openExternalBrowser,
  openInAppBrowser,
  openLinksInAppBrowser,
  url,
}: OpenUrlByPreferenceArgs): boolean {
  const target = resolveUrlOpenTarget({
    desktopBrowserAvailable,
    openLinksInAppBrowser,
    url,
  });

  switch (target) {
    case "in-app-browser":
      openInAppBrowser(url);
      return true;
    case "external-browser":
      openExternalBrowser(url);
      return true;
    case "unhandled":
      return false;
  }
}

const openLinksInAppBrowserPreferenceAtom = createBooleanPreferenceAtom(
  OPEN_LINKS_IN_APP_BROWSER_STORAGE_KEY,
  OPEN_LINKS_IN_APP_BROWSER_DEFAULT,
);

export function useOpenLinksInAppBrowserPreference() {
  return useAtom(openLinksInAppBrowserPreferenceAtom);
}
