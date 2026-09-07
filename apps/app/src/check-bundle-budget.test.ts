import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { BundleChunk, BundleStats } from "../vite-bundle-stats.js";

const execFileAsync = promisify(execFile);
const scriptPath = resolve(
  import.meta.dirname,
  "../scripts/check-bundle-budget.mjs",
);
const KATEX_GATE = "src/components/ui/markdown-katex.ts";

interface ChunkSpec {
  packages?: string[];
  imports?: string[];
  facade?: string | null;
}

function chunk(fileName: string, spec: ChunkSpec = {}): BundleChunk {
  return {
    fileName,
    bytes: 512,
    packages: spec.packages ?? [],
    imports: spec.imports ?? [],
    facade: spec.facade ?? null,
  };
}

function buildStats({
  markdownPreviewImports,
  katexGate = KATEX_GATE,
}: {
  markdownPreviewImports: string[];
  katexGate?: string | null;
}): BundleStats {
  const index = chunk("index.js", { facade: "src/main.tsx" });
  return {
    entry: index.fileName,
    bootChunks: [index],
    chunks: [
      index,
      chunk("route.js", {
        facade: "src/views/Route.tsx",
        imports: ["markdown-preview.js"],
      }),
      chunk("markdown-preview.js", {
        packages: ["react-markdown", "remark-math"],
        imports: markdownPreviewImports,
      }),
      chunk("markdown-katex.js", {
        facade: katexGate,
        packages: ["rehype-katex"],
        imports: ["katex.js"],
      }),
      chunk("katex.js", { packages: ["katex"] }),
    ],
    routeClosures: {},
  };
}

async function runCheck(stats: BundleStats): Promise<{
  code: number;
  output: string;
}> {
  const dir = await mkdtemp(resolve(tmpdir(), "bb-bundle-budget-test-"));
  const distDir = resolve(dir, "dist");
  await mkdir(distDir);
  await writeFile(resolve(dir, "bundle-stats.json"), JSON.stringify(stats));
  await writeFile(
    resolve(dir, "bundle-budget.json"),
    JSON.stringify({
      maxBootBytes: 10_000,
      maxBootBrotliBytes: 10_000,
      forbiddenBootPackages: ["katex", "rehype-katex"],
      onDemandPackages: { katex: KATEX_GATE, "rehype-katex": KATEX_GATE },
    }),
  );
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      scriptPath,
      distDir,
      dir,
    ]);
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "number" &&
      "stdout" in error &&
      "stderr" in error
    ) {
      return { code: error.code, output: `${error.stdout}${error.stderr}` };
    }
    throw error;
  }
}

describe("check-bundle-budget on-demand packages", () => {
  it("passes when KaTeX is reachable only through the markdown-katex gate", async () => {
    const result = await runCheck(buildStats({ markdownPreviewImports: [] }));

    expect(result.output).toContain("Bundle budget OK");
    expect(result.code).toBe(0);
  });

  it("fails when markdown-preview statically imports the katex chunk", async () => {
    const result = await runCheck(
      buildStats({ markdownPreviewImports: ["katex.js"] }),
    );

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "katex is in the static import closure of route.js, markdown-preview.js",
    );
    expect(result.output).not.toContain("rehype-katex is in the static");
  });

  it("fails when the gate module disappears from the build", async () => {
    const result = await runCheck(
      buildStats({ markdownPreviewImports: [], katexGate: null }),
    );

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      `katex has no gate chunk for ${KATEX_GATE}`,
    );
  });
});
