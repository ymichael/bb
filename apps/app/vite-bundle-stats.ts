import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const appDir = dirname(fileURLToPath(import.meta.url));

interface BundleBootChunk {
  fileName: string;
  bytes: number;
  packages: string[];
}

export interface BundleChunk extends BundleBootChunk {
  imports: string[];
  facade: string | null;
}

interface BundleRouteClosure {
  entry: string;
  chunks: BundleBootChunk[];
}

export interface BundleStats {
  entry: string;
  bootChunks: BundleBootChunk[];
  chunks: BundleChunk[];
  routeClosures: Record<string, BundleRouteClosure>;
}

const MEASURED_ROUTE_CLOSURES: Record<string, string> = {
  SplitWorkspaceRoute: "/src/views/SplitWorkspaceRoute.tsx",
};

export interface BundleStatsChunkInput {
  fileName: string;
  isEntry: boolean;
  facadeModuleId: string | null;
  imports: readonly string[];
  moduleIds: readonly string[];
  code: string;
}

export function computeBundleStats(
  chunks: readonly BundleStatsChunkInput[],
  measuredRouteClosures: Record<string, string>,
  warn: (message: string) => void,
): BundleStats | null {
  const byFileName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const entry = chunks.find((chunk) => chunk.isEntry);
  if (entry === undefined) return null;

  const staticClosure = (
    startFileName: string,
    skip: ReadonlySet<string>,
  ): Set<string> => {
    const closure = new Set<string>();
    const walk = (fileName: string): void => {
      if (closure.has(fileName) || skip.has(fileName)) return;
      closure.add(fileName);
      const chunk = byFileName.get(fileName);
      if (chunk === undefined) return;
      for (const imported of chunk.imports) walk(imported);
    };
    walk(startFileName);
    return closure;
  };

  const describeChunk = (chunk: BundleStatsChunkInput): BundleBootChunk => {
    const packages = new Set<string>();
    for (const moduleId of chunk.moduleIds) {
      const name = packageNameOf(moduleId);
      if (name !== null) packages.add(name);
    }
    return {
      fileName: chunk.fileName,
      bytes: Buffer.byteLength(chunk.code),
      packages: [...packages].sort(),
    };
  };

  const describeChunks = (
    fileNames: ReadonlySet<string>,
  ): BundleBootChunk[] => {
    const described: BundleBootChunk[] = [];
    for (const fileName of [...fileNames].sort()) {
      const chunk = byFileName.get(fileName);
      if (chunk === undefined) continue;
      described.push(describeChunk(chunk));
    }
    return described;
  };

  const bootFileNames = staticClosure(entry.fileName, new Set());
  const bootChunks = describeChunks(bootFileNames);

  const allChunks: BundleChunk[] = [];
  for (const chunk of [...chunks].sort((a, b) =>
    a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0,
  )) {
    allChunks.push({
      ...describeChunk(chunk),
      imports: [...chunk.imports].sort(),
      facade:
        chunk.facadeModuleId === null
          ? null
          : relative(appDir, chunk.facadeModuleId).split(sep).join("/"),
    });
  }

  const routeClosures: Record<string, BundleRouteClosure> = {};
  for (const [name, sourceSuffix] of Object.entries(measuredRouteClosures)) {
    const routeChunk = chunks.find(
      (chunk) =>
        chunk.facadeModuleId !== null &&
        chunk.facadeModuleId.endsWith(sourceSuffix),
    );
    if (routeChunk === undefined) {
      warn(
        `no chunk has facadeModuleId ending in ${sourceSuffix}; the ${name} route closure is not recorded`,
      );
      continue;
    }
    routeClosures[name] = {
      entry: routeChunk.fileName,
      chunks: describeChunks(staticClosure(routeChunk.fileName, bootFileNames)),
    };
  }

  return {
    entry: entry.fileName,
    bootChunks,
    chunks: allChunks,
    routeClosures,
  };
}

export function bundleStats(): Plugin {
  return {
    name: "bb:bundle-stats",
    apply: "build",
    async writeBundle(_options, bundle) {
      const chunks: BundleStatsChunkInput[] = [];
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        chunks.push({
          fileName: output.fileName,
          isEntry: output.isEntry,
          facadeModuleId: output.facadeModuleId,
          imports: output.imports,
          moduleIds: output.moduleIds ?? [],
          code: output.code,
        });
      }
      const stats = computeBundleStats(
        chunks,
        MEASURED_ROUTE_CLOSURES,
        (message) => this.warn(message),
      );
      if (stats === null) return;
      const target = resolve(appDir, "bundle-stats.json");
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify(stats, null, 2)}\n`);
    },
  };
}

function packageNameOf(moduleId: string): string | null {
  const marker = moduleId.lastIndexOf("node_modules/");
  if (marker < 0) return null;
  const segments = moduleId.slice(marker + "node_modules/".length).split("/");
  const [first, second] = segments;
  if (first === undefined) return null;
  if (first.startsWith("@"))
    return second === undefined ? null : `${first}/${second}`;
  return first;
}
