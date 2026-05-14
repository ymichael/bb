// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ThreadSecondaryPanel } from "@/lib/thread-secondary-panel";
import {
  useThreadSecondaryPanelVisibility,
  type ThreadSecondaryPanelDiffFileOpenHandler,
  type ThreadSecondaryPanelOpenHandler,
} from "./useThreadSecondaryPanelVisibility";

interface VisibilityHarnessProps {
  initialActivePanel?: ThreadSecondaryPanel | null;
  isCompactViewport: boolean;
  threadId: string | undefined;
}

function useVisibilityHarness({
  initialActivePanel = null,
  isCompactViewport,
  threadId,
}: VisibilityHarnessProps) {
  const [activePanel, setActivePanel] =
    useState<ThreadSecondaryPanel | null>(initialActivePanel);
  const [closePersistedPanel] = useState(() =>
    vi.fn(() => {
      setActivePanel(null);
    }),
  );
  const [openPersistedPanel] = useState(() =>
    vi.fn<ThreadSecondaryPanelOpenHandler>((panel) => {
      setActivePanel(panel);
    }),
  );
  const [openPersistedDiffPanel] = useState(() =>
    vi.fn(() => {
      setActivePanel("git-diff");
    }),
  );
  const [openPersistedDiffFile] = useState(() =>
    vi.fn<ThreadSecondaryPanelDiffFileOpenHandler>(() => {
      setActivePanel("git-diff");
    }),
  );
  const [togglePersistedPanel] = useState(() =>
    vi.fn(() => {
      setActivePanel((current) =>
        current === null ? "thread-info" : null,
      );
    }),
  );

  const visibility = useThreadSecondaryPanelVisibility({
    activePanel,
    closePersistedPanel,
    isCompactViewport,
    openPersistedDiffFile,
    openPersistedDiffPanel,
    openPersistedPanel,
    threadId,
    togglePersistedPanel,
  });

  return {
    activePanel,
    closePersistedPanel,
    openPersistedDiffFile,
    openPersistedDiffPanel,
    openPersistedPanel,
    togglePersistedPanel,
    visibility,
  };
}

describe("useThreadSecondaryPanelVisibility", () => {
  it("keeps a restored compact drawer closed without clearing persisted state", () => {
    const props: VisibilityHarnessProps = {
      initialActivePanel: "thread-info",
      isCompactViewport: true,
      threadId: "thr-one",
    };
    const { result } = renderHook(() => useVisibilityHarness(props));

    expect(result.current.visibility.isOpen).toBe(false);
    expect(result.current.activePanel).toBe("thread-info");
    expect(result.current.closePersistedPanel).not.toHaveBeenCalled();
  });

  it("does not auto-open or clear state during a wide-compact-wide transition", () => {
    let props: VisibilityHarnessProps = {
      initialActivePanel: "git-diff",
      isCompactViewport: false,
      threadId: "thr-one",
    };
    const { rerender, result } = renderHook(() =>
      useVisibilityHarness(props),
    );

    expect(result.current.visibility.isOpen).toBe(true);

    props = {
      ...props,
      isCompactViewport: true,
    };
    rerender();

    expect(result.current.visibility.isOpen).toBe(false);
    expect(result.current.activePanel).toBe("git-diff");
    expect(result.current.closePersistedPanel).not.toHaveBeenCalled();
    expect(result.current.openPersistedPanel).not.toHaveBeenCalled();
    expect(result.current.togglePersistedPanel).not.toHaveBeenCalled();

    props = {
      ...props,
      isCompactViewport: false,
    };
    rerender();

    expect(result.current.visibility.isOpen).toBe(true);
    expect(result.current.activePanel).toBe("git-diff");
  });

  it("opens an already-restored compact drawer without writing persisted state", () => {
    const props: VisibilityHarnessProps = {
      initialActivePanel: "git-diff",
      isCompactViewport: true,
      threadId: "thr-one",
    };
    const { result } = renderHook(() => useVisibilityHarness(props));

    act(() => {
      result.current.visibility.togglePanel();
    });

    expect(result.current.visibility.isOpen).toBe(true);
    expect(result.current.activePanel).toBe("git-diff");
    expect(result.current.openPersistedPanel).not.toHaveBeenCalled();
    expect(result.current.togglePersistedPanel).not.toHaveBeenCalled();
  });

  it("treats compact first-toggle without a persisted panel as transient", () => {
    let props: VisibilityHarnessProps = {
      isCompactViewport: true,
      threadId: "thr-one",
    };
    const { rerender, result } = renderHook(() =>
      useVisibilityHarness(props),
    );

    act(() => {
      result.current.visibility.togglePanel();
    });

    expect(result.current.visibility.isOpen).toBe(true);
    expect(result.current.activePanel).toBeNull();
    expect(result.current.openPersistedPanel).not.toHaveBeenCalled();
    expect(result.current.togglePersistedPanel).not.toHaveBeenCalled();

    props = {
      ...props,
      isCompactViewport: false,
    };
    rerender();

    expect(result.current.visibility.isOpen).toBe(false);
    expect(result.current.activePanel).toBeNull();
  });

  it("persists explicit compact panel selection and reveals the drawer", () => {
    const props: VisibilityHarnessProps = {
      isCompactViewport: true,
      threadId: "thr-one",
    };
    const { result } = renderHook(() => useVisibilityHarness(props));

    act(() => {
      result.current.visibility.openPanel("thread-info");
    });

    expect(result.current.visibility.isOpen).toBe(true);
    expect(result.current.activePanel).toBe("thread-info");
    expect(result.current.openPersistedPanel).toHaveBeenCalledWith(
      "thread-info",
    );
  });

  it("persists explicit compact diff panel opens and reveals the drawer", () => {
    const props: VisibilityHarnessProps = {
      isCompactViewport: true,
      threadId: "thr-one",
    };
    const { result } = renderHook(() => useVisibilityHarness(props));

    act(() => {
      result.current.visibility.openDiffPanel();
    });

    expect(result.current.visibility.isOpen).toBe(true);
    expect(result.current.activePanel).toBe("git-diff");
    expect(result.current.openPersistedDiffPanel).toHaveBeenCalled();
  });

  it("persists compact diff file opens and reveals the drawer", () => {
    const props: VisibilityHarnessProps = {
      isCompactViewport: true,
      threadId: "thr-one",
    };
    const { result } = renderHook(() => useVisibilityHarness(props));

    act(() => {
      result.current.visibility.openDiffFile("src/app.ts");
    });

    expect(result.current.visibility.isOpen).toBe(true);
    expect(result.current.activePanel).toBe("git-diff");
    expect(result.current.openPersistedDiffFile).toHaveBeenCalledWith(
      "src/app.ts",
    );
  });

  it("dismisses the compact drawer without clearing the remembered panel", () => {
    const props: VisibilityHarnessProps = {
      initialActivePanel: "thread-info",
      isCompactViewport: true,
      threadId: "thr-one",
    };
    const { result } = renderHook(() => useVisibilityHarness(props));

    act(() => {
      result.current.visibility.togglePanel();
    });
    expect(result.current.visibility.isOpen).toBe(true);

    act(() => {
      result.current.visibility.closePanel();
    });

    expect(result.current.visibility.isOpen).toBe(false);
    expect(result.current.activePanel).toBe("thread-info");
    expect(result.current.closePersistedPanel).not.toHaveBeenCalled();
  });

  it("does not let a stale compact close hide the current thread drawer", () => {
    let props: VisibilityHarnessProps = {
      initialActivePanel: "thread-info",
      isCompactViewport: true,
      threadId: "thr-one",
    };
    const { rerender, result } = renderHook(() =>
      useVisibilityHarness(props),
    );

    act(() => {
      result.current.visibility.togglePanel();
    });
    const staleClosePanel = result.current.visibility.closePanel;

    props = {
      ...props,
      threadId: "thr-two",
    };
    rerender();
    act(() => {
      result.current.visibility.togglePanel();
    });
    expect(result.current.visibility.isOpen).toBe(true);

    act(() => {
      staleClosePanel();
    });

    expect(result.current.visibility.isOpen).toBe(true);
  });

  it("delegates open and close to persisted panel state on desktop", () => {
    const props: VisibilityHarnessProps = {
      isCompactViewport: false,
      threadId: "thr-one",
    };
    const { result } = renderHook(() => useVisibilityHarness(props));

    act(() => {
      result.current.visibility.togglePanel();
    });
    expect(result.current.visibility.isOpen).toBe(true);
    expect(result.current.activePanel).toBe("thread-info");
    expect(result.current.togglePersistedPanel).toHaveBeenCalled();

    act(() => {
      result.current.visibility.closePanel();
    });
    expect(result.current.visibility.isOpen).toBe(false);
    expect(result.current.activePanel).toBeNull();
    expect(result.current.closePersistedPanel).toHaveBeenCalled();

    act(() => {
      result.current.visibility.openPanel("git-diff");
    });
    expect(result.current.visibility.isOpen).toBe(true);
    expect(result.current.activePanel).toBe("git-diff");
    expect(result.current.openPersistedPanel).toHaveBeenCalledWith("git-diff");
  });
});
