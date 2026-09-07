import { describe, expect, it } from "vitest";
import type { PaletteAction } from "./palette-action";
import { rankPaletteActions } from "./palette-ranking";

function action(id: string, title: string, group: string): PaletteAction {
  return { id, title, group, shortcut: null, run: () => {} };
}

const ACTIONS: readonly PaletteAction[] = [
  action("app:thread.new", "New thread", "Threads"),
  action("app:thread.next", "Next thread", "Threads"),
  action("app:panel.toggle", "Toggle panel", "Window and layout"),
  action("app:browser.reload", "Reload page", "Browser"),
];

const titlesOf = (ranked: ReturnType<typeof rankPaletteActions>) =>
  ranked.map((entry) => entry.action.title);

describe("rankPaletteActions", () => {
  it("keeps build order with no query and no history", () => {
    expect(
      titlesOf(
        rankPaletteActions({ actions: ACTIONS, query: "", recentIds: [] }),
      ),
    ).toEqual(["New thread", "Next thread", "Toggle panel", "Reload page"]);
  });

  it("floats recently run actions to the top, most recent first", () => {
    expect(
      titlesOf(
        rankPaletteActions({
          actions: ACTIONS,
          query: "",
          recentIds: ["app:browser.reload", "app:panel.toggle"],
        }),
      ),
    ).toEqual(["Reload page", "Toggle panel", "New thread", "Next thread"]);
  });

  it("ignores history entries for actions that are not listed", () => {
    expect(
      titlesOf(
        rankPaletteActions({
          actions: ACTIONS,
          query: "",
          recentIds: ["plugin:gone/vanished", "app:thread.next"],
        }),
      ),
    ).toEqual(["Next thread", "New thread", "Toggle panel", "Reload page"]);
  });

  it("matches the group so a query can name a section", () => {
    expect(
      titlesOf(
        rankPaletteActions({
          actions: ACTIONS,
          query: "browser",
          recentIds: [],
        }),
      ),
    ).toEqual(["Reload page"]);
  });

  it("emphasizes matched characters of the title only", () => {
    const [first] = rankPaletteActions({
      actions: ACTIONS,
      query: "nt",
      recentIds: [],
    });
    expect(first?.action.title).toBe("New thread");
    expect(first?.positions).toEqual([0, 4]);
  });

  it("emphasizes nothing when the query only matched the group", () => {
    const [first] = rankPaletteActions({
      actions: ACTIONS,
      query: "browser",
      recentIds: [],
    });
    expect(first?.positions).toEqual([]);
  });

  it("breaks score ties on recency", () => {
    const tied = [
      action("app:a", "Toggle diff", "Workspace"),
      action("app:b", "Toggle diff", "Window and layout"),
    ];
    const ranked = rankPaletteActions({
      actions: tied,
      query: "toggle diff",
      recentIds: ["app:b"],
    });
    expect(ranked.map((entry) => entry.action.id)).toEqual(["app:b", "app:a"]);
  });
});
