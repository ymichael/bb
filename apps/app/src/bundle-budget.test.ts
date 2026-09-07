import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  computeBundleStats,
  type BundleStatsChunkInput,
} from "../vite-bundle-stats";

const execFileAsync = promisify(execFile);
const checkScriptPath = resolve(
  import.meta.dirname,
  "../scripts/check-bundle-budget.mjs",
);

function chunk(
  fileName: string,
  overrides: Partial<BundleStatsChunkInput> = {},
): BundleStatsChunkInput {
  return {
    fileName,
    isEntry: false,
    facadeModuleId: null,
    imports: [],
    moduleIds: [],
    code: "x".repeat(2048),
    ...overrides,
  };
}

const chunks: BundleStatsChunkInput[] = [
  chunk("assets/index.js", {
    isEntry: true,
    imports: ["assets/boot-shared.js"],
  }),
  chunk("assets/boot-shared.js", {
    moduleIds: ["/repo/node_modules/react/index.js"],
  }),
  chunk("assets/SplitWorkspaceRoute.js", {
    facadeModuleId: "/repo/apps/app/src/views/SplitWorkspaceRoute.tsx",
    imports: ["assets/boot-shared.js", "assets/route-only.js"],
  }),
  chunk("assets/route-only.js", {
    moduleIds: [
      "/repo/node_modules/.pnpm/@pierre+diffs@1/node_modules/@pierre/diffs/dist/index.js",
      "/repo/apps/app/src/lib/x.ts",
    ],
  }),
  chunk("assets/only-behind-dynamic-import.js", {
    moduleIds: ["/repo/node_modules/katex/dist/katex.js"],
  }),
];

describe("computeBundleStats", () => {
  it("records a route closure without the boot chunks or lazy-only chunks", () => {
    const warn = vi.fn();
    const stats = computeBundleStats(
      chunks,
      { SplitWorkspaceRoute: "/src/views/SplitWorkspaceRoute.tsx" },
      warn,
    );
    if (stats === null) throw new Error("expected stats");

    expect(stats.bootChunks.map((c) => c.fileName)).toEqual([
      "assets/boot-shared.js",
      "assets/index.js",
    ]);
    const route = stats.routeClosures.SplitWorkspaceRoute;
    if (route === undefined) throw new Error("expected the route closure");
    expect(route.entry).toBe("assets/SplitWorkspaceRoute.js");
    expect(route.chunks.map((c) => c.fileName)).toEqual([
      "assets/SplitWorkspaceRoute.js",
      "assets/route-only.js",
    ]);
    expect(route.chunks[1]?.packages).toEqual(["@pierre/diffs"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns instead of throwing when a measured route has no chunk", () => {
    const warn = vi.fn();
    const stats = computeBundleStats(chunks, { Missing: "/nope.tsx" }, warn);
    expect(stats?.routeClosures).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

interface Fixture {
  distDir: string;
  budgetDir: string;
}

async function writeFixture(budget: unknown): Promise<Fixture> {
  const root = await mkdtemp(resolve(tmpdir(), "bb-bundle-budget-test-"));
  const distDir = resolve(root, "dist");
  await mkdir(resolve(distDir, "assets"), { recursive: true });
  const stats = computeBundleStats(
    chunks,
    { SplitWorkspaceRoute: "/src/views/SplitWorkspaceRoute.tsx" },
    () => undefined,
  );
  for (const c of chunks) {
    await writeFile(resolve(distDir, `${c.fileName}.br`), "b".repeat(100));
  }
  await writeFile(resolve(root, "bundle-stats.json"), JSON.stringify(stats));
  await writeFile(resolve(root, "bundle-budget.json"), JSON.stringify(budget));
  return { distDir, budgetDir: root };
}

async function runCheck(fixture: Fixture) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      checkScriptPath,
      fixture.distDir,
      fixture.budgetDir,
    ]);
    return { code: 0, output: stdout };
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: failure.code ?? 1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  }
}

const passingBudget = {
  maxBootBytes: 10_000,
  maxBootBrotliBytes: 1_000,
  forbiddenBootPackages: ["@pierre/diffs", "katex"],
  routeClosures: {
    SplitWorkspaceRoute: {
      maxBytes: 10_000,
      maxBrotliBytes: 1_000,
      forbiddenPackages: ["katex"],
    },
  },
};

describe("check-bundle-budget", () => {
  it("passes when the boot payload and the route closure are within budget", async () => {
    const result = await runCheck(await writeFixture(passingBudget));
    expect(result.output).toContain("Bundle budget OK");
    expect(result.code).toBe(0);
  });

  it("fails when a forbidden package reaches the route closure", async () => {
    const result = await runCheck(
      await writeFixture({
        ...passingBudget,
        routeClosures: {
          SplitWorkspaceRoute: {
            ...passingBudget.routeClosures.SplitWorkspaceRoute,
            forbiddenPackages: ["@pierre/diffs"],
          },
        },
      }),
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "@pierre/diffs is in the SplitWorkspaceRoute closure (assets/route-only.js)",
    );
  });

  it("fails when the route closure grows past its ratchet", async () => {
    const result = await runCheck(
      await writeFixture({
        ...passingBudget,
        routeClosures: {
          SplitWorkspaceRoute: {
            ...passingBudget.routeClosures.SplitWorkspaceRoute,
            maxBytes: 3_000,
          },
        },
      }),
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain("SplitWorkspaceRoute closure is 4.0 KB");
    expect(result.output).toContain("over the 2.9 KB raw budget");
  });
});
