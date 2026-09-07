import { describe, expect, it } from "vitest";
import { threadTabsSchema, type ThreadTab } from "../src/api/thread-tabs.js";
import type { TerminalCreateTarget } from "../src/api/terminals.js";

const OPENER_TAB_BASE = {
  actionId: "file-opener:markdown",
  id: "plugin-panel:docs%3Afile-opener%3Amarkdown%3A%7B%7D:none",
  kind: "plugin-panel",
  paramsJson: JSON.stringify({
    path: "docs/readme.md",
    source: {
      kind: "workspace",
      threadId: "thr_docs",
      environmentId: "env_docs",
      projectId: null,
    },
  }),
  pluginId: "docs",
  title: "readme.md",
} as const;

const OWNERS = [
  {
    environmentId: "env_docs",
    kind: "workspace-file-preview",
    projectId: null,
    tab: {
      lineRange: { endLineNumber: 12, startLineNumber: 8 },
      path: "docs/readme.md",
      source: { kind: "working-tree" },
      statusLabel: null,
    },
    threadId: "thr_docs",
  },
  {
    environmentId: "env_docs",
    hostId: null,
    kind: "host-file-preview",
    tab: { lineRange: null, path: "/Users/dev/notes.md" },
    threadId: "thr_docs",
  },
  {
    environmentId: null,
    kind: "thread-storage-file-preview",
    tab: { lineRange: null, path: "plan.md" },
    threadId: "thr_docs",
  },
] as const;

describe("thread tab file-opener owner", () => {
  it.each(OWNERS.map((owner) => [owner.kind, owner] as const))(
    "accepts a plugin-panel tab that diverted a %s",
    (_kind, fileOpenerOwner) => {
      const parsed = threadTabsSchema.parse([
        { ...OPENER_TAB_BASE, fileOpenerOwner },
      ]);

      expect(parsed[0]).toEqual({ ...OPENER_TAB_BASE, fileOpenerOwner });
    },
  );

  it("round-trips through the server's JSON storage of the tab list", () => {
    const tabs: ThreadTab[] = [
      { ...OPENER_TAB_BASE, fileOpenerOwner: OWNERS[0] },
    ];

    const restored = threadTabsSchema.parse(JSON.parse(JSON.stringify(tabs)));

    expect(restored).toEqual(tabs);
  });

  it("still rejects unknown fields on the plugin-panel branch", () => {
    const result = threadTabsSchema.safeParse([
      { ...OPENER_TAB_BASE, fileOpenerBogus: {} },
    ]);

    expect(result.success).toBe(false);
  });

  it("rejects an owner whose payload does not match its kind", () => {
    const result = threadTabsSchema.safeParse([
      {
        ...OPENER_TAB_BASE,
        fileOpenerOwner: { ...OWNERS[1], environmentId: null },
      },
    ]);

    expect(result.success).toBe(false);
  });

  it("accepts an explicit host owner without ambient thread context", () => {
    const fileOpenerOwner = {
      ...OWNERS[1],
      environmentId: null,
      hostId: "host_docs",
      threadId: null,
    };
    const parsed = threadTabsSchema.parse([
      { ...OPENER_TAB_BASE, fileOpenerOwner },
    ]);

    expect(parsed[0]).toEqual({ ...OPENER_TAB_BASE, fileOpenerOwner });
  });
});

const TERMINAL_TAB_BASE = {
  id: "terminal:term_abc:none",
  kind: "terminal",
  terminalId: "term_abc",
} as const;

const TERMINAL_TARGETS: readonly TerminalCreateTarget[] = [
  { kind: "thread", threadId: "thr_docs" },
  { kind: "environment", environmentId: "env_docs" },
  { kind: "host_path", hostId: "host_1", cwd: "/Users/dev" },
  { kind: "host_path", hostId: "host_1", cwd: null },
];

describe("thread tab terminal target", () => {
  it.each(TERMINAL_TARGETS.map((target) => [target.kind, target] as const))(
    "accepts a terminal tab opened against a %s target",
    (_kind, target) => {
      const parsed = threadTabsSchema.parse([{ ...TERMINAL_TAB_BASE, target }]);

      expect(parsed[0]).toEqual({ ...TERMINAL_TAB_BASE, target });
    },
  );

  it("accepts a terminal tab with no target", () => {
    const parsed = threadTabsSchema.parse([TERMINAL_TAB_BASE]);

    expect(parsed[0]).toEqual(TERMINAL_TAB_BASE);
  });

  it("rejects a target whose payload does not match its kind", () => {
    const result = threadTabsSchema.safeParse([
      {
        ...TERMINAL_TAB_BASE,
        target: { kind: "thread", environmentId: "env" },
      },
    ]);

    expect(result.success).toBe(false);
  });
});
