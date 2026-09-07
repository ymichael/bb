import { describe, expect, it } from "vitest";
import { PERSONAL_PROJECT_ID, type ThreadListEntry } from "@bb/domain";
import {
  getSelectedThreadSidebarExpansion,
  getSidebarThreadComparator,
} from "./ProjectList";
import {
  CHRONOLOGICAL_CONTAINER_ID,
  type ProjectThreadNode,
  type ProjectThreadItem,
  type ThreadComparator,
} from "@bb/client-core";
import { NO_COLLAPSED_CHILD_ACTIVITY } from "@bb/client-core";
import type { ThreadTitleMentionResources } from "@/components/thread/ThreadTitleMentions";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";

function thread(overrides: Partial<ThreadListEntry>): ThreadListEntry {
  return makeThreadListEntry({
    id: "thr_1",
    projectId: "proj_1",
    title: "Thread",
    titleFallback: "Thread",
    lastReadAt: 0,
    latestAttentionAt: 2,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  });
}

function threadNode(entry: ThreadListEntry): ProjectThreadNode {
  return {
    thread: entry,
    children: [],
    depth: 0,
    stats: {
      childCount: 0,
      childActivity: NO_COLLAPSED_CHILD_ACTIVITY,
    },
  };
}

function threadItem(entry: ThreadListEntry): ProjectThreadItem {
  return { kind: "thread", node: threadNode(entry) };
}

function environmentItem(
  representative: ThreadListEntry,
  sibling: ThreadListEntry,
): ProjectThreadItem {
  return {
    kind: "environment",
    group: {
      environmentId: representative.environmentId ?? "env_test",
      nodes: [threadNode(representative), threadNode(sibling)],
      stats: {
        childCount: 0,
        childActivity: NO_COLLAPSED_CHILD_ACTIVITY,
      },
    },
  };
}

function sectionItem(name: string): ProjectThreadItem {
  return {
    kind: "section",
    group: {
      id: "sec_literal",
      key: "section:sec_literal",
      name,
      items: [],
      threadCount: 0,
      activity: NO_COLLAPSED_CHILD_ACTIVITY,
    },
  };
}

function itemRepresentativeId(item: ProjectThreadItem): string {
  switch (item.kind) {
    case "thread":
      return item.node.thread.id;
    case "environment":
      return item.group.nodes[0].thread.id;
    case "section":
      return item.group.id;
  }
}

const apple = thread({
  id: "thr_a",
  title: "Apple",
  createdAt: 100,
  latestAttentionAt: 100,
});
const banana = thread({
  id: "thr_b",
  title: "Banana",
  createdAt: 200,
  latestAttentionAt: 200,
});
const cherry = thread({
  id: "thr_c",
  title: "Cherry",
  createdAt: 300,
  latestAttentionAt: 300,
});

function order(comparator: ThreadComparator, entries: ThreadListEntry[]) {
  return [...entries].sort(comparator).map((entry) => entry.id);
}

describe("getSidebarThreadComparator", () => {
  it("created lists newest first", () => {
    expect(
      order(getSidebarThreadComparator("created"), [apple, banana, cherry]),
    ).toEqual(["thr_c", "thr_b", "thr_a"]);
  });

  it("updated lists most recent first", () => {
    expect(
      order(getSidebarThreadComparator("updated"), [apple, banana, cherry]),
    ).toEqual(["thr_c", "thr_b", "thr_a"]);
  });

  it("alphabetical lists A→Z", () => {
    expect(
      order(getSidebarThreadComparator("alpha"), [cherry, apple, banana]),
    ).toEqual(["thr_a", "thr_b", "thr_c"]);
  });

  it("alphabetizes resolved section, project, and thread mention labels", () => {
    const alphaTarget = thread({
      id: "thr_target_z",
      title: "Alpha target",
      titleFallback: "Alpha target",
    });
    const zuluTarget = thread({
      id: "thr_target_a",
      title: "Zulu target",
      titleFallback: "Zulu target",
    });
    const resources: ThreadTitleMentionResources = {
      sectionNamesById: new Map([
        ["sec_z", "Alpha section"],
        ["sec_a", "Zulu section"],
      ]),
      projectNamesById: new Map([
        ["proj_z", "Alpha project"],
        ["proj_a", "Zulu project"],
      ]),
      threadById: new Map([
        [alphaTarget.id, alphaTarget],
        [zuluTarget.id, zuluTarget],
      ]),
    };
    const resolvedFirst = thread({
      id: "thr_sort_z",
      title: "@section:sec_z @project:proj_z @thread:thr_target_z",
    });
    const resolvedLast = thread({
      id: "thr_sort_a",
      title: "@section:sec_a @project:proj_a @thread:thr_target_a",
    });

    expect(
      "@section:sec_z @project:proj_z @thread:thr_target_z".localeCompare(
        "@section:sec_a @project:proj_a @thread:thr_target_a",
      ),
    ).toBeGreaterThan(0);
    expect(
      order(getSidebarThreadComparator("alpha", resources), [
        resolvedLast,
        resolvedFirst,
      ]),
    ).toEqual(["thr_sort_z", "thr_sort_a"]);
  });

  it("uses resolved representative labels for environment items", () => {
    const zuluTarget = thread({
      id: "thr_target",
      title: "Zulu environment",
      titleFallback: "Zulu environment",
    });
    const environmentRepresentative = thread({
      id: "thr_env_a",
      environmentId: "env_a",
      title: "@thread:thr_target",
    });
    const plainThread = thread({ id: "thr_plain", title: "Apple thread" });
    const comparator = getSidebarThreadComparator("alpha", {
      sectionNamesById: new Map(),
      projectNamesById: new Map(),
      threadById: new Map([[zuluTarget.id, zuluTarget]]),
    });

    expect(comparator.compareItems).toBeDefined();
    expect(
      [
        environmentItem(
          environmentRepresentative,
          thread({ id: "thr_env_b", environmentId: "env_a" }),
        ),
        threadItem(plainThread),
      ]
        .sort(comparator.compareItems)
        .map(itemRepresentativeId),
    ).toEqual(["thr_plain", "thr_env_a"]);
  });

  it("sorts mention-shaped section names as literal text", () => {
    const target = thread({
      id: "thr_target",
      title: "Zulu resolved label",
      titleFallback: "Zulu resolved label",
    });
    const comparator = getSidebarThreadComparator("alpha", {
      sectionNamesById: new Map(),
      projectNamesById: new Map(),
      threadById: new Map([[target.id, target]]),
    });

    expect(
      [
        threadItem(thread({ id: "thr_plain", title: "Apple thread" })),
        sectionItem("@thread:thr_target"),
      ]
        .sort(comparator.compareItems)
        .map(itemRepresentativeId),
    ).toEqual(["sec_literal", "thr_plain"]);
  });

  it("breaks equal resolved titles by thread id", () => {
    const sameTarget = thread({
      id: "thr_target",
      title: "Same label",
      titleFallback: "Same label",
    });
    const comparator = getSidebarThreadComparator("alpha", {
      sectionNamesById: new Map(),
      projectNamesById: new Map(),
      threadById: new Map([[sameTarget.id, sameTarget]]),
    });
    const laterId = thread({ id: "thr_z", title: "@thread:thr_target" });
    const earlierId = thread({ id: "thr_a", title: "@thread:thr_target" });

    expect(order(comparator, [laterId, earlierId])).toEqual(["thr_a", "thr_z"]);
    expect(
      [threadItem(laterId), threadItem(earlierId)]
        .sort(comparator.compareItems)
        .map((item) =>
          item.kind === "thread" ? item.node.thread.id : "unexpected",
        ),
    ).toEqual(["thr_a", "thr_z"]);
  });

  it("alphabetical leaf and item comparators agree", () => {
    const comparator = getSidebarThreadComparator("alpha");
    expect(comparator.compareItems).toBeDefined();
    const leafSign = Math.sign(comparator(apple, banana));
    const itemSign = Math.sign(
      comparator.compareItems!(threadItem(apple), threadItem(banana)),
    );
    expect(itemSign).toBe(leafSign);
  });
});

describe("getSelectedThreadSidebarExpansion", () => {
  it("expands the personal threads section in project mode", () => {
    expect(
      getSelectedThreadSidebarExpansion({
        organizationMode: "project",
        isPinned: false,
        sidebarProjectId: PERSONAL_PROJECT_ID,
        selectedThread: thread({ projectId: PERSONAL_PROJECT_ID }),
      }),
    ).toEqual({ sidebarSectionId: "threads" });
  });

  it("expands the owning project in project mode", () => {
    expect(
      getSelectedThreadSidebarExpansion({
        organizationMode: "project",
        isPinned: false,
        sidebarProjectId: "proj_app",
        selectedThread: thread({ projectId: "proj_app" }),
      }),
    ).toEqual({ projectId: "proj_app" });
  });

  it("expands the root ancestor's project for a cross-project child in project mode", () => {
    expect(
      getSelectedThreadSidebarExpansion({
        organizationMode: "project",
        isPinned: false,
        sidebarProjectId: "proj_app",
        selectedThread: thread({
          projectId: "proj_web",
          parentThreadId: "thr_parent",
        }),
      }),
    ).toEqual({ projectId: "proj_app" });
  });

  it("expands the threads section for unsectioned project threads in sections mode", () => {
    expect(
      getSelectedThreadSidebarExpansion({
        organizationMode: "chronological",
        isPinned: false,
        sidebarProjectId: "proj_app",
        selectedThread: thread({ sectionId: null, projectId: "proj_app" }),
      }),
    ).toEqual({ sidebarSectionId: "threads" });
  });

  it("expands the containing section for sectioned threads in sections mode", () => {
    expect(
      getSelectedThreadSidebarExpansion({
        organizationMode: "chronological",
        isPinned: false,
        sidebarProjectId: "proj_app",
        selectedThread: thread({
          sectionId: "sec_work",
          projectId: "proj_app",
        }),
      }),
    ).toEqual({
      sectionKey: `${CHRONOLOGICAL_CONTAINER_ID}::sec_work`,
    });
  });

  it("expands the owning machine group in machine mode", () => {
    expect(
      getSelectedThreadSidebarExpansion({
        organizationMode: "machine",
        isPinned: false,
        sidebarProjectId: "proj_app",
        selectedThread: thread({
          projectId: "proj_app",
          environmentHostId: "host_a",
        }),
      }),
    ).toEqual({ machineKey: "host_a" });
    expect(
      getSelectedThreadSidebarExpansion({
        organizationMode: "machine",
        isPinned: false,
        sidebarProjectId: "proj_app",
        selectedThread: thread({ projectId: "proj_app" }),
      }),
    ).toEqual({ machineKey: "no-machine" });
  });

  it("expands the pinned section for pinned threads", () => {
    expect(
      getSelectedThreadSidebarExpansion({
        organizationMode: "chronological",
        isPinned: true,
        sidebarProjectId: "proj_app",
        selectedThread: thread({ sectionId: null, projectId: "proj_app" }),
      }),
    ).toEqual({ sidebarSectionId: "pinned" });
  });
});
