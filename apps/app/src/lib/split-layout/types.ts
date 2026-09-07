export type PaneContent =
  | {
      kind: "thread";
      projectId: string;
      threadId: string;
    }
  | {
      kind: "new-thread";
    }
  | {
      kind: "plugin-panel";
      pluginId: string;
      panelPath: string;
      subPath: string;
    }
  | {
      kind: "plugin-detail";
      pluginId: string;
    };

export interface PaneNode {
  type: "pane";
  paneId: string;
  content: PaneContent;
}

export interface SplitNode {
  type: "split";
  dir: "row" | "col";
  sizes: number[];
  children: LayoutNode[];
}

export type LayoutNode = PaneNode | SplitNode;

export interface SplitLayout {
  root: LayoutNode;
  focusedPaneId: string;
}

export type SplitSide = "left" | "right" | "top" | "bottom";
export type SplitPath = readonly number[];
