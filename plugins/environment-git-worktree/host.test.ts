import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it } from "vitest";
import { createWorktreeHostEntry } from "./host.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "bb",
      GIT_AUTHOR_EMAIL: "bb@example.com",
      GIT_COMMITTER_NAME: "bb",
      GIT_COMMITTER_EMAIL: "bb@example.com",
    },
  });
  return result.stdout;
}

async function createSourceRepository(): Promise<{
  root: string;
  sourcePath: string;
  dataDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "bb-worktree-plugin-"));
  temporaryRoots.push(root);
  const sourcePath = join(root, "repo");
  const dataDir = join(root, "plugin-data");
  await execFileAsync("mkdir", ["-p", sourcePath, dataDir]);
  await git(sourcePath, "init", "--initial-branch=main");
  await writeFile(join(sourcePath, "README.md"), "hello\n");
  await git(sourcePath, "add", ".");
  await git(sourcePath, "commit", "-m", "initial");
  return { root, sourcePath, dataDir };
}

async function createDetachedSingleBranchRepository(): Promise<{
  root: string;
  sourcePath: string;
  dataDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "bb-worktree-plugin-detached-"));
  temporaryRoots.push(root);
  const originPath = join(root, "origin");
  const sourcePath = join(root, "repo");
  const dataDir = join(root, "plugin-data");
  await execFileAsync("mkdir", ["-p", originPath, dataDir]);
  await git(originPath, "init", "--initial-branch=main");
  await writeFile(join(originPath, "README.md"), "hello\n");
  await git(originPath, "add", ".");
  await git(originPath, "commit", "-m", "initial");
  await git(originPath, "tag", "v1.0");
  await git(
    root,
    "clone",
    "--single-branch",
    "--branch",
    "v1.0",
    originPath,
    sourcePath,
  );
  return { root, sourcePath, dataDir };
}

function createHarness(dataDir: string) {
  return experimental_createHostEntryHarness(createWorktreeHostEntry(), {
    experimental_paths: { dataDir, tempDir: join(dataDir, "tmp") },
  });
}

function createInput(args: {
  operationId: string;
  sourcePath: string;
  pathKey: string;
  branchName: string;
}) {
  return {
    ...args,
    baseBranch: { kind: "default" as const },
    branchMode: "reset" as const,
    setupTimeoutMs: 30_000,
  };
}

function progressText(harness: ReturnType<typeof createHarness>): string {
  return harness
    .experimental_getSignals()
    .map((event) => event.payload.text)
    .join("\n");
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("worktree host entry", () => {
  it("creates a worktree on a named base under the path-key directory", async () => {
    const { sourcePath, dataDir } = await createSourceRepository();
    await git(sourcePath, "branch", "release");
    await git(sourcePath, "checkout", "release");
    await writeFile(join(sourcePath, "release.txt"), "release\n");
    await git(sourcePath, "add", ".");
    await git(sourcePath, "commit", "-m", "release only");
    await git(sourcePath, "checkout", "main");
    const harness = createHarness(dataDir);
    const result = await harness.experimental_call("create", {
      operationId: "named",
      sourcePath,
      pathKey: "thr_1",
      branchName: "bb/named-thr_1",
      baseBranch: { kind: "named", name: "release" },
      branchMode: "reset",
      setupTimeoutMs: 30_000,
    });
    expect(result).toMatchObject({
      status: "created",
      path: join(dataDir, "worktrees", "thr_1", "repo"),
      baseBranch: "release",
    });
    if (result.status !== "created") throw new Error(result.message);
    expect(existsSync(join(result.path, "release.txt"))).toBe(true);
    expect(
      (await git(result.path, "rev-parse", "--abbrev-ref", "HEAD")).trim(),
    ).toBe("bb/named-thr_1");
    await harness.experimental_dispose();
  });

  it("creates on an explicit base from a detached single-branch checkout", async () => {
    const { sourcePath, dataDir } =
      await createDetachedSingleBranchRepository();
    const harness = createHarness(dataDir);
    const result = await harness.experimental_call("create", {
      operationId: "detached",
      sourcePath,
      pathKey: "thr_detached",
      branchName: "bb/detached-thr",
      baseBranch: { kind: "named", name: "v1.0" },
      branchMode: "reset",
      setupTimeoutMs: 30_000,
    });
    expect(result).toMatchObject({
      status: "created",
      path: join(dataDir, "worktrees", "thr_detached", "repo"),
      baseBranch: "v1.0",
    });
    if (result.status !== "created") throw new Error(result.message);
    expect(existsSync(join(result.path, "README.md"))).toBe(true);
    await harness.experimental_dispose();
  });

  it("re-runs create with the same path key without replacing a valid worktree", async () => {
    const { sourcePath, dataDir } = await createSourceRepository();
    const input = createInput({
      operationId: "first",
      sourcePath,
      pathKey: "same-path-key",
      branchName: "bb/restart",
    });
    const firstHarness = createHarness(dataDir);
    const first = await firstHarness.experimental_call("create", input);
    if (first.status !== "created") throw new Error(first.message);
    await writeFile(join(first.path, "survives.txt"), "kept\n");
    await firstHarness.experimental_dispose();

    const restartedHarness = createHarness(dataDir);
    const resumed = await restartedHarness.experimental_call("create", {
      ...input,
      operationId: "resumed",
    });
    expect(resumed).toEqual(first);
    expect(existsSync(join(first.path, "survives.txt"))).toBe(true);
    await restartedHarness.experimental_dispose();
  });

  it("resumes setup when a crash leaves the worktree without a completion record", async () => {
    const { root, sourcePath, dataDir } = await createSourceRepository();
    const setupMarker = join(root, "setup.marker");
    await writeFile(
      join(sourcePath, ".bb-env-setup.sh"),
      `#!/usr/bin/env bash\necho resumed > ${setupMarker}\n`,
    );
    await git(sourcePath, "add", ".");
    await git(sourcePath, "commit", "-m", "add setup script");
    const pathKey = "interrupted";
    const branchName = "bb/interrupted";
    const targetPath = join(dataDir, "worktrees", pathKey, "repo");
    await mkdir(join(dataDir, "worktrees", pathKey), { recursive: true });
    await git(
      sourcePath,
      "worktree",
      "add",
      "-B",
      branchName,
      targetPath,
      "main",
    );

    const harness = createHarness(dataDir);
    const resumed = await harness.experimental_call(
      "create",
      createInput({
        operationId: "resume-interrupted",
        sourcePath,
        pathKey,
        branchName,
      }),
    );

    expect(resumed).toMatchObject({ status: "created", path: targetPath });
    expect(existsSync(setupMarker)).toBe(true);
    expect(progressText(harness)).toContain("Running .bb-env-setup.sh");
    await harness.experimental_dispose();
  });

  it("replaces an invalid target before recreating the expected branch", async () => {
    const { sourcePath, dataDir } = await createSourceRepository();
    const harness = createHarness(dataDir);
    const input = createInput({
      operationId: "first",
      sourcePath,
      pathKey: "replace",
      branchName: "bb/expected",
    });
    const first = await harness.experimental_call("create", input);
    if (first.status !== "created") throw new Error(first.message);
    await git(first.path, "checkout", "-b", "wrong-branch");
    const replaced = await harness.experimental_call("create", {
      ...input,
      operationId: "retry",
    });
    expect(replaced.status).toBe("created");
    expect(
      (await git(first.path, "rev-parse", "--abbrev-ref", "HEAD")).trim(),
    ).toBe("bb/expected");
    await harness.experimental_dispose();
  });

  it("streams setup progress through host signals", async () => {
    const { sourcePath, dataDir } = await createSourceRepository();
    await writeFile(
      join(sourcePath, ".bb-env-setup.sh"),
      "#!/usr/bin/env bash\necho setup-line-one\necho setup-line-two\n",
    );
    await git(sourcePath, "add", ".");
    await git(sourcePath, "commit", "-m", "add setup script");
    const harness = createHarness(dataDir);
    expect(
      await harness.experimental_call(
        "create",
        createInput({
          operationId: "setup",
          sourcePath,
          pathKey: "thr_3",
          branchName: "bb/setup-thr_3",
        }),
      ),
    ).toMatchObject({ status: "created" });
    expect(progressText(harness)).toContain("Running .bb-env-setup.sh");
    expect(progressText(harness)).toContain("setup-line-one");
    expect(progressText(harness)).toContain("setup-line-two");
    expect(
      harness
        .experimental_getSignals()
        .every((event) => event.payload.operationId === "setup"),
    ).toBe(true);
    await harness.experimental_dispose();
  });

  it("leaves a dirty earlier attempt alone when it holds the branch", async () => {
    const { sourcePath, dataDir } = await createSourceRepository();
    const harness = createHarness(dataDir);
    const first = await harness.experimental_call(
      "create",
      createInput({
        operationId: "first",
        sourcePath,
        pathKey: "thr_7",
        branchName: "bb/dirty-thr_7",
      }),
    );
    if (first.status !== "created") throw new Error(first.message);
    await writeFile(join(first.path, "notes.txt"), "work in progress\n");
    const retry = await harness.experimental_call(
      "create",
      createInput({
        operationId: "retry",
        sourcePath,
        pathKey: "thr_7-2",
        branchName: "bb/dirty-thr_7",
      }),
    );
    expect(retry).toMatchObject({
      status: "failed",
      message: expect.stringContaining("uncommitted changes"),
    });
    expect(existsSync(join(first.path, "notes.txt"))).toBe(true);
    await harness.experimental_dispose();
  });

  it("aborts setup and then removes the partial path by path key", async () => {
    const { sourcePath, dataDir } = await createSourceRepository();
    await writeFile(
      join(sourcePath, ".bb-env-setup.sh"),
      "#!/usr/bin/env bash\necho started\nsleep 120\n",
    );
    await git(sourcePath, "add", ".");
    await git(sourcePath, "commit", "-m", "add slow setup script");
    const harness = createHarness(dataDir);
    const controller = new AbortController();
    const creating = harness.experimental_call(
      "create",
      {
        ...createInput({
          operationId: "cancel",
          sourcePath,
          pathKey: "thr_5",
          branchName: "bb/cancel-thr_5",
        }),
        setupTimeoutMs: 120_000,
      },
      { signal: controller.signal },
    );
    await expect.poll(() => progressText(harness)).toContain("started");
    controller.abort();
    await expect(creating).rejects.toThrow(/cancel/i);
    expect(
      await harness.experimental_call("remove", {
        operationId: "cleanup",
        pathKey: "thr_5",
        path: null,
        teardownTimeoutMs: 30_000,
      }),
    ).toEqual({ status: "removed" });
    expect(existsSync(join(dataDir, "worktrees", "thr_5"))).toBe(false);
    await harness.experimental_dispose();
  });

  it("runs teardown, kills workspace processes, and prunes the path-key parent", async () => {
    const { root, sourcePath, dataDir } = await createSourceRepository();
    await writeFile(
      join(sourcePath, ".bb-env-teardown.sh"),
      `#!/usr/bin/env bash\necho teardown-ran > ${join(root, "teardown.marker")}\necho tearing-down\n`,
    );
    await git(sourcePath, "add", ".");
    await git(sourcePath, "commit", "-m", "add teardown script");
    const harness = createHarness(dataDir);
    const created = await harness.experimental_call(
      "create",
      createInput({
        operationId: "create",
        sourcePath,
        pathKey: "thr_6",
        branchName: "bb/teardown-thr_6",
      }),
    );
    if (created.status !== "created") throw new Error(created.message);
    const lingering = spawn("sleep", ["300"], {
      cwd: created.path,
      detached: true,
      stdio: "ignore",
    });
    lingering.unref();
    const removed = await harness.experimental_call("remove", {
      operationId: "remove",
      pathKey: "thr_6",
      path: created.path,
      teardownTimeoutMs: 30_000,
    });
    const lingeringAlive = isPidAlive(lingering.pid ?? 0);
    lingering.kill("SIGKILL");
    expect(removed).toEqual({ status: "removed" });
    expect(lingeringAlive).toBe(false);
    expect(progressText(harness)).toContain("tearing-down");
    expect(existsSync(join(root, "teardown.marker"))).toBe(true);
    expect(existsSync(created.path)).toBe(false);
    expect(await readdir(join(dataDir, "worktrees"))).toEqual([]);
    await harness.experimental_dispose();
  });
});
