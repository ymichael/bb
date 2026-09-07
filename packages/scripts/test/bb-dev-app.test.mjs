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
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const launcherPath = join(repoRoot, "scripts", "bb-dev-app");

function writeExecutable(path, source) {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function nodeWrapper(version, abi) {
  return `#!/usr/bin/env bash
if [[ "\${1:-}" == "-p" && "\${2:-}" == "process.version" ]]; then
  printf '%s\\n' ${JSON.stringify(`v${version}`)}
  exit 0
fi
if [[ "\${1:-}" == "-p" && "\${2:-}" == "process.versions.modules" ]]; then
  printf '%s\\n' ${JSON.stringify(abi)}
  exit 0
fi
if [[ "\${1:-}" == "-p" && "\${2:-}" == "process.versions.node.split('.')[0]" ]]; then
  printf '%s\\n' ${JSON.stringify(version.split(".")[0])}
  exit 0
fi
exec ${JSON.stringify(process.execPath)} "$@"
`;
}

describe("bb-dev-app", () => {
  it("keeps the caller's Node when another Node 22 version is installed", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "bb-dev-node-"));
    try {
      const callerBin = join(tempRoot, "caller-bin");
      const nvmRoot = join(tempRoot, "nvm");
      const installedNodeBin = join(
        nvmRoot,
        "versions",
        "node",
        "v22.23.2",
        "bin",
      );
      mkdirSync(callerBin, { recursive: true });
      mkdirSync(installedNodeBin, { recursive: true });
      writeExecutable(join(callerBin, "node"), nodeWrapper("24.18.0", "137"));
      writeExecutable(
        join(installedNodeBin, "node"),
        nodeWrapper("22.23.2", "127"),
      );
      writeExecutable(
        join(callerBin, "screen"),
        "#!/usr/bin/env bash\nexit 1\n",
      );
      writeExecutable(join(callerBin, "lsof"), "#!/usr/bin/env bash\nexit 0\n");

      const result = spawnSync("bash", [launcherPath, "status"], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          BB_DEV_REPO_ROOT: repoRoot,
          HOME: tempRoot,
          NVM_DIR: nvmRoot,
          PATH: `${callerBin}:${process.env.PATH ?? ""}`,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(
        `Node: v24.18.0 (ABI 137) at ${join(callerBin, "node")}`,
      );
      expect(result.stdout).not.toContain("Node: v22.23.2");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("pins the root engine floor for primary development", () => {
    const packageJson = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    );
    const nodePin = readFileSync(join(repoRoot, ".nvmrc"), "utf8").trim();

    expect(packageJson.engines.node).toBe(`>=${nodePin}`);
  });
});
