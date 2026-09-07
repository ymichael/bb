import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PluginHomepageSectionProps,
  PluginMessageDirectiveProps,
  PluginNavPanelProps,
} from "@get-bb/plugin-sdk";
import {
  beginPluginSlotBatch,
  getPluginSlotSnapshot,
  removePluginSlotRegistrations,
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
  subscribePluginSlots,
} from "./plugin-slots";
import { makePluginRegistrationSet as registrationSet } from "@/test/fixtures/plugins";

function SectionComponent(_props: Partial<PluginHomepageSectionProps>) {
  return null;
}
function PanelComponent(_props: PluginNavPanelProps) {
  return null;
}
function DirectiveComponent(_props: PluginMessageDirectiveProps) {
  return null;
}

afterEach(() => {
  resetPluginSlotStoreForTest();
});

describe("plugin slot store", () => {
  it("registers per plugin and flattens sorted by plugin id", () => {
    setPluginSlotRegistrations(
      "zeta",
      registrationSet({
        homepageSections: [
          { id: "z", title: "Zeta", component: SectionComponent },
        ],
      }),
    );
    setPluginSlotRegistrations(
      "alpha",
      registrationSet({
        homepageSections: [
          { id: "a", title: "Alpha", component: SectionComponent },
        ],
        composerCustomizations: [
          {
            id: "pick",
            actions: [{ id: "pick", component: SectionComponent }],
          },
        ],
      }),
    );

    const snapshot = getPluginSlotSnapshot();
    expect(
      snapshot.homepageSections.map((section) => section.pluginId),
    ).toEqual(["alpha", "zeta"]);
    expect(snapshot.composerCustomizations).toHaveLength(1);
    expect(snapshot.composerCustomizations[0]?.pluginId).toBe("alpha");
  });

  it("replaces a plugin's registrations wholesale (never appends)", () => {
    setPluginSlotRegistrations(
      "demo",
      registrationSet({
        homepageSections: [
          { id: "one", title: "One", component: SectionComponent },
          { id: "two", title: "Two", component: SectionComponent },
        ],
      }),
    );
    setPluginSlotRegistrations(
      "demo",
      registrationSet({
        homepageSections: [
          { id: "three", title: "Three", component: SectionComponent },
        ],
      }),
    );

    const snapshot = getPluginSlotSnapshot();
    expect(snapshot.homepageSections.map((section) => section.id)).toEqual([
      "three",
    ]);
    expect(snapshot.homepageSections[0]?.generation).toBe(2);
  });

  it("keeps New thread actions separate from thread-scoped actions", () => {
    const ActionComponent = () => null;
    setPluginSlotRegistrations(
      "demo",
      registrationSet({
        threadPanelActions: [
          { id: "thread", title: "Thread", component: ActionComponent },
        ],
        newThreadPanelActions: [
          { id: "compose", title: "Compose", component: ActionComponent },
        ],
      }),
    );

    const snapshot = getPluginSlotSnapshot();
    expect(snapshot.threadPanelActions.map((action) => action.id)).toEqual([
      "thread",
    ]);
    expect(snapshot.newThreadPanelActions.map((action) => action.id)).toEqual([
      "compose",
    ]);
  });

  it("replaces composer customizations wholesale with generation metadata", () => {
    setPluginSlotRegistrations(
      "demo",
      registrationSet({
        composerCustomizations: [{ id: "first" }, { id: "second" }],
      }),
    );
    setPluginSlotRegistrations(
      "demo",
      registrationSet({
        composerCustomizations: [{ id: "replacement" }],
      }),
    );

    expect(
      getPluginSlotSnapshot().composerCustomizations.map((registration) => ({
        id: registration.id,
        pluginId: registration.pluginId,
        generation: registration.generation,
      })),
    ).toEqual([{ id: "replacement", pluginId: "demo", generation: 2 }]);
  });

  it("removes a plugin's registrations and notifies subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePluginSlots(listener);
    setPluginSlotRegistrations(
      "demo",
      registrationSet({
        navPanels: [
          {
            id: "board",
            title: "Board",
            icon: "columns",
            path: "board",
            component: PanelComponent,
          },
        ],
      }),
    );
    expect(listener).toHaveBeenCalledTimes(1);

    removePluginSlotRegistrations("demo");
    expect(getPluginSlotSnapshot().navPanels).toHaveLength(0);
    expect(listener).toHaveBeenCalledTimes(2);

    removePluginSlotRegistrations("demo");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("returns a stable snapshot object between changes", () => {
    setPluginSlotRegistrations("demo", registrationSet());
    const first = getPluginSlotSnapshot();
    expect(getPluginSlotSnapshot()).toBe(first);
  });

  it("flattens messageDirectives sorted by plugin id with generation metadata", () => {
    setPluginSlotRegistrations(
      "zeta",
      registrationSet({
        messageDirectives: [{ id: "z-vis", component: DirectiveComponent }],
      }),
    );
    setPluginSlotRegistrations(
      "alpha",
      registrationSet({
        messageDirectives: [
          { id: "inline-vis", component: DirectiveComponent },
          { id: "chart", component: DirectiveComponent },
        ],
      }),
    );

    const snapshot = getPluginSlotSnapshot();
    expect(
      snapshot.messageDirectives.map((directive) => ({
        pluginId: directive.pluginId,
        id: directive.id,
        generation: directive.generation,
      })),
    ).toEqual([
      { pluginId: "alpha", id: "inline-vis", generation: 1 },
      { pluginId: "alpha", id: "chart", generation: 1 },
      { pluginId: "zeta", id: "z-vis", generation: 1 },
    ]);
  });

  it("replaces and removes messageDirectives on reload/uninstall", () => {
    setPluginSlotRegistrations(
      "demo",
      registrationSet({
        messageDirectives: [
          { id: "inline-vis", component: DirectiveComponent },
        ],
      }),
    );
    setPluginSlotRegistrations(
      "demo",
      registrationSet({
        messageDirectives: [{ id: "chart", component: DirectiveComponent }],
      }),
    );

    let snapshot = getPluginSlotSnapshot();
    expect(snapshot.messageDirectives.map((d) => d.id)).toEqual(["chart"]);
    expect(snapshot.messageDirectives[0]?.generation).toBe(2);

    removePluginSlotRegistrations("demo");
    snapshot = getPluginSlotSnapshot();
    expect(snapshot.messageDirectives).toHaveLength(0);
  });
});

describe("plugin slot store structural sharing", () => {
  it("keeps the messageActions array identity when a navPanels-only plugin registers", () => {
    setPluginSlotRegistrations(
      "actions",
      registrationSet({
        messageActions: [{ id: "copy", title: "copy", run: () => {} }],
      }),
    );
    const before = getPluginSlotSnapshot();

    setPluginSlotRegistrations(
      "board",
      registrationSet({
        navPanels: [
          {
            id: "board",
            title: "Board",
            icon: "columns",
            path: "board",
            component: PanelComponent,
          },
        ],
      }),
    );
    const after = getPluginSlotSnapshot();

    expect(after).not.toBe(before);
    expect(after.navPanels).toHaveLength(1);
    expect(after.messageActions).toBe(before.messageActions);
    expect(after.messageDirectives).toBe(before.messageDirectives);
    expect(after.composerCustomizations).toBe(before.composerCustomizations);
    expect(after.messageActions[0]).toBe(before.messageActions[0]);
  });

  it("does not notify when a registration changes nothing visible", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePluginSlots(listener);
    const before = getPluginSlotSnapshot();
    setPluginSlotRegistrations("empty", registrationSet());
    expect(getPluginSlotSnapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("re-registering a plugin replaces only its own kinds' arrays", () => {
    setPluginSlotRegistrations(
      "a",
      registrationSet({
        messageActions: [{ id: "a-copy", title: "a-copy", run: () => {} }],
      }),
    );
    setPluginSlotRegistrations(
      "b",
      registrationSet({
        messageDirectives: [{ id: "b-vis", component: DirectiveComponent }],
      }),
    );
    const before = getPluginSlotSnapshot();
    setPluginSlotRegistrations(
      "b",
      registrationSet({
        messageDirectives: [{ id: "b-chart", component: DirectiveComponent }],
      }),
    );
    const after = getPluginSlotSnapshot();
    expect(after.messageDirectives.map((d) => d.id)).toEqual(["b-chart"]);
    expect(after.messageDirectives[0]?.generation).toBe(2);
    expect(after.messageActions).toBe(before.messageActions);
  });
});

describe("plugin slot batches", () => {
  it("holds notifications until the batch closes and then notifies once", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePluginSlots(listener);
    const close = beginPluginSlotBatch({ maxHoldMs: 10_000 });
    setPluginSlotRegistrations(
      "a",
      registrationSet({
        messageActions: [{ id: "a", title: "a", run: () => {} }],
      }),
    );
    setPluginSlotRegistrations(
      "b",
      registrationSet({
        messageActions: [{ id: "b", title: "b", run: () => {} }],
      }),
    );
    expect(listener).not.toHaveBeenCalled();
    expect(getPluginSlotSnapshot().messageActions.map((a) => a.id)).toEqual([
      "a",
      "b",
    ]);
    close();
    expect(listener).toHaveBeenCalledTimes(1);
    close();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("flushes on the hold timer so a slow plugin cannot starve the others", () => {
    vi.useFakeTimers();
    try {
      const listener = vi.fn();
      const unsubscribe = subscribePluginSlots(listener);
      const close = beginPluginSlotBatch({ maxHoldMs: 100 });
      setPluginSlotRegistrations(
        "fast",
        registrationSet({
          messageActions: [{ id: "fast", title: "fast", run: () => {} }],
        }),
      );
      vi.advanceTimersByTime(99);
      expect(listener).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(listener).toHaveBeenCalledTimes(1);
      close();
      expect(listener).toHaveBeenCalledTimes(1);
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });
});
