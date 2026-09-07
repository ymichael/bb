import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

let binDir: string;
let callLog: string;
const originalPath = process.env.PATH;

function ghCalls(): string[] {
  if (!existsSync(callLog)) return [];
  return readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean);
}

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "bb-github-rpc-"));
  callLog = join(binDir, "gh-calls.log");
  const openIssue = JSON.stringify([
    {
      number: 7,
      title: "Cache mutations",
      state: "OPEN",
      author: { login: "alice" },
      labels: [{ name: "bug" }, { name: "old" }],
      assignees: [{ login: "octocat" }],
      url: "https://github.com/acme/widgets/issues/7",
      body: "Keep the cache synchronized.",
      updatedAt: "2026-08-19T12:00:00Z",
    },
  ]);
  const openPull = JSON.stringify([
    {
      number: 42,
      title: "Normalize pull details",
      state: "OPEN",
      author: { login: "bob" },
      labels: [{ name: "enhancement" }],
      assignees: [],
      url: "https://github.com/acme/widgets/pull/42",
      body: "Normalize every GitHub shape.",
      updatedAt: "2026-08-19T13:00:00Z",
    },
  ]);
  const issueDetail = JSON.stringify({
    number: 7,
    title: "Cache mutations",
    state: "OPEN",
    author: { login: "alice" },
    labels: [{ name: "bug" }],
    assignees: [{ login: "octocat" }],
    url: "https://github.com/acme/widgets/issues/7",
    body: "Live issue body.",
    updatedAt: "2026-08-19T12:00:00Z",
    comments: [],
  });
  const pullDetail = JSON.stringify({
    number: 42,
    title: "Normalize pull details",
    state: "OPEN",
    isDraft: true,
    author: { login: "bob" },
    body: "Pull body.",
    url: "https://github.com/acme/widgets/pull/42",
    createdAt: "2026-08-18T12:00:00Z",
    updatedAt: "2026-08-19T13:00:00Z",
    baseRefName: "main",
    headRefName: "feature",
    additions: 12,
    deletions: 3,
    labels: [{ name: "enhancement" }],
    assignees: [{ login: "octocat" }],
    reviewDecision: "REVIEW_REQUIRED",
    mergeStateStatus: "BLOCKED",
    reviewRequests: [{ login: "reviewer" }, { name: "core-team" }],
    statusCheckRollup: [
      {
        name: "build",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        detailsUrl: "https://ci.example/build",
      },
      {
        context: "legacy",
        state: "FAILURE",
        targetUrl: "https://ci.example/legacy",
      },
      { name: "queued", status: "QUEUED" },
      { name: "skipped", status: "COMPLETED", conclusion: "SKIPPED" },
    ],
    comments: [
      {
        author: { login: "commenter" },
        body: "Conversation comment",
        createdAt: "2026-08-19T14:00:00Z",
      },
    ],
    reviews: [
      {
        author: { login: "reviewer" },
        state: "CHANGES_REQUESTED",
        body: "Please fix this.",
        submittedAt: "2026-08-19T15:00:00Z",
      },
    ],
  });
  const reviewComments = JSON.stringify([
    [
      {
        id: 100,
        path: "src/index.ts",
        line: 9,
        diff_hunk: "@@ -1 +1 @@",
        body: "Root comment",
        created_at: "2026-08-19T16:00:00Z",
        user: { login: "reviewer" },
      },
      {
        id: 101,
        in_reply_to_id: 100,
        body: "Reply",
        created_at: "2026-08-19T16:05:00Z",
        user: { login: "bob" },
      },
    ],
    [
      {
        id: 102,
        path: "src/other.ts",
        original_line: 4,
        body: "Second thread",
        created_at: "2026-08-19T17:00:00Z",
        user: { login: "reviewer" },
      },
    ],
  ]);
  const pullFiles = JSON.stringify([
    [
      {
        filename: "src/index.ts",
        status: "modified",
        additions: 10,
        deletions: 2,
        patch: "@@ -1 +1 @@",
      },
    ],
    [
      {
        filename: "src/other.ts",
        status: "added",
        additions: 2,
        deletions: 1,
      },
    ],
  ]);

  writeFileSync(
    join(binDir, "gh"),
    `#!/usr/bin/env bash
echo "$*" >> "${callLog}"
case "$*" in
  "--version") echo "gh version 2.96.0 (fake)";;
  "auth status --hostname github.com --active") echo "authenticated";;
  "api user") printf '%s\n' '{"login":"octocat"}';;
  "api repos/acme/widgets/assignees?per_page=100") printf '%s\n' '[{"login":"zoe"},{"login":"alice"},{"login":""}]';;
  "api repos/acme/widgets/labels?per_page=100") printf '%s\n' '[{"name":"triage"},{"name":" bug "},{"name":""}]';;
  "issue list -R acme/widgets --state open"*) printf '%s\n' '${openIssue}';;
  "issue list -R acme/widgets --state closed"*) printf '%s\n' '[]';;
  "pr list -R acme/widgets --state open"*) printf '%s\n' '${openPull}';;
  "pr list -R acme/widgets --state closed"*) printf '%s\n' '[]';;
  "issue view 7 -R acme/widgets --json labels") printf '%s\n' '{"labels":[{"name":"bug"},{"name":"old"}]}';;
  "issue view 7 -R acme/widgets --json"*) printf '%s\n' '${issueDetail}';;
  "pr view 42 -R acme/widgets --json"*) printf '%s\n' '${pullDetail}';;
  "api --paginate --slurp repos/acme/widgets/pulls/42/comments?per_page=100") printf '%s\n' '${reviewComments}';;
  "api --paginate --slurp repos/acme/widgets/pulls/42/files?per_page=100") printf '%s\n' '${pullFiles}';;
  "issue edit "*) printf '%s\n' '[]';;
  *) printf '%s\n' '[]';;
esac
`,
  );
  chmodSync(join(binDir, "gh"), 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
  rmSync(binDir, { recursive: true, force: true });
});

async function loadPlugin(extraRepos = "acme/widgets") {
  const host = createFakePluginHost({
    pluginId: "github",
    settings: { extraRepos },
  });
  await plugin(host.bb);
  return host;
}

describe("github plugin RPC behavior", () => {
  it("reports extraRepos entries it cannot honor instead of dropping them", async () => {
    const { harness } = await loadPlugin("acme/widgets, ACME-ORG/*, nonsense");

    await expect(harness.runCli(["repos"])).resolves.toEqual({
      exitCode: 0,
      stdout: "acme/widgets",
      stderr:
        'ignoring 2 extraRepos entries that are not "owner/repo": ACME-ORG/*, nonsense\n',
    });
    expect(harness.logEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          message:
            'ignoring 2 extraRepos entries that are not "owner/repo": ACME-ORG/*, nonsense',
        }),
      ]),
    );

    await harness.runCli(["repos"]);
    expect(
      harness.logEntries.filter(
        (entry) =>
          entry.level === "warn" && entry.message.includes("extraRepos"),
      ),
    ).toHaveLength(1);
  });

  it("says nothing about extraRepos when every entry is usable", async () => {
    const { harness } = await loadPlugin("acme/widgets");

    await expect(harness.runCli(["repos"])).resolves.toEqual({
      exitCode: 0,
      stdout: "acme/widgets",
      stderr: "",
    });
    expect(
      harness.logEntries.filter((entry) =>
        entry.message.includes("extraRepos"),
      ),
    ).toEqual([]);
  });

  it("syncs, filters, mutates, and exposes the same cached issue across surfaces", async () => {
    const { harness } = await loadPlugin();

    await expect(harness.callRpc("refresh")).resolves.toEqual({
      repos: 1,
      items: 2,
    });
    await expect(
      harness.callRpc("listItems", {
        kind: "issue",
        state: "open",
        mine: true,
        query: "#7",
      }),
    ).resolves.toMatchObject({
      items: [
        {
          repo: "acme/widgets",
          number: 7,
          kind: "issue",
          labels: ["bug", "old"],
          assignees: ["octocat"],
        },
      ],
    });

    await expect(
      harness.callRpc("setAssignees", {
        repo: "acme/widgets",
        number: 7,
        assignees: ["octocat", "hubot", "hubot"],
      }),
    ).resolves.toEqual({
      ok: true,
      assignees: ["octocat", "hubot"],
    });
    await expect(
      harness.callRpc("setLabels", {
        repo: "acme/widgets",
        number: 7,
        labels: ["bug", "feature", "feature", " "],
      }),
    ).resolves.toEqual({ ok: true, labels: ["bug", "feature"] });

    expect(ghCalls()).toEqual(
      expect.arrayContaining([
        "issue edit 7 -R acme/widgets --add-assignee hubot",
        "issue edit 7 -R acme/widgets --add-label feature --remove-label old",
      ]),
    );
    await expect(
      harness.callRpc("listItems", { kind: "issue" }),
    ).resolves.toMatchObject({
      items: [
        {
          number: 7,
          labels: ["bug", "feature"],
          assignees: ["octocat", "hubot"],
        },
      ],
    });

    await expect(harness.runCli(["issues", "acme/widgets"])).resolves.toEqual({
      exitCode: 0,
      stdout: "acme/widgets#7\t[OPEN]\tCache mutations",
      stderr: "",
    });
    const issueProvider = harness.registrations.mentionProviders.find(
      (provider) => provider.id === "issue",
    );
    if (issueProvider === undefined) {
      throw new Error("GitHub issue mention provider was not registered");
    }
    expect(
      issueProvider.search({
        query: "cache",
        trigger: "@",
        projectId: "project-1",
        threadId: "thread-1",
      }),
    ).toEqual([
      {
        id: "acme/widgets#7",
        title: "#7 Cache mutations",
        subtitle: "acme/widgets",
      },
    ]);
    await expect(
      issueProvider.resolve("acme/widgets#7"),
    ).resolves.toMatchObject({
      context: expect.stringContaining("Live issue body."),
    });
    expect(
      harness.realtimeSignals.filter(
        (signal) => signal.channel === "data-changed",
      ),
    ).toHaveLength(3);
  });

  it("normalizes draft state, checks, review threads, and paginated files", async () => {
    const { harness } = await loadPlugin();

    await expect(
      harness.callRpc("getPull", { repo: "acme/widgets", number: 42 }),
    ).resolves.toMatchObject({
      pull: {
        repo: "acme/widgets",
        number: 42,
        state: "DRAFT",
        changedFiles: 2,
        reviewRequests: ["reviewer", "core-team"],
        checks: [
          { name: "build", status: "success" },
          { name: "legacy", status: "failure" },
          { name: "queued", status: "pending" },
          { name: "skipped", status: "neutral" },
        ],
        reviewThreads: [
          {
            path: "src/index.ts",
            line: 9,
            comments: [
              { author: "reviewer", body: "Root comment" },
              { author: "bob", body: "Reply" },
            ],
          },
          {
            path: "src/other.ts",
            line: 4,
            comments: [{ author: "reviewer", body: "Second thread" }],
          },
        ],
        files: [
          {
            path: "src/index.ts",
            status: "modified",
            patch: "@@ -1 +1 @@",
          },
          { path: "src/other.ts", status: "added", patch: null },
        ],
      },
    });
  });
});
