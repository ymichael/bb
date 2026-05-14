import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGithubBranches } from "../../src/services/github/branches.js";

type FetchInput = Parameters<typeof fetch>[0];
type GithubJsonBody = object | object[];

interface GithubJsonResponseArgs {
  body: GithubJsonBody;
  status?: number;
}

interface StubGithubFetchArgs {
  branches: GithubJsonBody;
  repo: GithubJsonBody;
  branchesStatus?: number;
  repoStatus?: number;
}

function jsonResponse(args: GithubJsonResponseArgs): Response {
  return new Response(JSON.stringify(args.body), {
    status: args.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function toRequestUrl(input: FetchInput): URL {
  if (typeof input === "string" || input instanceof URL) {
    return new URL(input);
  }
  return new URL(input.url);
}

function expectBranchesRequest(url: URL): void {
  const entries = Array.from(url.searchParams.entries());
  if (
    entries.length !== 1 ||
    entries[0]?.[0] !== "per_page" ||
    entries[0]?.[1] !== "100"
  ) {
    throw new Error(`Unexpected GitHub branches query: ${url.toString()}`);
  }
}

function stubGithubFetch(args: StubGithubFetchArgs) {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = toRequestUrl(input);
    if (
      url.origin === "https://api.github.com" &&
      url.pathname === "/repos/acme/widget/branches"
    ) {
      expectBranchesRequest(url);
      return jsonResponse({
        body: args.branches,
        status: args.branchesStatus,
      });
    }
    if (
      url.origin === "https://api.github.com" &&
      url.pathname === "/repos/acme/widget" &&
      url.search === ""
    ) {
      return jsonResponse({
        body: args.repo,
        status: args.repoStatus,
      });
    }
    throw new Error(`Unexpected GitHub request: ${url.toString()}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchGithubBranches", () => {
  it("pins the default branch first and dedupes it from the branch list", async () => {
    const fetchMock = stubGithubFetch({
      branches: [
        { name: "develop" },
        { name: "main" },
        { name: "release/1.2" },
      ],
      repo: { default_branch: "main" },
    });

    await expect(
      fetchGithubBranches("ghp_test", "https://github.com/acme/widget"),
    ).resolves.toEqual({
      branches: ["main", "develop", "release/1.2"],
      current: null,
      defaultBranch: "main",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns the default branch even when GitHub omits it from the listed page", async () => {
    stubGithubFetch({
      branches: [{ name: "develop" }, { name: "release/1.2" }],
      repo: { default_branch: "main" },
    });

    await expect(
      fetchGithubBranches("ghp_test", "https://github.com/acme/widget"),
    ).resolves.toEqual({
      branches: ["develop", "release/1.2"],
      current: null,
      defaultBranch: "main",
    });
  });

  it("maps missing GitHub repos to a 404 API error", async () => {
    stubGithubFetch({
      branches: [],
      repo: {},
      branchesStatus: 404,
      repoStatus: 404,
    });

    await expect(
      fetchGithubBranches("ghp_test", "https://github.com/acme/widget"),
    ).rejects.toMatchObject({
      status: 404,
      body: { code: "invalid_request" },
    });
  });

  it("maps GitHub API failures to a 502 API error", async () => {
    stubGithubFetch({
      branches: [],
      repo: { default_branch: "main" },
      branchesStatus: 503,
    });

    await expect(
      fetchGithubBranches("ghp_test", "https://github.com/acme/widget"),
    ).rejects.toMatchObject({
      status: 502,
      body: { code: "upstream_error" },
    });
  });

  it("maps network failures to a 502 API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new TypeError("network down");
      }),
    );

    await expect(
      fetchGithubBranches("ghp_test", "https://github.com/acme/widget"),
    ).rejects.toMatchObject({
      status: 502,
      body: {
        code: "upstream_error",
        message: "GitHub API request failed: network down",
      },
    });
  });
});
