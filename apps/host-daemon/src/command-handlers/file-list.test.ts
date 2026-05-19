import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  finalizeListedFiles,
  finalizeListedPaths,
  listPathsRecursively,
  normalizeListedPath,
} from "./file-list.js";

describe("finalizeListedFiles", () => {
  it("preserves walk order for an empty query", () => {
    const result = finalizeListedFiles({
      filePaths: ["src/z.ts", "src/a.ts", "src/m.ts"],
      limit: 2,
    });

    expect(result.files.map((file) => file.path)).toEqual([
      "src/z.ts",
      "src/a.ts",
    ]);
    expect(result.truncated).toBe(true);
  });

  it("sets the display name from the path basename", () => {
    const result = finalizeListedFiles({
      filePaths: ["src/components/PromptBox.tsx"],
      limit: 5,
    });

    expect(result.files).toEqual([
      {
        path: "src/components/PromptBox.tsx",
        name: "PromptBox.tsx",
      },
    ]);
    expect(result.truncated).toBe(false);
  });

  it("does not report truncation below the limit", () => {
    const result = finalizeListedFiles({
      filePaths: ["a.ts", "b.ts"],
      limit: 3,
    });

    expect(result.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
    expect(result.truncated).toBe(false);
  });

  it("does not report truncation exactly at the limit", () => {
    const result = finalizeListedFiles({
      filePaths: ["a.ts", "b.ts", "c.ts"],
      limit: 3,
    });

    expect(result.files.map((file) => file.path)).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
    ]);
    expect(result.truncated).toBe(false);
  });

  it("reports truncation above the limit", () => {
    const result = finalizeListedFiles({
      filePaths: ["a.ts", "b.ts", "c.ts", "d.ts"],
      limit: 3,
    });

    expect(result.files.map((file) => file.path)).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
    ]);
    expect(result.truncated).toBe(true);
  });

  it("applies query matching before truncating", () => {
    const result = finalizeListedFiles({
      filePaths: [
        "src/a.ts",
        "src/b.ts",
        "apps/app/src/components/promptbox/PromptBox.tsx",
      ],
      query: "PromptBox",
      limit: 1,
    });

    expect(result.files.map((file) => file.path)).toEqual([
      "apps/app/src/components/promptbox/PromptBox.tsx",
    ]);
    expect(result.truncated).toBe(false);
  });

  it("reports truncation after query matching when more matches remain", () => {
    const result = finalizeListedFiles({
      filePaths: ["src/prompt-a.ts", "src/prompt-b.ts", "src/prompt-c.ts"],
      query: "prompt",
      limit: 2,
    });

    expect(result.files).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("returns an empty untruncated list when a query has no matches", () => {
    const result = finalizeListedFiles({
      filePaths: ["src/a.ts", "src/b.ts"],
      query: "prompt",
      limit: 2,
    });

    expect(result.files).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});

describe("finalizeListedPaths", () => {
  it("excludes directories when directory results are disabled", () => {
    const result = finalizeListedPaths({
      paths: [
        { kind: "directory", path: "src", name: "src" },
        { kind: "file", path: "src/index.ts", name: "index.ts" },
      ],
      includeFiles: true,
      includeDirectories: false,
      limit: 10,
    });

    expect(result.paths).toEqual([
      {
        kind: "file",
        path: "src/index.ts",
        name: "index.ts",
        score: 0,
        positions: [],
      },
    ]);
    expect(result.truncated).toBe(false);
  });

  it("includes directories with typed path metadata when requested", () => {
    const result = finalizeListedPaths({
      paths: [
        { kind: "directory", path: "src", name: "src" },
        { kind: "file", path: "src/index.ts", name: "index.ts" },
      ],
      includeFiles: true,
      includeDirectories: true,
      limit: 10,
    });

    expect(result.paths.map((pathEntry) => pathEntry.kind)).toEqual([
      "directory",
      "file",
    ]);
    expect(result.paths[0]).toEqual({
      kind: "directory",
      path: "src",
      name: "src",
      score: 0,
      positions: [],
    });
  });

  it("applies fuzzy ranking before truncating mixed path results", () => {
    const result = finalizeListedPaths({
      paths: [
        {
          kind: "file",
          path: "src/components/Button.tsx",
          name: "Button.tsx",
        },
        {
          kind: "directory",
          path: "apps/app/src/components/promptbox",
          name: "promptbox",
        },
        {
          kind: "file",
          path: "apps/app/src/components/promptbox/PromptBox.tsx",
          name: "PromptBox.tsx",
        },
      ],
      query: "prompt",
      includeFiles: true,
      includeDirectories: true,
      limit: 1,
    });

    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]?.path).toBe(
      "apps/app/src/components/promptbox/PromptBox.tsx",
    );
    expect(result.paths[0]?.score).toBeGreaterThan(0);
    expect(result.paths[0]?.positions.length).toBeGreaterThan(0);
    expect(result.truncated).toBe(true);
  });
});

describe("listPathsRecursively", () => {
  it("returns slash-separated relative paths for nested entries", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bb-file-list-"));
    try {
      await fs.mkdir(path.join(root, "src", "components"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(root, "src", "components", "Button.tsx"),
        "",
      );

      const result = await listPathsRecursively({
        dir: root,
        root,
        includeFiles: true,
        includeDirectories: true,
      });

      expect(result).toEqual([
        { kind: "directory", path: "src", name: "src" },
        {
          kind: "directory",
          path: "src/components",
          name: "components",
        },
        {
          kind: "file",
          path: "src/components/Button.tsx",
          name: "Button.tsx",
        },
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes Windows separators before returning paths", () => {
    expect(normalizeListedPath("src\\components\\Button.tsx")).toBe(
      "src/components/Button.tsx",
    );
  });
});
