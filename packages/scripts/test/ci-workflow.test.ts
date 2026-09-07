import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "..", "..", "..");

it("limits concurrent Turbo test tasks to the CI runner CPU count", () => {
  const workflow = readFileSync(
    resolve(repoRoot, ".github", "workflows", "ci.yml"),
    "utf8",
  );
  const testStep = /- name: Test\n\s+run: ([^\n]+)/u.exec(workflow)?.[1];

  expect(testStep).toContain("--concurrency=4");
});

it("rejects a pnpm version that disagrees with the root manifest", () => {
  const fixture = mkdtempSync(join(tmpdir(), "bb-pnpm-version-"));
  onTestFinished(() => rmSync(fixture, { force: true, recursive: true }));
  const fakeBin = resolve(fixture, "bin");
  mkdirSync(fakeBin);
  writeFileSync(
    resolve(fixture, "package.json"),
    '{"packageManager":"pnpm@9.15.1"}\n',
  );
  writeFileSync(resolve(fakeBin, "curl"), "#!/bin/sh\nexit 23\n");
  chmodSync(resolve(fakeBin, "curl"), 0o755);

  const result = spawnSync(
    "bash",
    [resolve(repoRoot, ".github/actions/setup-workspace/install-pnpm.sh")],
    {
      cwd: fixture,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_WORKSPACE: fixture,
        PATH: `${fakeBin}:${process.env.PATH}`,
        PNPM_VERSION: "9.15.0",
      },
    },
  );

  expect(result.status).toBe(1);
  expect(result.stdout).toContain(
    "pnpm version mismatch: package.json declares 9.15.1, but the action requested 9.15.0",
  );
});
