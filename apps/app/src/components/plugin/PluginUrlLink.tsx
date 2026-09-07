import { useCallback, type MouseEvent as ReactMouseEvent } from "react";
import type { UrlLinkProps } from "@get-bb/plugin-sdk";
import { RouteAnchor } from "@/components/ui/app-route-anchor";
import { useAppNavigationHost } from "@/lib/app-navigation-host";
import { resolveRouteHref } from "@/lib/route-paths";

function shouldHandleUrlClick(
  event: ReactMouseEvent<HTMLAnchorElement>,
): boolean {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.currentTarget.hasAttribute("download") ||
    event.currentTarget.hasAttribute("target")
  ) {
    return false;
  }
  return true;
}

function isCurrentAppRoute(href: string): boolean {
  return (
    typeof window !== "undefined" &&
    resolveRouteHref({ currentOrigin: window.location.origin, href }) !== null
  );
}

export function PluginUrlLink({
  href,
  onClick,
  rel,
  target,
  ...anchorProps
}: UrlLinkProps) {
  const navigation = useAppNavigationHost();
  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (
        !shouldHandleUrlClick(event) ||
        isCurrentAppRoute(href) ||
        !navigation.openUrl({ url: href })
      ) {
        return;
      }
      event.preventDefault();
    },
    [href, navigation, onClick],
  );
  const normalizedTarget = target?.toLowerCase();
  const opensNewBrowsingContext =
    normalizedTarget !== undefined &&
    normalizedTarget !== "" &&
    normalizedTarget !== "_self" &&
    normalizedTarget !== "_parent" &&
    normalizedTarget !== "_top" &&
    normalizedTarget !== "_unfencedtop";
  const relTokens = rel?.split(/\s+/u).filter(Boolean) ?? [];
  const normalizedRelTokens = relTokens.map((token) => token.toLowerCase());
  const resolvedRel =
    opensNewBrowsingContext && !normalizedRelTokens.includes("opener")
      ? [
          ...relTokens,
          ...(normalizedRelTokens.includes("noopener") ? [] : ["noopener"]),
          ...(normalizedRelTokens.includes("noreferrer") ? [] : ["noreferrer"]),
        ].join(" ")
      : rel;
  if (target !== undefined) {
    return (
      <a
        {...anchorProps}
        href={href}
        target={target}
        rel={resolvedRel}
        onClick={handleClick}
      />
    );
  }
  return (
    <RouteAnchor
      {...anchorProps}
      href={href}
      rel={resolvedRel}
      onClick={handleClick}
    />
  );
}
