import { getThreadRoutePath } from "@/lib/route-paths";
import { decideThreadDrop } from "@/lib/split-drag";
import { splitLayoutAtom } from "./atoms";
import {
  countPanes,
  findPaneByThread,
  MAX_PANES,
  replacePaneContent,
  setFocus,
  splitPane,
  type PaneContent,
  type SplitLayout,
} from "./index";

interface SplitLayoutStore {
  get(atom: typeof splitLayoutAtom): SplitLayout | null;
  set(atom: typeof splitLayoutAtom, value: SplitLayout): void;
}

interface OpenThreadInSplitArgs {
  store: SplitLayoutStore;
  navigate: (route: string, options?: { replace?: boolean }) => void;
  projectId: string;
  threadId: string;
  isCompact: boolean;
}

export function openThreadInSplit({
  store,
  navigate,
  projectId,
  threadId,
  isCompact,
}: OpenThreadInSplitArgs): void {
  const route = getThreadRoutePath({ projectId, threadId });
  const layout = store.get(splitLayoutAtom);
  if (isCompact || layout === null) {
    navigate(route);
    return;
  }
  const existing = findPaneByThread(layout.root, projectId, threadId);
  if (existing !== null) {
    const next = setFocus(layout, existing.paneId);
    if (next !== layout) {
      store.set(splitLayoutAtom, next);
    }
    navigate(route, { replace: true });
    return;
  }
  const decision = decideThreadDrop({
    zone: "right",
    threadAlreadyOpen: false,
    atMaxPanes: countPanes(layout.root) >= MAX_PANES,
  });
  const content: PaneContent = { kind: "thread", projectId, threadId };
  const next =
    decision.zone === "center"
      ? replacePaneContent(layout, layout.focusedPaneId, content)
      : splitPane(layout, layout.focusedPaneId, "right", content);
  if (next !== layout) {
    store.set(splitLayoutAtom, next);
  }
  navigate(route);
}
