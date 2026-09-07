import { afterEach, describe, expect, it } from "vitest";
import type { BbDesktopBrowserApi } from "@bb/desktop-contract";
import { createNoopDesktopBrowserApi } from "@/test/bb-desktop-test-utils";
import {
  createBrowserViewVisibilityCoordinator,
  destroyPersistedBrowserViewsForEnvironment,
  destroyPersistedBrowserViewsForThread,
  registerBrowserView,
  resetBrowserViewPersistence,
} from "./browserViewVisibilityCoordinator";

interface VisibilityCall {
  tabId: string;
  visible: boolean;
}

interface RecordingApi {
  api: BbDesktopBrowserApi;
  detachments: string[];
  visibility: VisibilityCall[];
}

function createRecordingApi(): RecordingApi {
  const detachments: string[] = [];
  const visibility: VisibilityCall[] = [];
  const api: BbDesktopBrowserApi = {
    ...createNoopDesktopBrowserApi(),
    detach(tabId) {
      detachments.push(tabId);
    },
    setVisible(request) {
      visibility.push({ tabId: request.tabId, visible: request.visible });
    },
  };
  return { api, detachments, visibility };
}

afterEach(() => {
  resetBrowserViewPersistence();
});

describe("browserViewVisibilityCoordinator", () => {
  it("hides the previously-visible view before showing the next one", () => {
    const { api, visibility } = createRecordingApi();
    const coordinator = createBrowserViewVisibilityCoordinator(api);

    coordinator.show("a", () => {});
    coordinator.show("b", () => {});

    expect(visibility).toEqual([
      { tabId: "a", visible: true },
      { tabId: "a", visible: false },
      { tabId: "b", visible: true },
    ]);
  });

  it("syncs bounds before showing", () => {
    const order: string[] = [];
    const api: BbDesktopBrowserApi = {
      ...createNoopDesktopBrowserApi(),
      setVisible(request) {
        if (request.visible) {
          order.push(`show:${request.tabId}`);
        }
      },
    };
    const coordinator = createBrowserViewVisibilityCoordinator(api);

    coordinator.show("a", () => order.push("bounds:a"));

    expect(order).toEqual(["bounds:a", "show:a"]);
  });

  it("does not re-hide when re-showing the already-visible tab", () => {
    const { api, visibility } = createRecordingApi();
    const coordinator = createBrowserViewVisibilityCoordinator(api);

    coordinator.show("a", () => {});
    coordinator.show("a", () => {});

    expect(visibility).toEqual([
      { tabId: "a", visible: true },
      { tabId: "a", visible: true },
    ]);
  });

  it("releases a tab so a later show does not touch the destroyed view", () => {
    const { api, visibility } = createRecordingApi();
    const coordinator = createBrowserViewVisibilityCoordinator(api);

    coordinator.show("a", () => {});
    coordinator.release("a");
    coordinator.show("b", () => {});

    expect(visibility).toEqual([
      { tabId: "a", visible: true },
      { tabId: "b", visible: true },
    ]);
  });

  it("keeps visibility ownership local to each browser deck", () => {
    const { api, visibility } = createRecordingApi();
    const firstDeckCoordinator = createBrowserViewVisibilityCoordinator(api);
    const secondDeckCoordinator = createBrowserViewVisibilityCoordinator(api);

    firstDeckCoordinator.show("thread-a-tab", () => {});
    secondDeckCoordinator.show("thread-b-tab", () => {});

    expect(visibility).toEqual([
      { tabId: "thread-a-tab", visible: true },
      { tabId: "thread-b-tab", visible: true },
    ]);
  });

  it("destroys registered views for a deleted thread only", () => {
    const { api, detachments, visibility } = createRecordingApi();
    registerBrowserView({
      environmentId: "environment-a",
      tabId: "thread-a-tab",
      threadId: "thread-a",
    });
    registerBrowserView({
      environmentId: "environment-b",
      tabId: "thread-b-tab",
      threadId: "thread-b",
    });

    destroyPersistedBrowserViewsForThread({
      desktopBrowser: api,
      threadId: "thread-a",
    });

    expect(visibility).toEqual([{ tabId: "thread-a-tab", visible: false }]);
    expect(detachments).toEqual(["thread-a-tab"]);
  });

  it("destroys registered views for a deleted environment only", () => {
    const { api, detachments, visibility } = createRecordingApi();
    registerBrowserView({
      environmentId: "environment-a",
      tabId: "thread-a-tab",
      threadId: "thread-a",
    });
    registerBrowserView({
      environmentId: "environment-b",
      tabId: "thread-b-tab",
      threadId: "thread-b",
    });

    destroyPersistedBrowserViewsForEnvironment({
      desktopBrowser: api,
      environmentId: "environment-b",
    });

    expect(visibility).toEqual([{ tabId: "thread-b-tab", visible: false }]);
    expect(detachments).toEqual(["thread-b-tab"]);
  });
});
