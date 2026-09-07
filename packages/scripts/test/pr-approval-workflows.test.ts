import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function stepScript(workflow: string, step: string): string {
  const lines = readFileSync(
    resolve(repoRoot, ".github/workflows", workflow),
    "utf8",
  ).split("\n");
  const stepIndex = lines.indexOf(`      - name: ${step}`);
  const runIndex = lines.indexOf("        run: |", stepIndex);
  let end = runIndex + 1;
  while (
    end < lines.length &&
    (lines[end] === "" || lines[end]?.startsWith("          "))
  )
    end += 1;
  return lines
    .slice(runIndex + 1, end)
    .map((line) => line.slice(10))
    .join("\n");
}

function run(script: string, env: Record<string, string>) {
  return spawnSync("bash", ["-c", script], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

it("keeps trusted automation pull requests open", () => {
  const script = `gh() { printf '%s\\n' "$*"; }\n${stepScript("pr-gate.yml", "Check approval and close unapproved PRs")}`;
  const gate = (author: string) =>
    run(script, {
      PR_AUTHOR: author,
      PR_ASSOCIATION: "NONE",
      PR_NUMBER: "123",
      GITHUB_REPOSITORY: "get-bb/bb",
    });
  for (const author of ["bb-slop-cop[bot]", "dependabot[bot]"]) {
    const result = gate(author);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--remove-label needs-approval");
    expect(result.stdout).not.toContain("pr close");
  }
  expect(gate("untrusted-automation[bot]").stdout).toContain("pr close");
});

it("parses only complete GitHub user and bot approval commands", () => {
  const workflow = stepScript("approve-contributor.yml", "Add name and push");
  const parser = `${workflow.slice(0, workflow.indexOf("list_path="))}printf '%s' "$target"`;
  for (const [comment, target] of [
    ["/approve @trusted-user", "trusted-user"],
    ["/approve @dependabot[bot]", "dependabot[bot]"],
  ]) {
    const result = run(parser, { COMMENT_BODY: comment });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(target);
  }
  for (const comment of [
    "/approve @bad-",
    "/approve @bad--name",
    "/approve @dependabot[bot] trailing",
    "/approve @user; echo unsafe",
  ]) {
    expect(run(parser, { COMMENT_BODY: comment }).status).not.toBe(0);
  }
});
