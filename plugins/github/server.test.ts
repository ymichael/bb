import { describe, expect, expectTypeOf, it } from "vitest";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import type { PluginRpcClient, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  fetchRepoItems,
  githubRpcContract,
  parseExtraRepos,
  parsePaginatedGhApi,
  validateGithubCliArgs,
} from "./server";

type GithubRpcHandlers = PluginRpcHandlers<typeof githubRpcContract>;

function assertGithubFrontendInference(
  client: PluginRpcClient<typeof githubRpcContract>,
) {
  expectTypeOf(
    client.call("getPull", { repo: "get-bb/bb", number: 694 }),
  ).toEqualTypeOf<
    Promise<{
      pull: {
        repo: string;
        number: number;
        title: string;
        state: string;
        author: string;
        body: string;
        url: string;
        createdAt: string;
        updatedAt: string;
        baseRefName: string;
        headRefName: string;
        additions: number;
        deletions: number;
        changedFiles: number;
        labels: string[];
        assignees: string[];
        reviewDecision: string;
        mergeStateStatus: string;
        reviewRequests: string[];
        checks: Array<{
          name: string;
          status: "success" | "failure" | "pending" | "neutral";
          url: string;
        }>;
        comments: Array<{ author: string; body: string; createdAt: string }>;
        reviews: Array<{
          author: string;
          state: string;
          body: string;
          createdAt: string;
        }>;
        reviewThreads: Array<{
          path: string;
          line: number | null;
          diffHunk: string;
          comments: Array<{
            author: string;
            body: string;
            createdAt: string;
          }>;
        }>;
        files: Array<{
          path: string;
          status: string;
          additions: number;
          deletions: number;
          patch: string | null;
        }>;
      };
    }>
  >();

  // @ts-expect-error issue numbers must be numeric.
  void client.call("getIssue", { repo: "get-bb/bb", number: "694" });
  // @ts-expect-error unknown filter values are rejected by the contract.
  void client.call("listItems", { kind: "discussion" });
}

describe("GitHub RPC contract", () => {
  it("keeps pull requests when a repository has GitHub Issues disabled", async () => {
    const calls: string[][] = [];
    const openPulls = JSON.stringify([
      {
        number: 17,
        title: "Keep syncing pull requests",
        state: "OPEN",
        author: { login: "octocat" },
        labels: [{ name: "bug" }],
        assignees: [],
        url: "https://github.com/acme/widgets/pull/17",
        body: "",
        updatedAt: "2026-08-10T00:00:00Z",
      },
    ]);

    const items = await fetchRepoItems(async (args) => {
      calls.push(args);
      if (args[0] === "issue") {
        throw new Error(
          "gh issue list failed: the 'acme/widgets' repository has disabled Issues",
        );
      }
      return args.includes("open") ? openPulls : "[]";
    }, "acme/widgets");

    expect(calls).toHaveLength(4);
    expect(calls.filter(([kind]) => kind === "pr")).toHaveLength(2);
    expect(items).toEqual([
      expect.objectContaining({
        repo: "acme/widgets",
        number: 17,
        kind: "pr",
        title: "Keep syncing pull requests",
      }),
    ]);
  });

  it("flattens every paginated GitHub API page", () => {
    expect(
      parsePaginatedGhApi(
        JSON.stringify([[{ id: 1 }, { id: 2 }], [{ id: 3 }]]),
      ),
    ).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);

    expect(() => parsePaginatedGhApi(JSON.stringify([{ id: 1 }]))).toThrow(
      "malformed page",
    );
  });

  it("separates usable extraRepos entries from ones it cannot honor", () => {
    expect(parseExtraRepos("get-bb/bb, nonsense")).toEqual({
      repos: ["get-bb/bb"],
      ignored: ["nonsense"],
    });
    expect(parseExtraRepos("SOME-ORG/*")).toEqual({
      repos: [],
      ignored: ["SOME-ORG/*"],
    });
    expect(parseExtraRepos("")).toEqual({ repos: [], ignored: [] });
    expect(parseExtraRepos("  ,, \n ")).toEqual({ repos: [], ignored: [] });
    expect(parseExtraRepos(" acme/one\nacme/two , acme/one ")).toEqual({
      repos: ["acme/one", "acme/two"],
      ignored: [],
    });
    expect(parseExtraRepos("bad/repo/shape acme").ignored).toEqual([
      "bad/repo/shape",
      "acme",
    ]);
  });

  it("rejects CLI arguments that would otherwise broaden a repository query", () => {
    expect(validateGithubCliArgs(["issues", "get-bb/bb"])).toBeNull();
    expect(validateGithubCliArgs(["issues", "bad/repo/shape"])).toContain(
      "expected owner/repo",
    );
    expect(validateGithubCliArgs(["prs", "get-bb/bb", "extra"])).toContain(
      "Unexpected argument",
    );
    expect(validateGithubCliArgs(["repos", "--json"])).toContain(
      "does not accept arguments",
    );
  });

  it("infers parsed handler inputs and frontend results", () => {
    expectTypeOf<
      Parameters<GithubRpcHandlers["createIssue"]>[0]
    >().toEqualTypeOf<{
      repo: string;
      title: string;
      body?: string;
    }>();
    expectTypeOf(assertGithubFrontendInference).toBeFunction();
  });

  it("rejects invalid method inputs and outputs at runtime", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "github-contract",
    });
    const contract = defineRpcContract({
      startWork: githubRpcContract.startWork,
    });
    bb.rpc.register(contract, {
      startWork() {
        return { threadId: "" };
      },
    });

    await expect(
      harness.callRpc("startWork", {
        repo: "not-a-repository",
        number: 0,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      harness.callRpc("startWork", { repo: "get-bb/bb", number: 694 }),
    ).rejects.toMatchObject({ code: "invalid_output" });
  });
});
