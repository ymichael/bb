import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeSkillRoot } from "@bb/agent-runtime";
import type {
  HostDaemonInjectedSkillSource,
  HostDaemonSkillTree,
} from "@bb/host-daemon-contract";
import {
  cleanupInjectedSkillStagingDirs,
  ensureDataDirSkillsRootPath,
  MAX_SKILL_STORE_TREES,
  stageInjectedSkillSources,
} from "./injected-skills.js";

interface WriteSkillArgs {
  body?: string;
  name: string;
  rootPath: string;
}

interface StageSourceArgs {
  dataDir: string;
  skillRootPath: string;
  skillName: string;
}

interface CapturedWarning {
  context: object;
  message: string;
}

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "bb-host-skills-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function requireSkillRoot(
  roots: readonly AgentRuntimeSkillRoot[],
): AgentRuntimeSkillRoot {
  const [root, ...rest] = roots;
  if (root === undefined || rest.length > 0) {
    throw new Error(
      `Expected exactly one staged skill root, got ${roots.length}`,
    );
  }
  return root;
}

async function writeSkill(args: WriteSkillArgs): Promise<string> {
  const skillRootPath = path.join(args.rootPath, args.name);
  await mkdir(path.join(skillRootPath, "references"), { recursive: true });
  await writeFile(
    path.join(skillRootPath, "SKILL.md"),
    [
      "---",
      `name: ${args.name}`,
      `description: Use ${args.name} when host staging tests run.`,
      "---",
      "",
      args.body ?? "# Skill",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(skillRootPath, "references", "notes.md"),
    "supporting notes\n",
    "utf8",
  );
  return skillRootPath;
}

function createDataDirSource(
  args: StageSourceArgs,
): HostDaemonInjectedSkillSource {
  return {
    kind: "workspace-path",
    sourceType: "project",
    name: args.skillName,
    description: `Use ${args.skillName} when host staging tests run.`,
    sourceRootPath: args.skillRootPath,
    skillFilePath: path.join(args.skillRootPath, "SKILL.md"),
  };
}

function createTreePayload(
  name: string,
  token = "tree bytes",
): HostDaemonSkillTree {
  const entries = [
    {
      path: "SKILL.md",
      mode: 0o644,
      contentBase64: Buffer.from(
        `---\nname: ${name}\ndescription: Use ${name} in pull tests.\n---\n\n${token}\n`,
      ).toString("base64"),
    },
    {
      path: "scripts/run.sh",
      mode: 0o755,
      contentBase64: Buffer.from("#!/bin/sh\necho synced\n").toString("base64"),
    },
  ];
  entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const hash = createHash("sha256");
  hash.update("bb-skill-tree-v1");
  for (const entry of entries) {
    const bytes = Buffer.from(entry.contentBase64, "base64");
    hash.update("\0file\0");
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.mode.toString(8));
    hash.update("\0");
    hash.update(String(bytes.length));
    hash.update("\0");
    hash.update(bytes);
  }
  return { treeHash: hash.digest("hex"), entries };
}

async function seedStoredTree(
  dataDir: string,
  tree: HostDaemonSkillTree,
): Promise<string> {
  const treeRootPath = path.join(
    dataDir,
    "runtime",
    "skill-store",
    tree.treeHash,
  );
  const contentRootPath = path.join(treeRootPath, "content");
  await Promise.all(
    tree.entries.map(async (entry) => {
      const destinationPath = path.join(contentRootPath, entry.path);
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await writeFile(
        destinationPath,
        Buffer.from(entry.contentBase64, "base64"),
        { mode: entry.mode },
      );
    }),
  );
  await Promise.all([
    writeFile(path.join(treeRootPath, ".complete"), "complete\n"),
    writeFile(path.join(treeRootPath, ".last-used"), ""),
  ]);
  return treeRootPath;
}

function createTreeSource(
  name: string,
  treeHash: string,
): HostDaemonInjectedSkillSource {
  return {
    kind: "tree",
    sourceType: "data-dir",
    name,
    description: `Use ${name} in pull tests.`,
    treeHash,
    entryPath: "SKILL.md",
  };
}

describe("data-dir skills root", () => {
  it("creates the global skills root so the watcher can subscribe", async () => {
    const dataDir = await makeTempDir();

    const skillsRootPath = await ensureDataDirSkillsRootPath(dataDir);

    expect(skillsRootPath).toBe(path.join(dataDir, "skills"));
    await expect(
      lstat(skillsRootPath).then((stats) => stats.isDirectory()),
    ).resolves.toBe(true);
  });
});

describe("injected skill staging", () => {
  it("pulls a missing tree, stages identical bytes and modes, and reuses the store", async () => {
    const dataDir = await makeTempDir();
    const payload = createTreePayload("synced-skill");
    const fetchSkillTree = vi.fn(async () => payload);
    const source = createTreeSource("synced-skill", payload.treeHash);

    const first = await stageInjectedSkillSources({
      dataDir,
      fetchSkillTree,
      injectedSkillSources: [source],
    });
    await stageInjectedSkillSources({
      dataDir,
      fetchSkillTree,
      injectedSkillSources: [source],
    });

    const stagedScript = path.join(
      requireSkillRoot(first.skillRoots).path,
      "synced-skill",
      "scripts",
      "run.sh",
    );
    await expect(readFile(stagedScript, "utf8")).resolves.toBe(
      "#!/bin/sh\necho synced\n",
    );
    await expect(
      lstat(stagedScript).then((stat) => stat.mode & 0o777),
    ).resolves.toBe(0o755);
    expect(fetchSkillTree).toHaveBeenCalledTimes(1);
    expect(fetchSkillTree).toHaveBeenCalledWith(payload.treeHash);
  });

  it("surfaces a failed required tree pull instead of silently skipping it", async () => {
    const dataDir = await makeTempDir();
    const payload = createTreePayload("failed-pull");
    const warnings: CapturedWarning[] = [];
    const failure = new Error("server unavailable");

    await expect(
      stageInjectedSkillSources({
        dataDir,
        fetchSkillTree: async () => Promise.reject(failure),
        injectedSkillSources: [
          createTreeSource("failed-pull", payload.treeHash),
        ],
        logger: {
          debug: () => undefined,
          warn: (context, message) => warnings.push({ context, message }),
        },
      }),
    ).rejects.toThrow("server unavailable");
    expect(warnings).toEqual([
      expect.objectContaining({
        message: "Failed to pull required injected skill tree",
      }),
    ]);
  });

  it("rejects fetched tree content that does not match its declared hash", async () => {
    const dataDir = await makeTempDir();
    const payload = createTreePayload("tampered-tree");
    const tampered = {
      ...payload,
      entries: payload.entries.map((entry, index) =>
        index === 0
          ? {
              ...entry,
              contentBase64: Buffer.from("tampered\n").toString("base64"),
            }
          : entry,
      ),
    };

    await expect(
      stageInjectedSkillSources({
        dataDir,
        fetchSkillTree: async () => tampered,
        injectedSkillSources: [
          createTreeSource("tampered-tree", payload.treeHash),
        ],
      }),
    ).rejects.toThrow("Fetched skill tree content hash mismatch");
  });

  it("verifies Unicode paths with locale-independent code-point ordering", async () => {
    const dataDir = await makeTempDir();
    const entries = ["ä", "z", "A", "a"].map((entryPath) => ({
      path: entryPath,
      mode: 0o644,
      contentBase64: Buffer.from(entryPath).toString("base64"),
    }));
    entries.push({
      path: "SKILL.md",
      mode: 0o644,
      contentBase64: Buffer.from(
        "---\nname: unicode-paths\ndescription: Use Unicode paths in tests.\n---\n",
      ).toString("base64"),
    });
    const hash = createHash("sha256");
    hash.update("bb-skill-tree-v1");
    for (const entry of [...entries].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    )) {
      const bytes = Buffer.from(entry.contentBase64, "base64");
      hash.update("\0file\0");
      hash.update(entry.path);
      hash.update("\0");
      hash.update(entry.mode.toString(8));
      hash.update("\0");
      hash.update(String(bytes.length));
      hash.update("\0");
      hash.update(bytes);
    }
    const payload = { treeHash: hash.digest("hex"), entries };

    await expect(
      stageInjectedSkillSources({
        dataDir,
        fetchSkillTree: async () => payload,
        injectedSkillSources: [
          createTreeSource("unicode-paths", payload.treeHash),
        ],
      }),
    ).resolves.toMatchObject({ skillRoots: expect.any(Array) });
  });

  it("garbage-collects the least-recently-used trees beyond the store cap", async () => {
    const dataDir = await makeTempDir();
    const residents = Array.from(
      { length: MAX_SKILL_STORE_TREES },
      (_, index) => {
        const name = `gc-skill-${index}`;
        return { name, payload: createTreePayload(name, `token-${index}`) };
      },
    );
    const residentRoots = await Promise.all(
      residents.map(({ payload }) => seedStoredTree(dataDir, payload)),
    );
    const oldestRoot = residentRoots[0];
    if (!oldestRoot) throw new Error("Expected an oldest resident tree");
    const oldest = new Date(1);
    await utimes(path.join(oldestRoot, ".last-used"), oldest, oldest);

    const name = "gc-newcomer";
    const payload = createTreePayload(name, "newcomer-token");
    await stageInjectedSkillSources({
      dataDir,
      fetchSkillTree: async () => payload,
      injectedSkillSources: [createTreeSource(name, payload.treeHash)],
    });

    const entries = await readdir(
      path.join(dataDir, "runtime", "skill-store"),
      {
        withFileTypes: true,
      },
    );
    expect(entries.filter((entry) => entry.isDirectory()).length).toBe(
      MAX_SKILL_STORE_TREES,
    );
    await expect(lstat(oldestRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      lstat(path.join(dataDir, "runtime", "skill-store", payload.treeHash)),
    ).resolves.toBeDefined();
  });

  it("exempts in-flight tree hashes from garbage collection", async () => {
    const dataDir = await makeTempDir();
    const storeRoot = path.join(dataDir, "runtime", "skill-store");
    const residents = Array.from(
      { length: MAX_SKILL_STORE_TREES },
      (_, index) => {
        const name = index === 0 ? "protected-skill" : `resident-${index}`;
        return {
          name,
          payload: createTreePayload(name, `resident-${index}`),
        };
      },
    );
    await Promise.all(
      residents.map(({ payload }) => seedStoredTree(dataDir, payload)),
    );
    const protectedTree = residents[0];
    if (!protectedTree) throw new Error("Expected a protected tree");
    const protectedRoot = path.join(storeRoot, protectedTree.payload.treeHash);
    const protectedContentRoot = path.join(protectedRoot, "content");
    let resumeCollection = (): void => undefined;
    const collectionBlocked = new Promise<void>((resolve) => {
      resumeCollection = resolve;
    });
    let reportCollectionBlocked = (): void => undefined;
    const collectionReached = new Promise<void>((resolve) => {
      reportCollectionBlocked = resolve;
    });
    const originalLstat = fs.lstat.bind(fs);
    const lstatSpy = vi
      .spyOn(fs, "lstat")
      .mockImplementation(async (targetPath) => {
        if (String(targetPath) === protectedContentRoot) {
          reportCollectionBlocked();
          await collectionBlocked;
        }
        return originalLstat(targetPath);
      });

    const protectedStage = stageInjectedSkillSources({
      dataDir,
      fetchSkillTree: async () => protectedTree.payload,
      injectedSkillSources: [
        createTreeSource(protectedTree.name, protectedTree.payload.treeHash),
      ],
    });
    try {
      await collectionReached;
      const oldest = new Date(1);
      await utimes(path.join(protectedRoot, ".last-used"), oldest, oldest);
      const newcomer = createTreePayload("newcomer");
      await stageInjectedSkillSources({
        dataDir,
        fetchSkillTree: async () => newcomer,
        injectedSkillSources: [createTreeSource("newcomer", newcomer.treeHash)],
      });
      resumeCollection();

      await expect(protectedStage).resolves.toMatchObject({
        skillRoots: expect.any(Array),
      });
      await expect(lstat(protectedRoot)).resolves.toBeDefined();
    } finally {
      resumeCollection();
      await protectedStage.catch(() => undefined);
      lstatSpy.mockRestore();
    }
  });

  it("creates a shared staged snapshot for Codex, Claude Code, Pi, and ACP", async () => {
    const dataDir = await makeTempDir();
    const skillRootPath = await writeSkill({
      rootPath: path.join(dataDir, "source-skills"),
      name: "release-notes",
    });

    const staged = await stageInjectedSkillSources({
      dataDir,
      injectedSkillSources: [
        createDataDirSource({
          dataDir,
          skillName: "release-notes",
          skillRootPath,
        }),
      ],
    });

    const root = requireSkillRoot(staged.skillRoots);
    const stageRootPath = path.join(
      dataDir,
      "runtime",
      "global-skills",
      staged.catalogHash,
    );
    expect(root).toEqual({
      id: `global-skills:${staged.catalogHash}`,
      path: path.join(stageRootPath, "skills"),
      skills: [
        {
          description: "Use release-notes when host staging tests run.",
          name: "release-notes",
        },
      ],
    });
    await expect(
      readFile(path.join(root.path, "release-notes", "SKILL.md"), "utf8"),
    ).resolves.toContain("name: release-notes");
    await expect(
      readFile(
        path.join(root.path, "release-notes", "references", "notes.md"),
        "utf8",
      ),
    ).resolves.toBe("supporting notes\n");
    await expect(
      readdir(stageRootPath).then((entries) => entries.sort()),
    ).resolves.toEqual(["catalog.json", "skills"]);
  });

  it("stages workspace-path skill sources into the shared catalog", async () => {
    const dataDir = await makeTempDir();
    const bundledRoot = await makeTempDir();
    const skillRootPath = await writeSkill({
      rootPath: bundledRoot,
      name: "workflow-help",
    });

    const staged = await stageInjectedSkillSources({
      dataDir,
      injectedSkillSources: [
        {
          kind: "workspace-path",
          sourceType: "project",
          name: "workflow-help",
          description: "Use workflow-help when host staging tests run.",
          sourceRootPath: skillRootPath,
          skillFilePath: path.join(skillRootPath, "SKILL.md"),
        },
      ],
    });

    const root = requireSkillRoot(staged.skillRoots);
    await expect(
      readFile(path.join(root.path, "workflow-help", "SKILL.md"), "utf8"),
    ).resolves.toContain("name: workflow-help");
    await expect(
      readFile(path.join(path.dirname(root.path), "catalog.json"), "utf8").then(
        (content) => JSON.parse(content),
      ),
    ).resolves.toMatchObject({
      catalogHash: staged.catalogHash,
      skills: [
        {
          name: "workflow-help",
          sourceRootPath: skillRootPath,
          sourceType: "project",
        },
      ],
    });
  });

  it("stages a read-only shared host path for every provider", async () => {
    const dataDir = await makeTempDir();
    const sourceRoot = await makeTempDir();
    const skillRootPath = await writeSkill({
      rootPath: sourceRoot,
      name: "shared-review",
    });

    const staged = await stageInjectedSkillSources({
      dataDir,
      injectedSkillSources: [
        {
          kind: "host-path",
          sourceType: "shared-user",
          name: "shared-review",
          description: "Use shared-review when host staging tests run.",
          sourceRootPath: skillRootPath,
          skillFilePath: path.join(skillRootPath, "SKILL.md"),
        },
      ],
    });

    const root = requireSkillRoot(staged.skillRoots);
    expect(root.skills.map((skill) => skill.name)).toEqual(["shared-review"]);
    await expect(
      readFile(path.join(root.path, "shared-review", "SKILL.md"), "utf8"),
    ).resolves.toContain("name: shared-review");
  });

  it("changes the catalog hash when skill content changes", async () => {
    const dataDir = await makeTempDir();
    const sourceRootPath = path.join(dataDir, "source-skills");
    const skillRootPath = await writeSkill({
      body: "first body",
      rootPath: sourceRootPath,
      name: "release-notes",
    });
    const source = createDataDirSource({
      dataDir,
      skillName: "release-notes",
      skillRootPath,
    });
    const first = await stageInjectedSkillSources({
      dataDir,
      injectedSkillSources: [source],
    });

    await writeFile(
      path.join(skillRootPath, "SKILL.md"),
      [
        "---",
        "name: release-notes",
        "description: Use release-notes when host staging tests run.",
        "---",
        "",
        "second body",
        "",
      ].join("\n"),
      "utf8",
    );
    const second = await stageInjectedSkillSources({
      dataDir,
      injectedSkillSources: [source],
    });

    expect(second.catalogHash).not.toBe(first.catalogHash);
  });

  it("stages the same catalog concurrently without sharing temp directories", async () => {
    const dataDir = await makeTempDir();
    const skillRootPath = await writeSkill({
      rootPath: path.join(dataDir, "source-skills"),
      name: "release-notes",
    });
    const source = createDataDirSource({
      dataDir,
      skillName: "release-notes",
      skillRootPath,
    });
    const fixedTime = vi.spyOn(Date, "now").mockReturnValue(1_781_053_873_372);

    try {
      const staged = await Promise.all(
        Array.from({ length: 12 }, () =>
          stageInjectedSkillSources({
            dataDir,
            injectedSkillSources: [source],
          }),
        ),
      );

      const catalogHashes = new Set(staged.map((entry) => entry.catalogHash));
      expect(catalogHashes.size).toBe(1);
      const firstStaged = staged[0];
      if (!firstStaged) {
        throw new Error("Expected staged skill catalogs");
      }
      for (const entry of staged) {
        expect(requireSkillRoot(entry.skillRoots).path).toBe(
          path.join(
            dataDir,
            "runtime",
            "global-skills",
            entry.catalogHash,
            "skills",
          ),
        );
      }
      await expect(
        readFile(
          path.join(
            dataDir,
            "runtime",
            "global-skills",
            firstStaged.catalogHash,
            "skills",
            "release-notes",
            "SKILL.md",
          ),
          "utf8",
        ),
      ).resolves.toContain("Use release-notes");
    } finally {
      fixedTime.mockRestore();
    }
  });

  it("skips symlinked files during staging", async () => {
    const dataDir = await makeTempDir();
    const outsideDir = await makeTempDir();
    const skillRootPath = await writeSkill({
      rootPath: path.join(dataDir, "source-skills"),
      name: "release-notes",
    });
    await writeFile(path.join(outsideDir, "escape.md"), "escape\n", "utf8");
    await symlink(
      path.join(outsideDir, "escape.md"),
      path.join(skillRootPath, "references", "escape.md"),
    );
    const warnings: CapturedWarning[] = [];

    const staged = await stageInjectedSkillSources({
      dataDir,
      injectedSkillSources: [
        createDataDirSource({
          dataDir,
          skillName: "release-notes",
          skillRootPath,
        }),
      ],
      logger: {
        debug: () => undefined,
        warn: (context, message) => {
          warnings.push({ context, message });
        },
      },
    });

    expect(staged.skillRoots).toEqual([]);
    expect(warnings).toEqual([
      expect.objectContaining({
        message: "Skipping injected skill during staging",
      }),
    ]);
  });
});

describe("cleanupInjectedSkillStagingDirs", () => {
  async function makeStagingRoot(): Promise<{
    dataDir: string;
    stagingRootPath: string;
  }> {
    const dataDir = await makeTempDir();
    const stagingRootPath = path.join(dataDir, "runtime", "global-skills");
    await mkdir(stagingRootPath, { recursive: true });
    return { dataDir, stagingRootPath };
  }

  async function exists(targetPath: string): Promise<boolean> {
    try {
      await access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  it("keeps fresh .tmp- dirs that may belong to an in-flight staging", async () => {
    const { dataDir, stagingRootPath } = await makeStagingRoot();
    const inFlightTempPath = path.join(stagingRootPath, ".tmp-hash-123-456");
    await mkdir(path.join(inFlightTempPath, "skills"), { recursive: true });

    await cleanupInjectedSkillStagingDirs({ dataDir, keepCatalogHashes: [] });

    expect(await exists(inFlightTempPath)).toBe(true);
  });

  it("removes stale .tmp- dirs left behind by crashed stagings", async () => {
    const { dataDir, stagingRootPath } = await makeStagingRoot();
    const staleTempPath = path.join(stagingRootPath, ".tmp-hash-789-101");
    await mkdir(staleTempPath, { recursive: true });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(staleTempPath, twoHoursAgo, twoHoursAgo);

    await cleanupInjectedSkillStagingDirs({ dataDir, keepCatalogHashes: [] });

    expect(await exists(staleTempPath)).toBe(false);
  });

  it("removes unkept catalog dirs while keeping kept ones", async () => {
    const { dataDir, stagingRootPath } = await makeStagingRoot();
    const keptPath = path.join(stagingRootPath, "hash-keep");
    const unkeptPath = path.join(stagingRootPath, "hash-drop");
    await mkdir(keptPath, { recursive: true });
    await mkdir(unkeptPath, { recursive: true });

    await cleanupInjectedSkillStagingDirs({
      dataDir,
      keepCatalogHashes: ["hash-keep"],
    });

    expect(await exists(keptPath)).toBe(true);
    expect(await exists(unkeptPath)).toBe(false);
  });
});

describe("concurrent staging", () => {
  it("lets parallel stagings of the same catalog all succeed", async () => {
    const dataDir = await makeTempDir();
    const skillRootPath = await writeSkill({
      rootPath: path.join(dataDir, "source-skills"),
      name: "release-notes",
    });
    const source = createDataDirSource({
      dataDir,
      skillName: "release-notes",
      skillRootPath,
    });

    const staged = await Promise.all(
      Array.from({ length: 8 }, () =>
        stageInjectedSkillSources({
          dataDir,
          injectedSkillSources: [source],
        }),
      ),
    );

    const hashes = new Set(staged.map((result) => result.catalogHash));
    expect(hashes.size).toBe(1);
    const [catalogHash] = hashes;
    await expect(
      readFile(
        path.join(
          dataDir,
          "runtime",
          "global-skills",
          catalogHash ?? "",
          "catalog.json",
        ),
        "utf8",
      ).then((content) => JSON.parse(content)),
    ).resolves.toMatchObject({ catalogHash });
  });
});
