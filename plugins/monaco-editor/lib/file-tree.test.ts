import { describe, expect, it } from "vitest";
import { ancestorsOf, buildTree, filterTree } from "./file-tree.js";

describe("buildTree", () => {
  it("nests flat paths and sorts directories before files", () => {
    const tree = buildTree([
      { path: "readme.md", kind: "file" },
      { path: "src", kind: "directory" },
      { path: "src/index.ts", kind: "file" },
      { path: "src/lib", kind: "directory" },
      { path: "src/lib/util.ts", kind: "file" },
    ]);

    expect(tree.map((node) => node.name)).toEqual(["src", "readme.md"]);
    const src = tree[0]!;
    expect(src.children.map((node) => node.name)).toEqual(["lib", "index.ts"]);
    expect(src.children[0]!.children[0]!.path).toBe("src/lib/util.ts");
  });

  it("synthesises directories that the listing omitted", () => {
    const tree = buildTree([{ path: "a/b/c.ts", kind: "file" }]);

    expect(tree).toHaveLength(1);
    expect(tree[0]!.kind).toBe("directory");
    expect(tree[0]!.children[0]!.path).toBe("a/b");
    expect(tree[0]!.children[0]!.children[0]!.path).toBe("a/b/c.ts");
  });

  it("sorts case-insensitively", () => {
    const tree = buildTree([
      { path: "beta.ts", kind: "file" },
      { path: "Alpha.ts", kind: "file" },
    ]);

    expect(tree.map((node) => node.name)).toEqual(["Alpha.ts", "beta.ts"]);
  });
});

describe("ancestorsOf", () => {
  it("lists each containing directory, nearest last", () => {
    expect(ancestorsOf("a/b/c.ts")).toEqual(["a", "a/b"]);
  });

  it("has none for a root-level file", () => {
    expect(ancestorsOf("readme.md")).toEqual([]);
  });
});

describe("filterTree", () => {
  const tree = buildTree([
    { path: "src/index.ts", kind: "file" },
    { path: "src/ui/button.tsx", kind: "file" },
    { path: "docs/guide.md", kind: "file" },
  ]);

  it("keeps matches with the directories leading to them, and says which to open", () => {
    const filtered = filterTree(tree, "button");

    expect(filtered.matchCount).toBe(1);
    expect(filtered.nodes.map((node) => node.name)).toEqual(["src"]);
    expect([...filtered.expand].sort()).toEqual(["src", "src/ui"]);
  });

  it("matches on the whole relative path, not just the file name", () => {
    expect(filterTree(tree, "src/ui").matchCount).toBe(1);
  });

  it("is case-insensitive and returns nothing when nothing matches", () => {
    expect(filterTree(tree, "BUTTON").matchCount).toBe(1);
    expect(filterTree(tree, "nothing-here").nodes).toEqual([]);
  });

  it("passes the tree through untouched when the query is blank", () => {
    const filtered = filterTree(tree, "   ");

    expect(filtered.nodes).toHaveLength(2);
    expect(filtered.expand.size).toBe(0);
  });
});
