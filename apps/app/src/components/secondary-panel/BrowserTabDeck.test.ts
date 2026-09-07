import { afterEach, describe, expect, it } from "vitest";
import type { BbDesktopBrowserApi } from "@bb/desktop-contract";
import type { BrowserFixedPanelTab } from "@/lib/fixed-panel-tabs-state";
import { createNoopDesktopBrowserApi } from "@/test/bb-desktop-test-utils";
import {
  createBrowserViewVisibilityCoordinator,
  resetBrowserViewPersistence,
} from "./browserViewVisibilityCoordinator";
import { buildBrowserTabIdSet, selectActiveBrowserTab } from "./BrowserTabDeck";

function makeBrowserTab(id: string, url: string): BrowserFixedPanelTab {
  return {
    environmentId: "env-1",
    id,
    kind: "browser",
    title: null,
    url,
  };
}

interface AttachCall {
  tabId: string;
  url: string;
}

interface VisibilityCall {
  tabId: string;
  visible: boolean;
}

interface RecordingApi {
  api: BbDesktopBrowserApi;
  attachments: AttachCall[];
  navigations: AttachCall[];
  visibility: VisibilityCall[];
}

function createRecordingApi(): RecordingApi {
  const attachments: AttachCall[] = [];
  const navigations: AttachCall[] = [];
  const visibility: VisibilityCall[] = [];
  const api: BbDesktopBrowserApi = {
    ...createNoopDesktopBrowserApi(),
    attach(request) {
      attachments.push({ tabId: request.tabId, url: request.url });
    },
    navigate(request) {
      navigations.push({ tabId: request.tabId, url: request.url });
    },
    setVisible(request) {
      visibility.push({ tabId: request.tabId, visible: request.visible });
    },
  };
  return { api, attachments, navigations, visibility };
}

afterEach(() => {
  resetBrowserViewPersistence();
});

describe("selectActiveBrowserTab", () => {
  it("selects exactly the active tab out of many persisted tabs", () => {
    const tabs = [
      makeBrowserTab("tab-a", "https://a.example"),
      makeBrowserTab("tab-b", "https://b.example"),
      makeBrowserTab("tab-c", "https://c.example"),
    ];

    const selected = selectActiveBrowserTab(tabs, "tab-b");

    expect(selected).toBe(tabs[1]);
    expect(selected).not.toBe(tabs[0]);
    expect(selected).not.toBe(tabs[2]);
  });

  it("returns null when there is no active browser tab id", () => {
    const tabs = [makeBrowserTab("tab-a", "https://a.example")];

    expect(selectActiveBrowserTab(tabs, null)).toBeNull();
  });

  it("returns null when the active id is not an open browser tab", () => {
    const tabs = [
      makeBrowserTab("tab-a", "https://a.example"),
      makeBrowserTab("tab-b", "https://b.example"),
    ];

    expect(selectActiveBrowserTab(tabs, "tab-missing")).toBeNull();
  });

  it("returns null for an empty tab list regardless of active id", () => {
    expect(selectActiveBrowserTab([], "tab-a")).toBeNull();
    expect(selectActiveBrowserTab([], null)).toBeNull();
  });
});

describe("buildBrowserTabIdSet", () => {
  it("collects every open tab id into a lookup set", () => {
    const browserTabs = [
      makeBrowserTab("tab-a", "https://a.example"),
      makeBrowserTab("tab-b", "https://b.example"),
    ];

    const ids = buildBrowserTabIdSet({ browserTabs });

    expect(ids.has("tab-a")).toBe(true);
    expect(ids.has("tab-b")).toBe(true);
    expect(ids.has("tab-missing")).toBe(false);
    expect(ids.size).toBe(2);
  });

  it("is empty for no open tabs", () => {
    expect(buildBrowserTabIdSet({ browserTabs: [] }).size).toBe(0);
  });
});

describe("restoring a thread with persisted browser tabs", () => {
  it("drives one real attach + show through the coordinator for the restored active tab", () => {
    const browserTabs = [
      makeBrowserTab("tab-a", "https://a.example"),
      makeBrowserTab("tab-b", "https://b.example"),
      makeBrowserTab("tab-c", "https://c.example"),
    ];
    const activeBrowserTab = selectActiveBrowserTab(browserTabs, "tab-b");
    expect(activeBrowserTab).not.toBeNull();
    if (activeBrowserTab === null) {
      throw new Error("expected an active browser tab");
    }

    const { api, attachments, visibility } = createRecordingApi();
    const coordinator = createBrowserViewVisibilityCoordinator(api);

    let syncBoundsCalls = 0;
    api.attach({
      threadId: "thread-1",
      tabId: activeBrowserTab.id,
      url: activeBrowserTab.url,
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
    });
    coordinator.show(activeBrowserTab.id, () => {
      syncBoundsCalls += 1;
    });

    expect(attachments).toEqual([{ tabId: "tab-b", url: "https://b.example" }]);
    expect(syncBoundsCalls).toBe(1);
    expect(visibility).toEqual([{ tabId: "tab-b", visible: true }]);
  });

  it("hides the previously-shown tab before showing the next when the user switches", () => {
    const { api, visibility } = createRecordingApi();
    const coordinator = createBrowserViewVisibilityCoordinator(api);

    coordinator.show("tab-b", () => {});
    coordinator.show("tab-a", () => {});

    expect(visibility).toEqual([
      { tabId: "tab-b", visible: true },
      { tabId: "tab-b", visible: false },
      { tabId: "tab-a", visible: true },
    ]);
  });
});
