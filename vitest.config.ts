import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";
import { SharedWorkerSequencer } from "./vitest.shared.js";

const workspaceRoots = [
  "apps",
  "packages",
  "tests",
  "examples/plugins",
] as const;

function discoverVitestProjects(): string[] {
  return workspaceRoots
    .flatMap((workspaceRoot) =>
      readdirSync(path.resolve(workspaceRoot), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(workspaceRoot, entry.name))
        .filter((projectPath) =>
          existsSync(path.resolve(projectPath, "vitest.config.ts")),
        ),
    )
    .sort((a, b) => a.localeCompare(b));
}

export default defineConfig({
  test: {
    silent: "passed-only",
    sequence: { sequencer: SharedWorkerSequencer },
    projects: discoverVitestProjects(),
  },
});
