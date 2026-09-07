import interWoff2 from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url";
import {
  createFileRoute,
  Outlet,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import type { ComponentProps } from "react";

import landingCss from "../landing/landing.css?url";
import marketplaceCss from "../marketplace/marketplace.css?url";
import {
  marketplaceIndexMeta,
  validateMarketplaceSearch,
} from "../marketplace/marketplace-route-data.js";
import { getPublicMarketplace } from "../marketplace/marketplace-server.js";
import {
  PublicMarketplaceNotFoundPage,
  PublicMarketplacePage,
  PublicMarketplaceUnavailablePage,
  MarketplaceNavigationProvider,
} from "../marketplace/public-marketplace.js";

export const Route = createFileRoute("/marketplace_")({
  validateSearch: validateMarketplaceSearch,
  loader: () => getPublicMarketplace(),
  head: ({ loaderData, match, matches }) => {
    const available = loaderData?.status === "available";
    const lastMatch = matches.at(-1);
    const isIndex = lastMatch?.routeId === match.routeId;
    const notFound = matches.some(
      (candidate) => candidate.status === "notFound",
    );
    const sharedLinks: Array<ComponentProps<"link">> = [
      {
        rel: "preload",
        href: interWoff2,
        as: "font",
        type: "font/woff2",
        crossOrigin: "anonymous",
      },
      { rel: "stylesheet", href: landingCss },
      { rel: "stylesheet", href: marketplaceCss },
    ];
    if (notFound) {
      return {
        meta: [
          { title: "Page not found — bb" },
          { name: "robots", content: "noindex" },
        ],
        links: sharedLinks,
      };
    }
    if (!isIndex) return { links: sharedLinks };
    return {
      meta: marketplaceIndexMeta(available),
      links: [
        ...sharedLinks,
        { rel: "canonical", href: "https://getbb.app/marketplace" },
      ],
    };
  },
  notFoundComponent: PublicMarketplaceNotFoundPage,
  component: MarketplaceRoute,
});

function MarketplaceRoute() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  const marketplace = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  return (
    <MarketplaceNavigationProvider
      navigate={(href) => void router.navigate({ href })}
    >
      {path !== "/marketplace" && path !== "/marketplace/" ? (
        <Outlet />
      ) : marketplace.status === "unavailable" ? (
        <PublicMarketplaceUnavailablePage />
      ) : (
        <PublicMarketplacePage
          manifest={marketplace.manifest}
          stats={marketplace.stats}
          state={{ category: search.category, sort: search.sort }}
          onStateChange={(next) =>
            void navigate({
              search: { category: next.category, sort: next.sort },
            })
          }
        />
      )}
    </MarketplaceNavigationProvider>
  );
}
