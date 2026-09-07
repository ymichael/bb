import { createRouter } from "@tanstack/react-router";
import { stringifySiteSearch } from "./lib/search-serialization";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    stringifySearch: stringifySiteSearch,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
