import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface GitCommandArgs {
  args: string[];
  cwd: string;
}

export interface TestGitRepo {
  cleanup: () => Promise<void>;
  path: string;
}

async function runGitCommand(args: GitCommandArgs): Promise<void> {
  await execFileAsync("git", args.args, {
    cwd: args.cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: "bb-tests@example.com",
      GIT_AUTHOR_NAME: "bb tests",
      GIT_COMMITTER_EMAIL: "bb-tests@example.com",
      GIT_COMMITTER_NAME: "bb tests",
    },
  });
}

export async function createTestGitRepo(): Promise<TestGitRepo> {
  const repoPath = await mkdtemp(path.join(tmpdir(), "bb-server-thread-repo-"));
  await runGitCommand({ cwd: repoPath, args: ["init", "--initial-branch=main"] });
  await writeFile(path.join(repoPath, "README.md"), "# thread test repo\n", "utf8");
  await runGitCommand({ cwd: repoPath, args: ["add", "README.md"] });
  await runGitCommand({ cwd: repoPath, args: ["commit", "-m", "Initial commit"] });

  return {
    path: repoPath,
    cleanup: async () => {
      await rm(repoPath, { recursive: true, force: true });
    },
  };
}
