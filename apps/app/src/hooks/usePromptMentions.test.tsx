// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { makeSystemConfig } from "@/test/fixtures/system-config";
import { usePromptMentions } from "./usePromptMentions";

vi.mock("@/lib/sdk", () => ({
  sdk: { system: { config: vi.fn() } },
}));

function responseJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function urlForFetchInput(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("usePromptMentions", () => {
  it("shows loading for a non-at plugin trigger while the query is debouncing", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue(makeSystemConfig());
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = urlForFetchInput(input);
      if (url === "/api/v1/plugins/contributions") {
        return Promise.resolve(
          responseJson({
            threadActions: [],
            mentionProviders: [
              {
                pluginId: "github",
                id: "issues",
                label: "GitHub issues",
                triggers: ["@", "#"],
              },
            ],
          }),
        );
      }
      if (url.startsWith("/api/v1/plugins/mentions/search?")) {
        return Promise.resolve(
          responseJson({
            ok: true,
            groups: [
              {
                pluginId: "github",
                providerId: "issues",
                label: "GitHub issues",
                items: [
                  {
                    itemId: "issue:owner/repo#42",
                    title: "#42 Fix login bug",
                    subtitle: "owner/repo",
                    icon: null,
                  },
                ],
              },
            ],
          }),
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        usePromptMentions("proj_1", {
          environmentId: null,
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.triggers).toEqual(["@", "#"]);
    });

    act(() => {
      result.current.setQuery("42", "#");
    });

    expect(result.current.isLoading).toBe(true);
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        urlForFetchInput(input).startsWith("/api/v1/plugins/mentions/search?"),
      ),
    ).toHaveLength(0);

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([input]) =>
          urlForFetchInput(input).startsWith(
            "/api/v1/plugins/mentions/search?",
          ),
        ),
      ).toHaveLength(1);
    });
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
      expect(result.current.results.suggestions).toHaveLength(1);
    });
  });
});
