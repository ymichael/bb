import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import type { PluginRpcClient, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import simpleNotes, { docsRpcContract } from "./server";

const temporaryDirectories: string[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function loadNotebook(
  notes: Record<string, string>,
  watchVault?: NonNullable<Parameters<typeof simpleNotes>[1]>,
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bb-simple-notes-"));
  temporaryDirectories.push(directory);
  await Promise.all(
    Object.entries(notes).map(([name, content]) =>
      writeFile(path.join(directory, name), content),
    ),
  );
  const host = createFakePluginHost({
    pluginId: "simple-notes",
    sdk: {
      files: {
        listPaths: async () => ({
          paths: Object.keys(notes).map((name) => ({
            kind: "file" as const,
            path: name,
            name,
            score: 0,
            positions: [],
          })),
          truncated: false,
        }),
        read: async ({ path: filePath }) => {
          const content = await readFile(filePath, "utf8");
          return {
            path: filePath,
            content,
            contentEncoding: "utf8" as const,
            mimeType: "text/markdown",
            sizeBytes: Buffer.byteLength(content),
            modifiedAtMs: 1,
            sha256: "test-sha",
          };
        },
        write: async () => ({
          outcome: "written" as const,
          sha256: "written-sha",
          sizeBytes: 1,
        }),
        mkdir: async () => ({ ok: true as const }),
        move: async () => ({ ok: true as const }),
        remove: async () => ({ ok: true as const }),
        createPreview: async () => ({
          baseUrl: "/api/v1/file-previews/test",
          expiresAtMs: Date.now() + 60_000,
        }),
      },
      hosts: { list: async () => [] },
    },
  });
  await simpleNotes(host.bb, watchVault);
  host.bb.storage
    .database()
    .prepare("UPDATE vaults SET root_path = ? WHERE id = 'personal'")
    .run(directory);
  host.harness.sdk.calls.length = 0;
  return host;
}

interface VirtualFile {
  content: string;
  contentEncoding: "base64" | "utf8";
  modifiedAtMs: number;
}

function virtualSha(file: VirtualFile): string {
  return createHash("sha256")
    .update(Buffer.from(file.content, file.contentEncoding))
    .digest("hex");
}

async function loadVirtualSyncVault(initial: Record<string, VirtualFile>) {
  const files = new Map<string, VirtualFile>(Object.entries(initial));
  const directories = new Set<string>(["/vault", "/work"]);
  let concurrentWrite: { path: string; content: string } | null = null;
  const addParents = (filePath: string) => {
    let current = path.posix.dirname(filePath);
    while (current !== "/" && !directories.has(current)) {
      directories.add(current);
      current = path.posix.dirname(current);
    }
  };
  for (const filePath of files.keys()) addParents(filePath);
  const setUtf8 = (filePath: string, content: string) => {
    addParents(filePath);
    files.set(filePath, {
      content,
      contentEncoding: "utf8",
      modifiedAtMs: Date.now(),
    });
  };
  const host = createFakePluginHost({
    pluginId: "simple-notes-sync",
    sdk: {
      files: {
        async listPaths(args) {
          const prefix = args.path.endsWith("/") ? args.path : `${args.path}/`;
          const paths = [
            ...(args.includeDirectories
              ? [...directories]
                  .filter((entry) => entry.startsWith(prefix))
                  .map((entry) => ({
                    kind: "directory" as const,
                    path: entry.slice(prefix.length),
                    name: path.posix.basename(entry),
                    score: 0,
                    positions: [],
                  }))
              : []),
            ...(args.includeFiles
              ? [...files.keys()]
                  .filter((entry) => entry.startsWith(prefix))
                  .map((entry) => ({
                    kind: "file" as const,
                    path: entry.slice(prefix.length),
                    name: path.posix.basename(entry),
                    score: 0,
                    positions: [],
                  }))
              : []),
          ];
          return { paths, truncated: false };
        },
        async read(args) {
          const file = files.get(args.path);
          if (!file)
            throw new Error(`ENOENT: Path does not exist: ${args.path}`);
          return {
            path: args.path,
            content: file.content,
            contentEncoding: file.contentEncoding,
            mimeType: file.contentEncoding === "utf8" ? "text/plain" : null,
            sizeBytes: Buffer.from(file.content, file.contentEncoding).length,
            modifiedAtMs: file.modifiedAtMs,
            sha256: virtualSha(file),
          };
        },
        async write(args) {
          const pending = concurrentWrite;
          if (pending && pending.path === args.path) {
            concurrentWrite = null;
            setUtf8(pending.path, pending.content);
            const current = files.get(pending.path);
            if (!current)
              throw new Error("Concurrent test write was not stored");
            return {
              outcome: "conflict" as const,
              currentSha256: virtualSha(current),
            };
          }
          const current = files.get(args.path);
          const currentSha = current ? virtualSha(current) : null;
          if (
            args.expectedSha256 !== undefined &&
            args.expectedSha256 !== currentSha
          ) {
            return { outcome: "conflict" as const, currentSha256: currentSha };
          }
          const next = {
            content: args.content,
            contentEncoding: args.contentEncoding ?? "utf8",
            modifiedAtMs: Date.now(),
          } satisfies VirtualFile;
          addParents(args.path);
          files.set(args.path, next);
          return {
            outcome: "written" as const,
            sha256: virtualSha(next),
            sizeBytes: Buffer.from(next.content, next.contentEncoding).length,
          };
        },
        async mkdir(args) {
          directories.add(args.path);
          addParents(args.path);
          return { ok: true as const };
        },
        async remove(args) {
          if (files.delete(args.path)) return { ok: true as const };
          if (!directories.has(args.path))
            throw new Error(`ENOENT: Path does not exist: ${args.path}`);
          const prefix = `${args.path}/`;
          if (
            !args.recursive &&
            ([...files.keys()].some((entry) => entry.startsWith(prefix)) ||
              [...directories].some((entry) => entry.startsWith(prefix)))
          )
            throw new Error("Directory is not empty");
          directories.delete(args.path);
          return { ok: true as const };
        },
        async move() {
          return { ok: true as const };
        },
        async createPreview() {
          return { baseUrl: "/preview", expiresAtMs: Date.now() + 60_000 };
        },
        async list() {
          return { paths: [], truncated: false };
        },
      },
      hosts: { list: async () => [] },
    },
  });
  await simpleNotes(host.bb);
  host.bb.storage
    .database()
    .prepare("UPDATE vaults SET root_path = ? WHERE id = 'personal'")
    .run("/vault");
  host.harness.sdk.calls.length = 0;
  return {
    ...host,
    files,
    directories,
    setUtf8,
    conflictNextWrite(path: string, content: string) {
      concurrentWrite = { path, content };
    },
  };
}

type DocsRpcHandlers = PluginRpcHandlers<typeof docsRpcContract>;

function assertDocsFrontendInference(
  client: PluginRpcClient<typeof docsRpcContract>,
) {
  expectTypeOf(
    client.call("saveNote", {
      vaultId: "personal",
      path: "plan.md",
      content: "# Plan",
      expectedSha256: "sha",
    }),
  ).toEqualTypeOf<
    Promise<
      | { outcome: "written"; sha256: string; sizeBytes: number }
      | { outcome: "conflict"; currentSha256: string | null }
    >
  >();

  // @ts-expect-error saveNote requires string content.
  void client.call("saveNote", { path: "plan.md", content: 42 });
  // @ts-expect-error createVault requires an absolute-path candidate.
  void client.call("createVault", { name: "Work" });
}

describe("Docs RPC contract", () => {
  it("infers parsed handler inputs and frontend results", () => {
    expectTypeOf<Parameters<DocsRpcHandlers["openFile"]>[0]>().toEqualTypeOf<{
      source: {
        kind: "workspace" | "host" | "thread-storage";
        threadId: string | null;
        environmentId: string | null;
        projectId: string | null;
        experimental_hostId?: string;
      };
      path: string;
    }>();
    expectTypeOf(assertDocsFrontendInference).toBeFunction();
  });

  it("rejects invalid method inputs and outputs at runtime", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "docs-contract" });
    const contract = defineRpcContract({
      saveNote: docsRpcContract.saveNote,
    });
    bb.rpc.register(contract, {
      saveNote(): { outcome: "written"; sha256: string; sizeBytes: number } {
        return { outcome: "written", sha256: "sha", sizeBytes: -1 };
      },
    });

    await expect(
      harness.callRpc("saveNote", { path: "plan.md", content: 42 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      harness.callRpc("saveNote", {
        path: "../outside.md",
        content: "# Outside",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      harness.callRpc("saveNote", { path: "plan.md", content: "# Plan" }),
    ).rejects.toMatchObject({ code: "invalid_output" });
  });

  it("returns HTTP 400 envelopes for invalid JSON and request input", async () => {
    const { harness } = await loadNotebook({ "plan.md": "# Plan" });

    const invalidJson = await harness.fetchHttp("POST", "/read", {
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(invalidJson.status).toBe(400);
    await expect(invalidJson.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_json" },
    });

    const invalidInput = await harness.fetchHttp("POST", "/read", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "../outside.md" }),
    });
    expect(invalidInput.status).toBe(400);
    await expect(invalidInput.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "invalid_input",
        issues: [{ path: ["path"] }],
      },
    });
  });
});

async function waitForSignal(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for signal");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("Docs mention provider", () => {
  it("searches note titles, previews, and filenames", async () => {
    const { harness } = await loadNotebook({
      "roadmap.md": "# Product Roadmap\n\nQuarterly priorities",
      "meeting-notes.md": "# Standup\n\nLaunch checklist",
    });
    const provider = harness.registrations.mentionProviders[0]!;

    expect(provider).toMatchObject({
      id: "note",
      label: "Docs",
      triggers: ["@"],
    });
    await expect(
      provider.search({
        trigger: "@",
        query: "launch",
        projectId: null,
        threadId: null,
      }),
    ).resolves.toEqual([
      {
        id: "personal:meeting-notes.md",
        title: "Standup",
        subtitle: "Personal · Launch checklist",
        icon: "FileText",
      },
    ]);
  });

  it("ignores YAML frontmatter when deriving note titles and previews", async () => {
    const { harness } = await loadNotebook({
      "defensibility.md": [
        "---",
        "type: knowledge",
        "summary: Product strategy metadata",
        "---",
        "# AI application-layer defensibility",
        "",
        "Durable product strategy.",
      ].join("\n"),
    });
    const provider = harness.registrations.mentionProviders[0]!;

    await expect(
      provider.search({
        trigger: "@",
        query: "defensibility",
        projectId: null,
        threadId: null,
      }),
    ).resolves.toEqual([
      {
        id: "personal:defensibility.md",
        title: "AI application-layer defensibility",
        subtitle: "Personal · Durable product strategy.",
        icon: "FileText",
      },
    ]);
  });

  it("uses a YAML frontmatter title when the body has no document heading", async () => {
    const { harness } = await loadNotebook({
      "california-report.md": [
        "---",
        'title: "6th Annual Report: Evaluation of California\'s Caregiver Services"',
        "type: knowledge",
        "---",
        "## Key findings used in wiki",
        "",
        "CareNav assessments identify unmet caregiver needs.",
      ].join("\n"),
    });
    const provider = harness.registrations.mentionProviders[0]!;

    await expect(
      provider.search({
        trigger: "@",
        query: "california",
        projectId: null,
        threadId: null,
      }),
    ).resolves.toEqual([
      {
        id: "personal:california-report.md",
        title:
          "6th Annual Report: Evaluation of California's Caregiver Services",
        subtitle:
          "Personal · Key findings used in wiki CareNav assessments identify unmet caregiver needs.",
        icon: "FileText",
      },
    ]);
  });

  it("drops only a heading that repeats the frontmatter title", async () => {
    const { harness } = await loadNotebook({
      "echoed-title.md": [
        "---",
        "title: Caregiver services",
        "---",
        "# Caregiver services",
        "",
        "CareNav assessments identify unmet caregiver needs.",
      ].join("\n"),
    });
    const provider = harness.registrations.mentionProviders[0]!;

    await expect(
      provider.search({
        trigger: "@",
        query: "echoed",
        projectId: null,
        threadId: null,
      }),
    ).resolves.toEqual([
      {
        id: "personal:echoed-title.md",
        title: "Caregiver services",
        subtitle:
          "Personal · CareNav assessments identify unmet caregiver needs.",
        icon: "FileText",
      },
    ]);
  });

  it("keeps a section opened by a thematic break in the preview", async () => {
    const { harness } = await loadNotebook({
      "thematic-break.md": "---\n\nSome intro text.\n\n---\n\nMore text.\n",
    });
    const provider = harness.registrations.mentionProviders[0]!;

    await expect(
      provider.search({
        trigger: "@",
        query: "thematic",
        projectId: null,
        threadId: null,
      }),
    ).resolves.toMatchObject([
      { subtitle: "Personal · Some intro text. More text." },
    ]);
  });

  it("resolves the note's current content at send time", async () => {
    const { harness } = await loadNotebook({
      "ideas.md": "# Fresh Ideas\n\nBuild the mention flow.",
    });
    const provider = harness.registrations.mentionProviders[0]!;

    await expect(provider.resolve("personal:ideas.md")).resolves.toEqual({
      context:
        "Docs document (personal/ideas.md):\n\n# Fresh Ideas\n\nBuild the mention flow.",
    });
    expect(harness.sdk.callsTo("files.read")).toEqual([
      [
        {
          path: path.join(temporaryDirectories[0]!, "ideas.md"),
          rootPath: temporaryDirectories[0],
        },
      ],
    ]);
  });
});

describe("Docs vault operations", () => {
  it("creates the initial Personal vault without exposing a folder setting", async () => {
    const host = createFakePluginHost({
      pluginId: "simple-notes",
      sdk: {
        files: { mkdir: async () => ({ ok: true as const }) },
      },
    });

    await simpleNotes(host.bb);

    const result = await host.harness.runCli(["vaults", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      {
        id: "personal",
        name: "Personal",
        hostId: null,
        rootPath: path.join(os.homedir(), "Notes"),
      },
    ]);
    await expect(
      host.harness.setSettings({ directory: "/Elsewhere" }),
    ).rejects.toThrow('unknown setting "directory"');
  });

  it("keeps a frontmatter-managed document at its existing path", async () => {
    const { harness } = await loadNotebook({
      "stable-wiki-slug.md": [
        "---",
        "title: A different display title",
        "type: knowledge",
        "---",
        "# A different display title",
      ].join("\n"),
    });

    await expect(
      harness.callRpc("renameToTitle", {
        vaultId: "personal",
        path: "stable-wiki-slug.md",
      }),
    ).resolves.toEqual({ path: "stable-wiki-slug.md" });
    expect(harness.sdk.callsTo("files.move")).toEqual([]);
  });

  it("still follows the H1 when frontmatter has no title", async () => {
    const { harness } = await loadNotebook({
      "old-slug.md": ["---", "tags: [a]", "---", "# Brand new title"].join(
        "\n",
      ),
    });

    await expect(
      harness.callRpc("renameToTitle", {
        vaultId: "personal",
        path: "old-slug.md",
      }),
    ).resolves.toEqual({ path: "brand-new-title.md" });
    expect(harness.sdk.callsTo("files.move")).toHaveLength(1);
  });

  it("registers the agent-discoverable Docs CLI", async () => {
    const { harness } = await loadNotebook({ "plan.md": "# Plan" });
    expect(harness.registrations.cli).toMatchObject({
      name: "docs",
      summary: "Discover and safely sync Docs vaults",
    });
  });

  it("round-trips a folder edit through pull and push without changing binary assets", async () => {
    const { harness, files, setUtf8 } = await loadVirtualSyncVault({
      "/vault/plans/plan.md": {
        content: "# Plan\n\nOriginal\n",
        contentEncoding: "utf8",
        modifiedAtMs: 1,
      },
      "/vault/plans/image.bin": {
        content: "AP+AQA==",
        contentEncoding: "base64",
        modifiedAtMs: 1,
      },
    });

    const pulled = await harness.runCli(
      ["pull", "plans", "--folder", "--into", "sync", "--json"],
      { cwd: "/work" },
    );
    expect(pulled).toMatchObject({ exitCode: 0 });
    expect(files.get("/work/sync/plans/image.bin")).toMatchObject({
      content: "AP+AQA==",
      contentEncoding: "base64",
    });
    expect(files.has("/work/sync/.bb-docs-state.json")).toBe(true);

    setUtf8("/work/sync/plans/plan.md", "# Plan\n\nEdited locally\n");
    const status = await harness.runCli(
      ["status", "sync", "--diff", "--json"],
      { cwd: "/work" },
    );
    expect(status.exitCode).toBe(4);
    expect(JSON.parse(status.stdout ?? "{}")).toMatchObject({
      outcome: "planned",
      writes: ["plans/plan.md"],
    });

    const pushed = await harness.runCli(["push", "sync", "--json"], {
      cwd: "/work",
    });
    expect(pushed.exitCode).toBe(0);
    expect(files.get("/vault/plans/plan.md")?.content).toBe(
      "# Plan\n\nEdited locally\n",
    );
    expect(files.get("/vault/plans/image.bin")?.content).toBe("AP+AQA==");
  });

  it("pushes newly created local files with create-only semantics", async () => {
    const { harness, files, setUtf8 } = await loadVirtualSyncVault({
      "/vault/plans/existing.md": {
        content: "existing",
        contentEncoding: "utf8",
        modifiedAtMs: 1,
      },
    });
    await harness.runCli(
      ["pull", "plans", "--folder", "--into", "sync", "--json"],
      { cwd: "/work" },
    );
    setUtf8("/work/sync/plans/new.md", "created locally");

    const pushed = await harness.runCli(["push", "sync", "--json"], {
      cwd: "/work",
    });

    expect(pushed.exitCode).toBe(0);
    expect(JSON.parse(pushed.stdout ?? "{}")).toMatchObject({
      outcome: "pushed",
      writes: ["plans/new.md"],
    });
    expect(files.get("/vault/plans/new.md")?.content).toBe("created locally");
  });

  it("reconciles remotely and locally deleted empty directories safely", async () => {
    const { harness, files, directories } = await loadVirtualSyncVault({
      "/vault/folder/keep.md": {
        content: "keep",
        contentEncoding: "utf8",
        modifiedAtMs: 1,
      },
    });
    directories.add("/vault/folder/remote-gone");
    directories.add("/vault/folder/local-gone");
    await harness.runCli(
      ["pull", "folder", "--folder", "--into", "sync", "--json"],
      { cwd: "/work" },
    );

    directories.delete("/vault/folder/remote-gone");
    const refreshed = await harness.runCli(
      ["pull", "folder", "--folder", "--into", "sync", "--json"],
      { cwd: "/work" },
    );
    expect(refreshed.exitCode).toBe(0);
    expect(JSON.parse(refreshed.stdout ?? "{}")).toMatchObject({
      deletedDirectories: ["folder/remote-gone"],
    });
    expect(directories.has("/work/sync/folder/remote-gone")).toBe(false);

    directories.delete("/work/sync/folder/local-gone");
    const safePush = await harness.runCli(["push", "sync", "--json"], {
      cwd: "/work",
    });
    expect(safePush.exitCode).toBe(0);
    expect(directories.has("/vault/folder/local-gone")).toBe(true);
    expect(JSON.parse(safePush.stdout ?? "{}")).toMatchObject({
      warnings: [{ path: "folder/local-gone" }],
    });

    const deletingPush = await harness.runCli(
      ["push", "sync", "--delete", "--json"],
      { cwd: "/work" },
    );
    expect(deletingPush.exitCode).toBe(0);
    expect(directories.has("/vault/folder/local-gone")).toBe(false);
    expect(files.has("/vault/folder/keep.md")).toBe(true);
  });

  it("preflights concurrent edits and leaves the vault copy untouched", async () => {
    const { harness, files, setUtf8 } = await loadVirtualSyncVault({
      "/vault/plan.md": {
        content: "base",
        contentEncoding: "utf8",
        modifiedAtMs: 1,
      },
    });
    await harness.runCli(["pull", "plan.md", "--into", "sync", "--json"], {
      cwd: "/work",
    });
    setUtf8("/work/sync/plan.md", "local edit");
    setUtf8("/vault/plan.md", "remote edit");

    const pushed = await harness.runCli(["push", "sync", "--json"], {
      cwd: "/work",
    });
    expect(pushed.exitCode).toBe(3);
    expect(JSON.parse(pushed.stdout ?? "{}")).toMatchObject({
      outcome: "conflict",
      conflicts: [
        { path: "plan.md", reason: "both local and vault copies changed" },
      ],
    });
    expect(files.get("/vault/plan.md")?.content).toBe("remote edit");
  });

  it("reports a post-preflight CAS race as a conflict when nothing applied", async () => {
    const { harness, files, setUtf8, conflictNextWrite } =
      await loadVirtualSyncVault({
        "/vault/plan.md": {
          content: "base",
          contentEncoding: "utf8",
          modifiedAtMs: 1,
        },
      });
    await harness.runCli(["pull", "plan.md", "--into", "sync"], {
      cwd: "/work",
    });
    setUtf8("/work/sync/plan.md", "local edit");
    conflictNextWrite("/vault/plan.md", "raced remote edit");

    const pushed = await harness.runCli(["push", "sync", "--json"], {
      cwd: "/work",
    });

    expect(pushed.exitCode).toBe(3);
    expect(JSON.parse(pushed.stdout ?? "{}")).toMatchObject({
      outcome: "conflict",
      applied: {
        outcome: "conflict",
        written: [],
        conflicts: [{ path: "plan.md" }],
      },
    });
    expect(files.get("/vault/plan.md")?.content).toBe("raced remote edit");
  });

  it("rejects apply-level path collisions and reports only newly created directories", async () => {
    const { harness, directories } = await loadVirtualSyncVault({
      "/vault/plan.md": {
        content: "base",
        contentEncoding: "utf8",
        modifiedAtMs: 1,
      },
    });
    directories.add("/vault/existing");
    const emptyApply = {
      vaultId: "personal",
      writes: [],
      deletes: [],
      deleteDirectories: [],
      dryRun: false,
    };

    await expect(
      harness.callRpc("syncApply", {
        ...emptyApply,
        directories: ["New", "new"],
      }),
    ).rejects.toThrow(/collide/);
    await expect(
      harness.callRpc("syncApply", {
        ...emptyApply,
        directories: [],
        writes: [
          {
            path: "PLAN.md",
            content: "collision",
            contentEncoding: "utf8",
            expectedSha256: null,
          },
        ],
      }),
    ).rejects.toThrow(/collide/);

    const applied = await harness.callRpc("syncApply", {
      ...emptyApply,
      directories: ["existing", "created"],
    });
    expect(applied).toMatchObject({
      outcome: "applied",
      createdDirectories: ["created"],
      deletedDirectories: [],
    });
  });

  it("ignores local deletions by default and applies them only with --delete", async () => {
    const { harness, files } = await loadVirtualSyncVault({
      "/vault/archive/old.md": {
        content: "old",
        contentEncoding: "utf8",
        modifiedAtMs: 1,
      },
    });
    await harness.runCli(["pull", "archive", "--folder", "--into", "sync"], {
      cwd: "/work",
    });
    files.delete("/work/sync/archive/old.md");

    const safePush = await harness.runCli(["push", "sync", "--json"], {
      cwd: "/work",
    });
    expect(safePush.exitCode).toBe(0);
    expect(files.has("/vault/archive/old.md")).toBe(true);
    expect(JSON.parse(safePush.stdout ?? "{}")).toMatchObject({
      warnings: [{ path: "archive/old.md" }],
    });

    const deletingPush = await harness.runCli(
      ["push", "sync", "--delete", "--json"],
      { cwd: "/work" },
    );
    expect(deletingPush.exitCode).toBe(0);
    expect(files.has("/vault/archive/old.md")).toBe(false);
  });

  it("fails closed on malformed sync state with machine-readable output", async () => {
    const { harness, setUtf8 } = await loadVirtualSyncVault({
      "/vault/plan.md": {
        content: "base",
        contentEncoding: "utf8",
        modifiedAtMs: 1,
      },
    });
    setUtf8("/work/sync/.bb-docs-state.json", "{not-json");

    const result = await harness.runCli(["push", "sync", "--json"], {
      cwd: "/work",
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
      outcome: "error",
      error: { code: "operation_failed" },
    });
    expect(result.stderr).toBe("");
  });

  it("supports whole-vault and single-file scopes and deprecates direct writes", async () => {
    const { harness, files } = await loadVirtualSyncVault({
      "/vault/a.md": {
        content: "A",
        contentEncoding: "utf8",
        modifiedAtMs: 1,
      },
      "/vault/nested/b.md": {
        content: "B",
        contentEncoding: "utf8",
        modifiedAtMs: 1,
      },
    });
    await expect(
      harness.runCli(["pull", "a.md", "--into", "one"], { cwd: "/work" }),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(files.has("/work/one/a.md")).toBe(true);
    expect(files.has("/work/one/nested/b.md")).toBe(false);
    await expect(
      harness.runCli(["pull", "nested/b.md", "--into", "nested-one"], {
        cwd: "/work",
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      harness.runCli(["status", "nested-one"], { cwd: "/work" }),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      harness.runCli(["pull", "--all", "--into", "all"], { cwd: "/work" }),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(files.has("/work/all/nested/b.md")).toBe(true);

    const direct = await harness.runCli([
      "write",
      "legacy.md",
      "--content",
      "legacy",
    ]);
    expect(direct).toMatchObject({ exitCode: 0 });
    expect(direct.stderr).toContain("Deprecated");
  });

  it("renders top-level help successfully and rejects inapplicable flags before mutation", async () => {
    const { harness, files } = await loadVirtualSyncVault({
      "/vault/plan.md": {
        content: "base",
        contentEncoding: "utf8",
        modifiedAtMs: 1,
      },
    });

    const help = await harness.runCli(["--help"]);
    expect(help).toMatchObject({ exitCode: 0 });
    expect(help.stdout).toContain("pull|status|push");

    const statusHelp = await harness.runCli(["status", "--help"]);
    expect(statusHelp).toMatchObject({ exitCode: 0 });
    expect(statusHelp.stdout).toContain("Exit 4: changes present");
    expect(statusHelp.stdout).toContain("run bb docs push separately");

    const unsafePull = await harness.runCli(
      ["pull", "plan.md", "--into", "sync", "--dry-run", "--json"],
      { cwd: "/work" },
    );
    expect(unsafePull.exitCode).toBe(2);
    expect(JSON.parse(unsafePull.stdout ?? "{}")).toMatchObject({
      error: { code: "usage_error" },
    });
    expect(files.has("/work/sync/plan.md")).toBe(false);

    const unsafeRemove = await harness.runCli([
      "remove",
      "plan.md",
      "--dry-run",
      "--json",
    ]);
    expect(unsafeRemove.exitCode).toBe(2);
    expect(files.has("/vault/plan.md")).toBe(true);
  });

  it("keeps CLI removal non-recursive unless --recursive is passed", async () => {
    const { harness } = await loadNotebook({ "plan.md": "# Plan" });
    const rootPath = temporaryDirectories[0]!;

    await expect(harness.runCli(["remove", "empty"])).resolves.toMatchObject({
      exitCode: 0,
    });
    await expect(
      harness.runCli(["remove", "archive", "--recursive"]),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(harness.sdk.callsTo("files.remove")).toEqual([
      [
        {
          path: path.join(rootPath, "empty"),
          rootPath,
          recursive: false,
        },
      ],
      [
        {
          path: path.join(rootPath, "archive"),
          rootPath,
          recursive: true,
        },
      ],
    ]);
  });

  it("persists a manual file order per vault folder", async () => {
    const { harness } = await loadNotebook({
      "first.md": "# First",
      "second.md": "# Second",
    });

    await expect(
      harness.callRpc("reorderFiles", {
        vaultId: "personal",
        parent: "",
        paths: ["second.md", "first.md"],
      }),
    ).resolves.toEqual({ paths: ["second.md", "first.md"] });

    await expect(
      harness.callRpc("listNotes", { vaultId: "personal" }),
    ).resolves.toMatchObject({
      entryOrder: ["second.md", "first.md"],
    });
  });

  it("keeps nested mutations confined to the selected vault root", async () => {
    const { harness } = await loadNotebook({ "draft.md": "# Draft" });
    const rootPath = temporaryDirectories[0]!;

    await expect(
      harness.callRpc("createFolder", {
        vaultId: "personal",
        path: "projects",
      }),
    ).resolves.toEqual({ path: "projects" });
    await expect(
      harness.callRpc("movePath", {
        vaultId: "personal",
        from: "draft.md",
        to: "projects/plan.md",
      }),
    ).resolves.toEqual({ path: "projects/plan.md" });

    expect(harness.sdk.callsTo("files.mkdir")).toEqual([
      [
        {
          path: path.join(rootPath, "projects"),
          rootPath,
          recursive: false,
        },
      ],
    ]);
    expect(harness.sdk.callsTo("files.move")).toEqual([
      [
        {
          sourcePath: path.join(rootPath, "draft.md"),
          destinationPath: path.join(rootPath, "projects", "plan.md"),
          rootPath,
        },
      ],
    ]);
  });

  it("opens and saves absolute host Markdown files for the file opener", async () => {
    const { harness } = await loadNotebook({ "plan.md": "# Plan" });
    const rootPath = temporaryDirectories[0]!;
    const filePath = path.join(rootPath, "plan.md");
    const source = {
      kind: "host",
      threadId: "thread_1",
      environmentId: null,
      projectId: "project_1",
    };

    await expect(
      harness.callRpc("openFile", { source, path: filePath }),
    ).resolves.toMatchObject({
      file: { content: "# Plan", sha256: "test-sha" },
      previewPath: "plan.md",
    });
    await expect(
      harness.callRpc("saveOpenedFile", {
        source,
        path: filePath,
        content: "# Updated",
        expectedSha256: "test-sha",
      }),
    ).resolves.toMatchObject({ outcome: "written", sha256: "written-sha" });
    expect(harness.sdk.callsTo("files.write").at(-1)).toEqual([
      {
        path: filePath,
        rootPath,
        content: "# Updated",
        expectedSha256: "test-sha",
      },
    ]);
  });

  it("routes explicit host opener reads, previews, and saves to that host", async () => {
    const rootPath = "/shared";
    const filePath = "/shared/plan.md";
    const host = createFakePluginHost({
      pluginId: "simple-notes",
      sdk: {
        files: {
          mkdir: async () => ({ ok: true as const }),
          read: async ({ hostId, path: openedPath }) => ({
            path: openedPath,
            content:
              hostId === "host_remote" ? "# Remote plan" : "# Primary plan",
            contentEncoding: "utf8" as const,
            mimeType: "text/markdown",
            sizeBytes: 13,
            modifiedAtMs: 1,
            sha256: hostId === "host_remote" ? "remote-sha" : "primary-sha",
          }),
          write: async ({ hostId }) => ({
            outcome: "written" as const,
            sha256:
              hostId === "host_remote"
                ? "remote-written-sha"
                : "primary-written-sha",
            sizeBytes: 21,
          }),
          createPreview: async ({ hostId }) => ({
            baseUrl:
              hostId === "host_remote" ? "/remote-preview" : "/primary-preview",
            expiresAtMs: Date.now() + 60_000,
          }),
        },
      },
    });
    await simpleNotes(host.bb);
    host.harness.sdk.calls.length = 0;
    const source = {
      kind: "host",
      threadId: "thread_1",
      environmentId: null,
      projectId: "project_1",
      experimental_hostId: "host_remote",
    };

    await expect(
      host.harness.callRpc("openFile", { source, path: filePath }),
    ).resolves.toEqual({
      file: {
        path: filePath,
        content: "# Remote plan",
        contentEncoding: "utf8",
        mimeType: "text/markdown",
        sizeBytes: 13,
        modifiedAtMs: 1,
        sha256: "remote-sha",
      },
      preview: expect.objectContaining({ baseUrl: "/remote-preview" }),
      previewPath: "plan.md",
    });
    await expect(
      host.harness.callRpc("saveOpenedFile", {
        source,
        path: filePath,
        content: "# Updated remote plan",
        expectedSha256: "remote-sha",
      }),
    ).resolves.toEqual({
      outcome: "written",
      sha256: "remote-written-sha",
      sizeBytes: 21,
    });

    expect(host.harness.sdk.callsTo("files.read")).toEqual([
      [{ hostId: "host_remote", path: filePath, rootPath }],
    ]);
    expect(host.harness.sdk.callsTo("files.createPreview")).toEqual([
      [{ hostId: "host_remote", rootPath }],
    ]);
    expect(host.harness.sdk.callsTo("files.write")).toEqual([
      [
        {
          hostId: "host_remote",
          path: filePath,
          rootPath,
          content: "# Updated remote plan",
          expectedSha256: "remote-sha",
        },
      ],
    ]);
  });

  it("routes project-backed workspace files through the selected or primary source", async () => {
    const host = createFakePluginHost({
      pluginId: "simple-notes",
      sdk: {
        files: {
          mkdir: async () => ({ ok: true as const }),
          read: async ({ path: openedPath }) => ({
            path: openedPath,
            content: "# Project plan",
            contentEncoding: "utf8" as const,
            mimeType: "text/markdown",
            sizeBytes: 14,
            modifiedAtMs: 1,
            sha256: "project-sha",
          }),
          write: async () => ({
            outcome: "written" as const,
            sha256: "project-written-sha",
            sizeBytes: 22,
          }),
          createPreview: async () => ({
            baseUrl: "/project-preview",
            expiresAtMs: Date.now() + 60_000,
          }),
        },
        projects: {
          get: async () => ({
            sources: [
              {
                hostId: "host_remote",
                path: "/remote/project",
                isDefault: true,
                type: "local_path",
              },
              {
                hostId: "host_primary",
                path: "/primary/project",
                isDefault: false,
                type: "local_path",
              },
            ],
          }),
        },
        system: {
          config: async () => ({ primaryHostId: "host_primary" }),
        },
      },
    });
    await simpleNotes(host.bb);
    host.harness.sdk.calls.length = 0;
    const selectedSource = {
      kind: "workspace",
      threadId: null,
      environmentId: null,
      projectId: "project_1",
      experimental_hostId: "host_remote",
    };

    await expect(
      host.harness.callRpc("openFile", {
        source: selectedSource,
        path: "docs/plan.md",
      }),
    ).resolves.toMatchObject({ previewPath: "docs/plan.md" });
    await expect(
      host.harness.callRpc("saveOpenedFile", {
        source: selectedSource,
        path: "docs/plan.md",
        content: "# Updated project plan",
        expectedSha256: "project-sha",
      }),
    ).resolves.toMatchObject({ outcome: "written" });
    await expect(
      host.harness.callRpc("openFile", {
        source: {
          kind: "workspace",
          threadId: null,
          environmentId: null,
          projectId: "project_1",
        },
        path: "docs/plan.md",
      }),
    ).resolves.toMatchObject({
      previewPath: "docs/plan.md",
    });
    await expect(
      host.harness.callRpc("openFile", {
        source: { ...selectedSource, experimental_hostId: "host_missing" },
        path: "docs/plan.md",
      }),
    ).rejects.toThrow("This project has no workspace on the selected host");

    expect(host.harness.sdk.callsTo("projects.get")).toEqual([
      [{ projectId: "project_1" }],
      [{ projectId: "project_1" }],
      [{ projectId: "project_1" }],
      [{ projectId: "project_1" }],
    ]);
    expect(host.harness.sdk.callsTo("system.config")).toEqual([[]]);
    expect(host.harness.sdk.callsTo("files.read")).toEqual([
      [
        {
          hostId: "host_remote",
          path: "/remote/project/docs/plan.md",
          rootPath: "/remote/project",
        },
      ],
      [
        {
          hostId: "host_primary",
          path: "/primary/project/docs/plan.md",
          rootPath: "/primary/project",
        },
      ],
    ]);
    expect(host.harness.sdk.callsTo("files.createPreview")).toEqual([
      [{ hostId: "host_remote", rootPath: "/remote/project" }],
      [{ hostId: "host_primary", rootPath: "/primary/project" }],
    ]);
    expect(host.harness.sdk.callsTo("files.write")).toEqual([
      [
        {
          hostId: "host_remote",
          path: "/remote/project/docs/plan.md",
          rootPath: "/remote/project",
          content: "# Updated project plan",
          expectedSha256: "project-sha",
        },
      ],
    ]);
  });

  it("opens and saves thread-storage Markdown files on the thread's host", async () => {
    const storageRootPath = String.raw`C:\bb\thread-storage\thread_1`;
    const openedPath = String.raw`C:\bb\thread-storage\thread_1\reports\plan.md`;
    const host = createFakePluginHost({
      pluginId: "simple-notes",
      sdk: {
        files: {
          mkdir: async () => ({ ok: true as const }),
          read: async ({ path: filePath }) => ({
            path: filePath,
            content: "# Thread plan",
            contentEncoding: "utf8" as const,
            mimeType: "text/markdown",
            sizeBytes: 13,
            modifiedAtMs: 1,
            sha256: "thread-sha",
          }),
          write: async () => ({
            outcome: "written" as const,
            sha256: "updated-thread-sha",
            sizeBytes: 17,
          }),
          createPreview: async () => ({
            baseUrl: "/api/v1/file-previews/thread-storage",
            expiresAtMs: Date.now() + 60_000,
          }),
        },
        threads: {
          storageLocation: async () => ({
            hostId: "host_remote",
            storageRootPath,
          }),
        },
      },
    });
    await simpleNotes(host.bb);
    host.harness.sdk.calls.length = 0;
    const source = {
      kind: "thread-storage",
      threadId: "thread_1",
      environmentId: "stale_environment",
      projectId: "project_1",
    };

    await expect(
      host.harness.callRpc("openFile", {
        source,
        path: "reports/plan.md",
      }),
    ).resolves.toMatchObject({
      file: { content: "# Thread plan", sha256: "thread-sha" },
      previewPath: "reports/plan.md",
    });
    await expect(
      host.harness.callRpc("saveOpenedFile", {
        source,
        path: "reports/plan.md",
        content: "# Updated thread",
        expectedSha256: "thread-sha",
      }),
    ).resolves.toMatchObject({
      outcome: "written",
      sha256: "updated-thread-sha",
    });

    expect(host.harness.sdk.callsTo("threads.storageLocation")).toEqual([
      [{ threadId: "thread_1" }],
      [{ threadId: "thread_1" }],
    ]);
    expect(host.harness.sdk.callsTo("files.read")).toEqual([
      [
        {
          hostId: "host_remote",
          path: openedPath,
          rootPath: storageRootPath,
        },
      ],
    ]);
    expect(host.harness.sdk.callsTo("files.createPreview")).toEqual([
      [{ hostId: "host_remote", rootPath: storageRootPath }],
    ]);
    expect(host.harness.sdk.callsTo("files.write")).toEqual([
      [
        {
          hostId: "host_remote",
          path: openedPath,
          rootPath: storageRootPath,
          content: "# Updated thread",
          expectedSha256: "thread-sha",
        },
      ],
    ]);
  });

  it("rejects thread-storage paths that escape the confined root", async () => {
    const { harness } = await loadNotebook({ "plan.md": "# Plan" });

    await expect(
      harness.callRpc("openFile", {
        source: {
          kind: "thread-storage",
          threadId: "thread_1",
          environmentId: "environment_1",
          projectId: "project_1",
        },
        path: "../outside.md",
      }),
    ).rejects.toThrow("Invalid thread-storage path");
    expect(harness.sdk.callsTo("threads.storageLocation")).toEqual([]);
  });

  it("publishes watched filesystem changes without waiting for the poll", async () => {
    const changeListeners: Array<() => void> = [];
    const closeWatcher = vi.fn();
    const watchedRoots: string[] = [];
    const { harness } = await loadNotebook(
      { "plan.md": "# Plan" },
      (rootPath, onChange) => {
        watchedRoots.push(rootPath);
        changeListeners.push(onChange);
        return {
          close: closeWatcher,
          on: () => undefined,
        };
      },
    );
    const service = harness.runService("watch-vaults");
    try {
      expect(watchedRoots).toEqual([temporaryDirectories[0]]);
      const notifyChange = changeListeners[0];
      if (!notifyChange) {
        throw new Error("Expected vault watcher callback");
      }
      notifyChange();
      await waitForSignal(
        () =>
          harness.realtimeSignals.some(
            (signal) =>
              signal.channel === "vault-changed" &&
              isRecord(signal.payload) &&
              signal.payload.vaultId === "personal",
          ),
        1_000,
      );
    } finally {
      service.controller.abort();
      await service.done;
    }
    expect(closeWatcher).toHaveBeenCalledOnce();
  });
});
