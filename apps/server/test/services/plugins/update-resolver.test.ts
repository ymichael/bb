import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { PLUGIN_SDK_VERSION } from "@bb/domain";
import {
  createNpmResolverRun,
  listGitSemverTags,
  resolveGitRange,
  resolveGitRef,
  resolveGitUpdate,
  resolveNpmUpdate,
  selectGitSemverTag,
} from "../../../src/services/plugins/update-resolver.js";

const run = promisify(execFile);
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function packumentFetch(
  versions: Record<string, { bb?: string; sdk?: string; integrity?: string }>,
  tags: Record<string, string> = {},
): typeof fetch {
  return async () =>
    new Response(
      JSON.stringify({
        versions: Object.fromEntries(
          Object.entries(versions).map(([version, metadata]) => [
            version,
            {
              version,
              engines: {
                ...(metadata.bb ? { bb: metadata.bb } : {}),
                ...(metadata.sdk ? { bbPluginSdk: metadata.sdk } : {}),
              },
              dist: {
                integrity: metadata.integrity ?? `sha512-${version}`,
              },
            },
          ]),
        ),
        "dist-tags": tags,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
}

function npmIntent(
  requestedSpec: string,
  specKind: "default" | "exact" | "tag" | "range",
) {
  return {
    packageName: "bb-plugin-matrix",
    registry: "http://registry.test",
    requestedSpec,
    specKind,
  } as const;
}

describe("npm update candidate selection", () => {
  it("selects an older compatible range candidate and reports the newer block", async () => {
    const resolution = await resolveNpmUpdate({
      intent: npmIntent("^1.0.0", "range"),
      current: { version: "1.0.0", display: "bb-plugin-matrix@1.0.0" },
      appVersion: "1.5.0",
      run: createNpmResolverRun({
        fetch: packumentFetch({
          "1.3.0": { bb: ">=2" },
          "1.2.0": { bb: ">=1" },
          "1.1.0-beta.1": { bb: ">=1" },
          "1.0.0": { bb: ">=1" },
        }),
      }),
    });

    expect(resolution).toMatchObject({
      outcome: "update-available",
      candidate: { version: "1.2.0" },
      blocked: {
        version: { version: "1.3.0" },
        reasons: [{ engine: "bb", required: ">=2" }],
      },
    });
  });

  it("enforces SDK compatibility and returns incompatible when none match", async () => {
    const resolution = await resolveNpmUpdate({
      intent: npmIntent("", "default"),
      current: { version: "1.0.0", display: "bb-plugin-matrix@1.0.0" },
      appVersion: "1.5.0",
      run: createNpmResolverRun({
        fetch: packumentFetch({
          "2.0.0": { sdk: ">=99" },
          "1.0.0": { sdk: ">=99" },
        }),
      }),
    });

    expect(resolution).toMatchObject({
      outcome: "incompatible",
      newest: { version: "2.0.0" },
      reasons: [
        {
          engine: "bbPluginSdk",
          actual: PLUGIN_SDK_VERSION,
        },
      ],
    });
  });

  it("admits prereleases only when the requested semver spec includes one", async () => {
    const fetch = packumentFetch({
      "1.1.0-beta.1": {},
      "1.0.1": {},
      "1.0.0-beta.1": {},
    });
    const stable = await resolveNpmUpdate({
      intent: npmIntent("", "default"),
      current: { version: "1.0.0", display: "bb-plugin-matrix@1.0.0" },
      appVersion: "1.0.0",
      run: createNpmResolverRun({ fetch }),
    });
    const prerelease = await resolveNpmUpdate({
      intent: npmIntent(">=1.0.0-beta.1 <1.0.0", "range"),
      current: {
        version: "1.0.0-alpha.1",
        display: "bb-plugin-matrix@1.0.0-alpha.1",
      },
      appVersion: "1.0.0",
      run: createNpmResolverRun({ fetch }),
    });

    expect(stable).toMatchObject({
      outcome: "update-available",
      candidate: { version: "1.0.1" },
    });
    expect(prerelease).toMatchObject({
      outcome: "update-available",
      candidate: { version: "1.0.0-beta.1" },
    });
  });

  it("labels dev mode, ignores engines.bb for selection, and still enforces SDK", async () => {
    const resolution = await resolveNpmUpdate({
      intent: npmIntent("", "default"),
      current: { version: "1.0.0", display: "bb-plugin-matrix@1.0.0" },
      appVersion: "0.0.0",
      run: createNpmResolverRun({
        fetch: packumentFetch({
          "3.0.0": { bb: ">=99", sdk: ">=99" },
          "2.0.0": { bb: ">=99", sdk: `^${PLUGIN_SDK_VERSION}` },
          "1.0.0": {},
        }),
      }),
    });

    expect(resolution).toMatchObject({
      outcome: "update-available",
      devMode: true,
      candidate: { version: "2.0.0" },
      blocked: { version: { version: "3.0.0" } },
      packagedBuildProblems: [{ engine: "bb", required: ">=99" }],
    });
  });

  it("tracks a dist-tag but pins exact versions", async () => {
    const run = createNpmResolverRun({
      fetch: packumentFetch({ "1.0.0": {}, "2.0.0": {} }, { next: "2.0.0" }),
    });
    const tagged = await resolveNpmUpdate({
      intent: npmIntent("next", "tag"),
      current: { version: "1.0.0", display: "bb-plugin-matrix@1.0.0" },
      appVersion: "1.0.0",
      run,
    });
    const exact = await resolveNpmUpdate({
      intent: npmIntent("1.0.0", "exact"),
      current: { version: "1.0.0", display: "bb-plugin-matrix@1.0.0" },
      appVersion: "1.0.0",
      run,
    });
    expect(tagged).toMatchObject({
      outcome: "update-available",
      candidate: { version: "2.0.0" },
    });
    expect(exact).toEqual({
      outcome: "pinned",
      current: { version: "1.0.0", display: "bb-plugin-matrix@1.0.0" },
    });
  });

  it("binds a registry version when the registry omits integrity", async () => {
    const resolution = await resolveNpmUpdate({
      intent: npmIntent("next", "tag"),
      current: { version: "1.0.0", display: "bb-plugin-matrix@1.0.0" },
      appVersion: "1.0.0",
      run: createNpmResolverRun({
        fetch: async () =>
          new Response(
            JSON.stringify({
              versions: { "2.0.0": { version: "2.0.0", dist: {} } },
              "dist-tags": { next: "2.0.0" },
            }),
          ),
      }),
    });

    expect(resolution).toMatchObject({
      outcome: "update-available",
      candidate: { version: "2.0.0", integrity: "" },
    });
  });
});

describe("git update resolution", () => {
  it("classifies tags and branches, detects a moved branch, and reports current", async () => {
    const repo = await mkdtemp(join(tmpdir(), "bb-update-resolver-git-"));
    cleanup.push(repo);
    await mkdir(repo, { recursive: true });
    await run("git", ["init", "-q", "-b", "main"], { cwd: repo });
    await run("git", ["config", "user.email", "test@example.com"], {
      cwd: repo,
    });
    await run("git", ["config", "user.name", "Test"], { cwd: repo });
    await writeFile(join(repo, "file.txt"), "one");
    await run("git", ["add", "."], { cwd: repo });
    await run("git", ["commit", "-qm", "one"], { cwd: repo });
    const first = (
      await run("git", ["rev-parse", "HEAD"], { cwd: repo })
    ).stdout.trim();
    await run("git", ["tag", "v1"], { cwd: repo });

    expect(await resolveGitRef({ url: repo, ref: "v1" })).toMatchObject({
      outcome: "resolved",
      refKind: "tag",
      commit: first,
    });
    expect(await resolveGitRef({ url: repo, ref: "main" })).toMatchObject({
      outcome: "resolved",
      refKind: "branch",
      commit: first,
    });
    expect(await resolveGitRef({ url: repo, ref: "HEAD" })).toMatchObject({
      outcome: "resolved",
      refKind: "branch",
      commit: first,
    });
    expect(
      await resolveGitUpdate({
        url: repo,
        intent: { kind: "ref", ref: "main", refKind: "branch" },
        currentCommit: first,
      }),
    ).toMatchObject({ outcome: "current" });

    await writeFile(join(repo, "file.txt"), "two");
    await run("git", ["commit", "-qam", "two"], { cwd: repo });
    const second = (
      await run("git", ["rev-parse", "HEAD"], { cwd: repo })
    ).stdout.trim();
    expect(
      await resolveGitUpdate({
        url: repo,
        intent: { kind: "ref", ref: "main", refKind: "branch" },
        currentCommit: first,
      }),
    ).toMatchObject({
      outcome: "update-available",
      candidate: { version: second },
    });
    expect(
      await resolveGitUpdate({
        url: repo,
        intent: { kind: "ref", ref: "v1", refKind: "tag" },
        currentCommit: first,
      }),
    ).toMatchObject({ outcome: "pinned" });
    expect(
      await resolveGitUpdate({
        url: repo,
        intent: { kind: "ref", ref: first, refKind: "commit" },
        currentCommit: first,
      }),
    ).toMatchObject({ outcome: "pinned" });
  });
});

describe("git semver tag resolution", () => {
  async function tagRepo(): Promise<{
    repo: string;
    commitOf: Map<string, string>;
  }> {
    const repo = await mkdtemp(join(tmpdir(), "bb-git-tags-"));
    cleanup.push(repo);
    await run("git", ["init", "-q", "-b", "main"], { cwd: repo });
    await run("git", ["config", "user.email", "test@example.com"], {
      cwd: repo,
    });
    await run("git", ["config", "user.name", "Test"], { cwd: repo });
    const commitOf = new Map<string, string>();
    const releases: Array<{ tag: string; annotated: boolean }> = [
      { tag: "v1.0.0", annotated: false },
      { tag: "v1.1.0", annotated: true },
      { tag: "v1.2.0-beta.1", annotated: false },
      { tag: "v2.0.0", annotated: true },
      { tag: "v1.2", annotated: false },
      { tag: "release-3", annotated: false },
      { tag: "notes/v0.9.0", annotated: false },
      { tag: "notes/v1.0.0", annotated: true },
    ];
    for (const release of releases) {
      await writeFile(join(repo, "file.txt"), release.tag);
      await run("git", ["add", "."], { cwd: repo });
      await run("git", ["commit", "-qm", release.tag], { cwd: repo });
      await run(
        "git",
        release.annotated
          ? ["tag", "-a", release.tag, "-m", release.tag]
          : ["tag", release.tag],
        { cwd: repo },
      );
      commitOf.set(
        release.tag,
        (await run("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim(),
      );
    }
    return { repo, commitOf };
  }

  it("lists only [prefix]vX.Y.Z tags, peels annotated ones, and orders them", async () => {
    const { repo, commitOf } = await tagRepo();

    const repoWide = await listGitSemverTags({ url: repo, tagPrefix: "" });
    expect(repoWide.map((tag) => tag.tag)).toEqual([
      "v2.0.0",
      "v1.2.0-beta.1",
      "v1.1.0",
      "v1.0.0",
    ]);
    expect(repoWide.map((tag) => tag.version)).toEqual([
      "2.0.0",
      "1.2.0-beta.1",
      "1.1.0",
      "1.0.0",
    ]);
    expect(repoWide.find((tag) => tag.tag === "v2.0.0")?.commit).toBe(
      commitOf.get("v2.0.0"),
    );

    const prefixed = await listGitSemverTags({
      url: repo,
      tagPrefix: "notes/",
    });
    expect(prefixed.map((tag) => tag.tag)).toEqual([
      "notes/v1.0.0",
      "notes/v0.9.0",
    ]);
    expect(prefixed.find((tag) => tag.tag === "notes/v1.0.0")?.commit).toBe(
      commitOf.get("notes/v1.0.0"),
    );
  });

  it("asks the remote for release tags only, so unrelated tags cost nothing", async () => {
    const repo = await mkdtemp(join(tmpdir(), "bb-git-many-tags-"));
    cleanup.push(repo);
    await run("git", ["init", "-q", "-b", "main"], { cwd: repo });
    await run("git", ["config", "user.email", "test@example.com"], {
      cwd: repo,
    });
    await run("git", ["config", "user.name", "Test"], { cwd: repo });
    await writeFile(join(repo, "file.txt"), "release");
    await run("git", ["add", "."], { cwd: repo });
    await run("git", ["commit", "-qm", "release"], { cwd: repo });
    const commit = (
      await run("git", ["rev-parse", "HEAD"], { cwd: repo })
    ).stdout.trim();
    const lines = ["# pack-refs with: peeled fully-peeled sorted \n"];
    lines.push(`${commit} refs/tags/notes/v1.0.0\n`);
    for (let index = 0; index < 150_000; index += 1) {
      lines.push(`${commit} refs/tags/unrelated-${String(index)}\n`);
    }
    await writeFile(join(repo, ".git", "packed-refs"), lines.join(""));

    const tags = await listGitSemverTags({ url: repo, tagPrefix: "notes/" });
    expect(tags.map((tag) => tag.tag)).toEqual(["notes/v1.0.0"]);
  });

  it("selects the highest satisfying release and excludes prereleases", async () => {
    const { repo } = await tagRepo();
    const tags = await listGitSemverTags({ url: repo, tagPrefix: "" });

    expect(selectGitSemverTag({ tags, range: "^1.0.0" })?.tag).toBe("v1.1.0");
    expect(selectGitSemverTag({ tags, range: "*" })?.tag).toBe("v2.0.0");
    expect(selectGitSemverTag({ tags, range: "~1.0.0" })?.tag).toBe("v1.0.0");
    expect(selectGitSemverTag({ tags, range: ">=1.2.0" })?.tag).toBe("v2.0.0");
    expect(selectGitSemverTag({ tags, range: ">=1.2.0-0 <2.0.0" })?.tag).toBe(
      "v1.2.0-beta.1",
    );
    expect(selectGitSemverTag({ tags, range: "^3.0.0" })).toBeNull();
  });

  it("resolves a range for an install and reports a range with no match", async () => {
    const { repo, commitOf } = await tagRepo();

    expect(
      await resolveGitRange({ url: repo, range: "^1.0.0", tagPrefix: "" }),
    ).toEqual({
      outcome: "resolved",
      tag: "v1.1.0",
      version: "1.1.0",
      commit: commitOf.get("v1.1.0"),
    });
    expect(
      await resolveGitRange({
        url: repo,
        range: "^9.0.0",
        tagPrefix: "notes/",
      }),
    ).toMatchObject({
      outcome: "unavailable",
      detail: expect.stringContaining('"notes/vX.Y.Z"'),
    });
  });

  it("offers newer satisfying tags and refuses a tag that moved", async () => {
    const { repo, commitOf } = await tagRepo();
    const installed = commitOf.get("v1.0.0") ?? "";

    expect(
      await resolveGitUpdate({
        url: repo,
        intent: {
          kind: "range",
          range: "^1.0.0",
          tagPrefix: "",
          resolvedTag: "v1.0.0",
        },
        currentCommit: installed,
      }),
    ).toMatchObject({
      outcome: "update-available",
      candidate: { version: commitOf.get("v1.1.0") },
    });
    expect(
      await resolveGitUpdate({
        url: repo,
        intent: {
          kind: "range",
          range: "~1.0.0",
          tagPrefix: "",
          resolvedTag: "v1.0.0",
        },
        currentCommit: installed,
      }),
    ).toMatchObject({ outcome: "current" });

    await run("git", ["tag", "-f", "v1.0.0", "HEAD"], { cwd: repo });
    const moved = (
      await run("git", ["rev-parse", "HEAD"], { cwd: repo })
    ).stdout.trim();
    for (const intent of [
      {
        kind: "range" as const,
        range: "^1.0.0",
        tagPrefix: "",
        resolvedTag: "v1.0.0",
      },
      { kind: "ref" as const, ref: "v1.0.0", refKind: "tag" as const },
    ]) {
      expect(
        await resolveGitUpdate({ url: repo, intent, currentCommit: installed }),
      ).toMatchObject({
        outcome: "unavailable",
        detail: expect.stringContaining(
          `security check failed: git tag "v1.0.0"`,
        ),
      });
      expect(
        await resolveGitUpdate({ url: repo, intent, currentCommit: installed }),
      ).toMatchObject({
        detail: expect.stringContaining(`${installed} to ${moved}`),
      });
    }
  });

  it("carries the selected release tag on the resolution", async () => {
    const { repo, commitOf } = await tagRepo();

    expect(
      await resolveGitUpdate({
        url: repo,
        intent: {
          kind: "range",
          range: "^1.0.0",
          tagPrefix: "",
          resolvedTag: "v1.0.0",
        },
        currentCommit: commitOf.get("v1.0.0") ?? "",
      }),
    ).toMatchObject({
      outcome: "update-available",
      candidateGitTag: "v1.1.0",
      candidate: { version: commitOf.get("v1.1.0") },
    });
  });

  it("walks down to the newest release this bb can run", async () => {
    const { repo, commitOf } = await tagRepo();
    const probed: string[] = [];

    const resolution = await resolveGitUpdate({
      url: repo,
      intent: {
        kind: "range",
        range: "*",
        tagPrefix: "",
        resolvedTag: "v1.0.0",
      },
      currentCommit: commitOf.get("v1.0.0") ?? "",
      probeCandidate: async (candidate) => {
        probed.push(candidate.tag);
        return candidate.tag === "v2.0.0"
          ? {
              outcome: "incompatible",
              devMode: false,
              reasons: [
                {
                  engine: "bb",
                  required: ">=99.0.0",
                  actual: "1.0.0",
                  message: "requires bb >=99.0.0, running bb is 1.0.0",
                },
              ],
            }
          : {
              outcome: "compatible",
              devMode: false,
              packagedBuildProblems: [],
            };
      },
    });

    expect(probed).toEqual(["v2.0.0", "v1.1.0"]);
    expect(resolution).toMatchObject({
      outcome: "update-available",
      candidateGitTag: "v1.1.0",
      candidate: { version: commitOf.get("v1.1.0") },
      blocked: {
        version: { version: commitOf.get("v2.0.0") },
        reasons: [{ engine: "bb" }],
      },
    });
  });

  it("stays current and reports the blocked release when nothing newer runs", async () => {
    const { repo, commitOf } = await tagRepo();

    expect(
      await resolveGitUpdate({
        url: repo,
        intent: {
          kind: "range",
          range: "^1.0.0",
          tagPrefix: "",
          resolvedTag: "v1.0.0",
        },
        currentCommit: commitOf.get("v1.0.0") ?? "",
        probeCandidate: async () => ({
          outcome: "incompatible",
          devMode: false,
          reasons: [
            {
              engine: "bb",
              required: ">=99.0.0",
              actual: "1.0.0",
              message: "requires bb >=99.0.0, running bb is 1.0.0",
            },
          ],
        }),
      }),
    ).toMatchObject({
      outcome: "current",
      blocked: {
        version: { version: commitOf.get("v1.1.0") },
        reasons: [{ engine: "bb" }],
      },
    });
  });

  it("refuses to downgrade when the recorded range tag disappeared", async () => {
    const { repo, commitOf } = await tagRepo();
    await run("git", ["tag", "-d", "v1.1.0"], { cwd: repo });

    expect(
      await resolveGitUpdate({
        url: repo,
        intent: {
          kind: "range",
          range: "^1.0.0",
          tagPrefix: "",
          resolvedTag: "v1.1.0",
        },
        currentCommit: commitOf.get("v1.1.0") ?? "",
      }),
    ).toMatchObject({
      outcome: "unavailable",
      detail: expect.stringContaining(
        'recorded git tag "v1.1.0" no longer exists',
      ),
    });
  });
});
