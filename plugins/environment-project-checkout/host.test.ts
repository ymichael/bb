import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it } from "vitest";
import { createCheckoutHostEntry } from "./host.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

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

async function createRepository(): Promise<{ repo: string; dataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "bb-checkout-plugin-"));
  temporaryRoots.push(root);
  const repo = join(root, "repo");
  const dataDir = join(root, "plugin-data");
  await execFileAsync("mkdir", ["-p", repo, dataDir]);
  await git(repo, "init", "--initial-branch=main");
  await writeFile(join(repo, "README.md"), "hello\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial");
  return { repo, dataDir };
}

function createHarness(dataDir: string) {
  return experimental_createHostEntryHarness(createCheckoutHostEntry(), {
    experimental_paths: { dataDir, tempDir: join(dataDir, "tmp") },
  });
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

describe("checkout host entry", () => {
  it("attaches to the checkout as it is", async () => {
    const { repo, dataDir } = await createRepository();
    const harness = createHarness(dataDir);
    const result = await harness.experimental_call("attach", {
      operationId: "plain",
      path: repo,
      branch: null,
    });
    expect(result).toEqual({
      status: "attached",
      path: repo,
      branchName: "main",
    });
    expect(progressText(harness)).not.toContain("Using");
    await harness.experimental_dispose();
  });

  it("switches to an existing branch and creates a new one from a base", async () => {
    const { repo, dataDir } = await createRepository();
    await git(repo, "branch", "release");
    const harness = createHarness(dataDir);

    const existing = await harness.experimental_call("attach", {
      operationId: "existing",
      path: repo,
      branch: { kind: "existing", name: "release" },
    });
    expect(existing.status).toBe("attached");
    expect((await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).trim()).toBe(
      "release",
    );
    expect(progressText(harness)).toContain("Switched to branch release");

    const created = await harness.experimental_call("attach", {
      operationId: "new",
      path: repo,
      branch: { kind: "new", name: "bb/feature-thr_1", baseBranch: "main" },
    });
    expect(created.status).toBe("attached");
    expect((await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).trim()).toBe(
      "bb/feature-thr_1",
    );
    expect(progressText(harness)).toContain("Created branch bb/feature-thr_1");
    await harness.experimental_dispose();
  });

  it("resumes the same branch switch idempotently after restart", async () => {
    const { repo, dataDir } = await createRepository();
    await git(repo, "branch", "release");
    const first = createHarness(dataDir);
    expect(
      await first.experimental_call("attach", {
        operationId: "same-path-key-1",
        path: repo,
        branch: { kind: "existing", name: "release" },
      }),
    ).toMatchObject({ status: "attached", branchName: "release" });
    await first.experimental_dispose();

    const restarted = createHarness(dataDir);
    expect(
      await restarted.experimental_call("attach", {
        operationId: "same-path-key-2",
        path: repo,
        branch: { kind: "existing", name: "release" },
      }),
    ).toMatchObject({ status: "attached", branchName: "release" });
    expect((await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).trim()).toBe(
      "release",
    );
    await restarted.experimental_dispose();
  });

  it("refuses to switch branches over uncommitted changes", async () => {
    const { repo, dataDir } = await createRepository();
    await git(repo, "branch", "release");
    await writeFile(join(repo, "README.md"), "edited\n");
    const harness = createHarness(dataDir);
    const result = await harness.experimental_call("attach", {
      operationId: "dirty",
      path: repo,
      branch: { kind: "existing", name: "release" },
    });
    expect(result).toMatchObject({
      status: "failed",
      message: expect.stringContaining("uncommitted changes"),
    });
    expect((await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).trim()).toBe(
      "main",
    );
    await harness.experimental_dispose();
  });

  it("inspects dirty and detached checkouts", async () => {
    const { repo, dataDir } = await createRepository();
    await writeFile(join(repo, "README.md"), "edited\n");
    const harness = createHarness(dataDir);
    expect(
      await harness.experimental_call("inspectCheckout", { path: repo }),
    ).toMatchObject({
      isGitRepo: true,
      checkout: { kind: "branch", branchName: "main" },
      hasUncommittedChanges: true,
      operation: { kind: "none" },
    });
    await git(repo, "checkout", "--detach", "HEAD");
    expect(
      await harness.experimental_call("inspectCheckout", { path: repo }),
    ).toMatchObject({
      isGitRepo: true,
      checkout: { kind: "detached" },
      operation: { kind: "none" },
    });
    await harness.experimental_dispose();
  });

  it("fails a plain attach on a missing directory", async () => {
    const { dataDir } = await createRepository();
    const harness = createHarness(dataDir);
    const result = await harness.experimental_call("attach", {
      operationId: "missing",
      path: join(dataDir, "nope"),
      branch: null,
    });
    expect(result).toMatchObject({
      status: "failed",
      message: expect.stringContaining("does not exist"),
    });
    await harness.experimental_dispose();
  });
});
