import { describe, expect, it } from "vitest";
import { threadTabsSchema } from "@bb/server-contract";
import type { PluginFileOpenerSlot } from "@/lib/plugin-slots";
import type { OpenSecondaryPanelTabRequest } from "@/components/secondary-panel/useThreadFileTabs";
import {
  buildFileOpenerPanelTab,
  createFileOpenerOriginalTab,
  createFileOpenerTabForRequest,
  parseFileOpenerParams,
} from "./file-opener-tabs";

const MARKDOWN_OPENER = {
  component: () => null,
  extensions: ["md"],
  generation: 1,
  id: "markdown",
  pluginId: "docs",
  title: "Docs editor",
} satisfies PluginFileOpenerSlot;

const REQUESTS: readonly {
  label: string;
  request: OpenSecondaryPanelTabRequest;
}[] = [
  {
    label: "workspace file",
    request: {
      kind: "workspace-file-preview",
      tab: {
        lineRange: { endLineNumber: 12, startLineNumber: 8 },
        path: "docs/readme.md",
        source: { kind: "working-tree" },
        statusLabel: null,
      },
    },
  },
  {
    label: "host file",
    request: {
      kind: "host-file-preview",
      tab: { lineRange: null, path: "/Users/dev/notes.md" },
    },
  },
  {
    label: "thread-storage file",
    request: {
      kind: "thread-storage-file-preview",
      tab: { lineRange: null, path: "plan.md" },
    },
  },
];

describe("createFileOpenerTabForRequest thread-tabs contract", () => {
  it.each(REQUESTS.map(({ label, request }) => [label, request] as const))(
    "produces a %s tab the thread-tabs contract accepts",
    (_label, request) => {
      const tab = createFileOpenerTabForRequest({
        fileOpeners: [MARKDOWN_OPENER],
        preference: {},
        projectId: null,
        request,
        resolvedEnvironmentId: "env_docs",
        threadId: "thr_docs",
      });

      expect(tab?.fileOpenerOwner).toBeDefined();
      expect(() => threadTabsSchema.parse([tab])).not.toThrow();
    },
  );

  it("keeps a projectless workspace opener tab contract-valid", () => {
    const tab = createFileOpenerTabForRequest({
      fileOpeners: [MARKDOWN_OPENER],
      preference: {},
      projectId: null,
      request: {
        kind: "workspace-file-preview",
        tab: {
          lineRange: null,
          path: "docs/readme.md",
          source: { kind: "working-tree" },
          statusLabel: null,
        },
      },
      resolvedEnvironmentId: null,
      threadId: null,
    });

    expect(tab?.fileOpenerOwner).toMatchObject({
      environmentId: null,
      kind: "workspace-file-preview",
      projectId: null,
      threadId: null,
    });
    expect(() => threadTabsSchema.parse([tab])).not.toThrow();
  });

  it("preserves the selected host for a project-backed opener", () => {
    const tab = createFileOpenerTabForRequest({
      fileOpeners: [MARKDOWN_OPENER],
      preference: {},
      projectHostId: "host_remote",
      projectId: "proj_1",
      request: {
        kind: "workspace-file-preview",
        tab: {
          lineRange: null,
          path: "docs/readme.md",
          source: { kind: "working-tree" },
          statusLabel: null,
        },
      },
      resolvedEnvironmentId: null,
      threadId: null,
    });

    const params = parseFileOpenerParams(tab?.paramsJson ?? null);
    expect(params?.source).toMatchObject({
      kind: "workspace",
      projectId: "proj_1",
      experimental_hostId: "host_remote",
    });
    expect(() => threadTabsSchema.parse([tab])).not.toThrow();
  });
});

describe("createFileOpenerOriginalTab", () => {
  it("uses persisted workspace routing while retaining owner presentation", () => {
    const openerTab = buildFileOpenerPanelTab(
      MARKDOWN_OPENER,
      {
        path: "persisted/readme.md",
        source: {
          kind: "workspace",
          environmentId: null,
          experimental_hostId: "host_opened",
          projectId: "proj_opened",
          threadId: null,
        },
      },
      {
        environmentId: "env_stale",
        kind: "workspace-file-preview",
        projectId: "proj_stale",
        tab: {
          lineRange: { endLineNumber: 12, startLineNumber: 8 },
          path: "stale/readme.md",
          source: { kind: "working-tree" },
          statusLabel: null,
        },
        threadId: "thr_stale",
      },
    );

    expect(createFileOpenerOriginalTab(openerTab)).toMatchObject({
      environmentId: null,
      kind: "workspace-file-preview",
      lineRange: { endLineNumber: 12, startLineNumber: 8 },
      path: "persisted/readme.md",
      projectId: "proj_opened",
      source: { kind: "working-tree" },
    });
  });

  it("uses persisted host routing instead of stale owner identity", () => {
    const openerTab = buildFileOpenerPanelTab(
      MARKDOWN_OPENER,
      {
        path: "/persisted/notes.md",
        source: {
          kind: "host",
          environmentId: null,
          experimental_hostId: "host_opened",
          projectId: null,
          threadId: null,
        },
      },
      {
        environmentId: null,
        hostId: "host_stale",
        kind: "host-file-preview",
        tab: {
          lineRange: { endLineNumber: 4, startLineNumber: 4 },
          path: "/stale/notes.md",
        },
        threadId: null,
      },
    );

    expect(createFileOpenerOriginalTab(openerTab)).toMatchObject({
      environmentId: null,
      hostId: "host_opened",
      kind: "host-file-preview",
      lineRange: { endLineNumber: 4, startLineNumber: 4 },
      path: "/persisted/notes.md",
      threadId: null,
    });
  });

  it("uses persisted thread-storage routing instead of stale owner identity", () => {
    const openerTab = buildFileOpenerPanelTab(
      MARKDOWN_OPENER,
      {
        path: "persisted/plan.md",
        source: {
          kind: "thread-storage",
          environmentId: "env_opened",
          projectId: null,
          threadId: "thr_opened",
        },
      },
      {
        environmentId: "env_stale",
        kind: "thread-storage-file-preview",
        tab: { lineRange: null, path: "stale/plan.md" },
        threadId: "thr_stale",
      },
    );

    expect(createFileOpenerOriginalTab(openerTab)).toMatchObject({
      environmentId: "env_opened",
      isPinned: false,
      kind: "thread-storage-file-preview",
      path: "persisted/plan.md",
      threadId: "thr_opened",
    });
  });
});
