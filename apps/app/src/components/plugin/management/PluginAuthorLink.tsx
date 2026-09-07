import { Link, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import type { PluginCatalogSearchEntry } from "@/hooks/queries/plugin-catalog-queries";
import { getPluginsRoutePath } from "@/lib/route-paths";
import { pluginMarketplaceAuthorKey } from "./plugin-marketplace-author";

export function pluginAuthorPageSearch(
  search: string,
  authorKey: string,
): string {
  const params = new URLSearchParams(search);
  params.delete("view");
  params.set("author", authorKey);
  const next = params.toString();
  return next === "" ? "" : `?${next}`;
}

export function PluginAuthorLink({
  entry,
  className,
  children,
}: {
  entry: Pick<PluginCatalogSearchEntry, "author" | "marketplace">;
  className?: string;
  children: ReactNode;
}) {
  const location = useLocation();
  const authorKey = pluginMarketplaceAuthorKey(entry);
  if (authorKey === null) return <>{children}</>;
  return (
    <Link
      to={{
        pathname: getPluginsRoutePath(),
        search: pluginAuthorPageSearch(location.search, authorKey),
      }}
      className={className}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </Link>
  );
}
