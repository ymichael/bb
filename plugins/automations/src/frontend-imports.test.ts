import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PLUGIN_ROOT = realpathSync(resolve(import.meta.dirname, ".."));
const FRONTEND_ENTRY = join(PLUGIN_ROOT, "app.tsx");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);

const BUNDLED_WORKSPACE_SPECIFIER =
  /^(@bb\/(?!plugin-sdk(?:\/|$))[^/]+)((?:\/.*)?)$/;

const HOST_PROVIDED_ICON_MODULE =
  /\/shared-ui\/src\/components\/ui\/icon\.tsx$/;

const IMPORT_STATEMENT =
  /^[ \t]*(import|export)\s+([^;'"]*?)\s*from\s*["']([^"']+)["']|^[ \t]*import\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/gm;

interface ImportEdge {
  specifier: string;
  typeOnly: boolean;
}

function isTypeOnlyClause(clause: string): boolean {
  const trimmed = clause.trim();
  if (/^type\s/.test(trimmed)) return true;
  const named = /^\{([^}]*)\}$/.exec(trimmed);
  if (named === null) return false;
  const specifiers = named[1]
    .split(",")
    .map((specifier) => specifier.trim())
    .filter((specifier) => specifier.length > 0);
  return (
    specifiers.length > 0 &&
    specifiers.every((specifier) => /^type\s/.test(specifier))
  );
}

function importEdges(source: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  for (const match of source.matchAll(IMPORT_STATEMENT)) {
    const [, , clause, fromSpecifier, sideEffectSpecifier, dynamicSpecifier] =
      match;
    if (fromSpecifier !== undefined) {
      edges.push({
        specifier: fromSpecifier,
        typeOnly: isTypeOnlyClause(clause ?? ""),
      });
    } else {
      const specifier = sideEffectSpecifier ?? dynamicSpecifier;
      if (specifier !== undefined) edges.push({ specifier, typeOnly: false });
    }
  }
  return edges;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function workspaceSourceFile(packageName: string, subpath: string): string {
  const link = join(PLUGIN_ROOT, "node_modules", packageName);
  if (!existsSync(link)) {
    throw new Error(
      `${packageName} is not a dependency of this plugin (no node_modules link)`,
    );
  }
  const packageDir = realpathSync(link);
  const manifest: unknown = JSON.parse(
    readFileSync(join(packageDir, "package.json"), "utf8"),
  );
  const entry =
    isRecord(manifest) && isRecord(manifest.exports)
      ? manifest.exports[`.${subpath}`]
      : undefined;
  const source = isRecord(entry) ? entry.source : undefined;
  if (typeof source !== "string") {
    throw new Error(
      `${packageName}${subpath} has no "source" export in its package.json`,
    );
  }
  return resolve(packageDir, source);
}

function resolveLocalModule(
  fromFile: string,
  specifier: string,
): string | null {
  const workspace = BUNDLED_WORKSPACE_SPECIFIER.exec(specifier);
  const base = specifier.startsWith("@/")
    ? join(PLUGIN_ROOT, specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(fromFile), specifier)
      : workspace !== null
        ? workspaceSourceFile(workspace[1], workspace[2])
        : null;
  if (base === null) return null;
  const stem = base.replace(/\.js$/, "");
  const candidates = [
    `${stem}.ts`,
    `${stem}.tsx`,
    base,
    join(stem, "index.ts"),
    join(stem, "index.tsx"),
  ];
  const resolved = candidates.find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
  if (resolved === undefined) {
    throw new Error(
      `cannot resolve ${specifier} from ${relative(PLUGIN_ROOT, fromFile)}`,
    );
  }
  if (HOST_PROVIDED_ICON_MODULE.test(resolved)) return null;
  return SOURCE_EXTENSIONS.has(extname(resolved)) ? resolved : null;
}

function collectFrontendModules(entry: string): Map<string, string[]> {
  const reached = new Map<string, string[]>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || reached.has(file)) continue;
    const bareSpecifiers: string[] = [];
    reached.set(file, bareSpecifiers);
    for (const edge of importEdges(readFileSync(file, "utf8"))) {
      if (edge.typeOnly) continue;
      const local = resolveLocalModule(file, edge.specifier);
      if (local === null) bareSpecifiers.push(edge.specifier);
      else pending.push(local);
    }
  }
  return reached;
}

describe("automations frontend bundle", () => {
  const reached = collectFrontendModules(FRONTEND_ENTRY);
  const reachedPaths = [...reached.keys()].map((file) =>
    relative(PLUGIN_ROOT, file),
  );

  it("walks the real frontend graph", () => {
    expect(reachedPaths).toEqual(
      expect.arrayContaining([
        "detail-view.tsx",
        "overview-view.tsx",
        "lib/format-schedule.ts",
        "../../packages/domain/src/update-state.ts",
        "../../packages/shared-ui/src/components/ui/button.tsx",
      ]),
    );
  });

  it("never treats an unfollowed @bb package as a third-party specifier", () => {
    expect(() =>
      resolveLocalModule(FRONTEND_ENTRY, "@bb/plugin-interaction-contracts"),
    ).toThrow(/plugin-interaction-contracts/);
  });

  it("never reaches the zod schema module through a value import", () => {
    expect(reachedPaths).not.toContain("src/rpc-types.ts");
  });

  it("imports nothing from zod", () => {
    const offenders = [...reached]
      .filter(([, specifiers]) =>
        specifiers.some(
          (specifier) => specifier === "zod" || specifier.startsWith("zod/"),
        ),
      )
      .map(([file]) => relative(PLUGIN_ROOT, file));
    expect(offenders).toEqual([]);
  });
});
