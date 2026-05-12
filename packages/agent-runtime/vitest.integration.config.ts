import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import { workspaceTestAliases } from "../../vitest.workspace-aliases";

function loadDotEnv(): Record<string, string> {
  try {
    const content = readFileSync(resolve(__dirname, "../../.env"), "utf8");
    const env: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex < 0) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      if (key && !process.env[key]) env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
}

const dotEnv = loadDotEnv();

export default defineConfig({
  resolve: {
    conditions: ["source"],
    alias: workspaceTestAliases,
  },
  test: {
    silent: "passed-only",
    name: "@bb/agent-runtime:integration",
    include: ["src/integration*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    testTimeout: 45_000,
    hookTimeout: 10_000,
    // Real-provider tests share local provider credentials and external API
    // limits. Keep files serial so one Pi scenario runs at a time; individual
    // files still use provider-level concurrent tests where that is intentional.
    fileParallelism: false,
    maxConcurrency: 16,
    env: dotEnv,
  },
});
