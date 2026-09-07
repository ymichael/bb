// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import type { SidebarBootstrapResponse } from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import { sidebarNavigationQueryKey } from "@/hooks/queries/query-keys";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";

const readCachedSidebarBootstrap = vi.fn<() => SidebarBootstrapResponse | null>(
  () => null,
);

vi.mock("@/lib/sidebar-bootstrap-cache", () => ({
  readCachedSidebarBootstrap: () => readCachedSidebarBootstrap(),
}));

const { findSidebarNavigationThreadPlaceholder } =
  await import("./query-cache");

const PROJECT_ID = "proj_bb";

function bootstrap(threadIds: string[]): SidebarBootstrapResponse {
  return makeSidebarBootstrapResponse({
    projects: [
      makeProjectWithThreadsResponse({
        id: PROJECT_ID,
        threads: threadIds.map((id) =>
          makeThreadListEntry({ id, projectId: PROJECT_ID }),
        ),
      }),
    ],
  });
}

afterEach(() => {
  readCachedSidebarBootstrap.mockReset();
  readCachedSidebarBootstrap.mockReturnValue(null);
});

describe("findSidebarNavigationThreadPlaceholder", () => {
  it("resolves from the live sidebar navigation cache without touching storage", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      bootstrap(["thr_live"]),
    );

    expect(
      findSidebarNavigationThreadPlaceholder(queryClient, "thr_live")?.id,
    ).toBe("thr_live");
    expect(readCachedSidebarBootstrap).not.toHaveBeenCalled();
  });

  it("falls back to the persisted bootstrap so a cold boot still resolves", () => {
    readCachedSidebarBootstrap.mockReturnValue(bootstrap(["thr_persisted"]));

    expect(
      findSidebarNavigationThreadPlaceholder(new QueryClient(), "thr_persisted")
        ?.id,
    ).toBe("thr_persisted");
    expect(readCachedSidebarBootstrap).toHaveBeenCalled();
  });

  it("returns nothing for an unknown or empty thread id", () => {
    readCachedSidebarBootstrap.mockReturnValue(bootstrap(["thr_live"]));
    const queryClient = new QueryClient();

    expect(
      findSidebarNavigationThreadPlaceholder(queryClient, "thr_missing"),
    ).toBeUndefined();
    expect(
      findSidebarNavigationThreadPlaceholder(queryClient, ""),
    ).toBeUndefined();
  });
});
