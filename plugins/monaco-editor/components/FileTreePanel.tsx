import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ancestorsOf,
  buildTree,
  filterTree,
  type FlatEntry,
  type TreeNode,
} from "../lib/file-tree.js";
import { toast } from "sonner";
import {
  clampTreeHeight,
  readStoredTreeHeight,
  storeTreeHeight,
} from "../lib/file-tree-height.js";
import { ContextMenu, type ContextMenuState } from "./ContextMenu.js";
import { cn } from "@bb/shared-ui/lib/utils";

export interface FileTreePanelProps {
  entries: readonly FlatEntry[];
  root: string;
  isLoading: boolean;
  error: string | null;
  truncated: boolean;
  activePath: string;
  background: string | null;
  onOpenFile: (path: string) => void;
  onClose: () => void;
}

const INDENT_PER_LEVEL_PX = 12;

export function FileTreePanel({
  background,
  entries,
  root,
  isLoading,
  error,
  truncated,
  activePath,
  onOpenFile,
  onClose,
}: FileTreePanelProps) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const activeRowRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(readStoredTreeHeight);
  const heightRef = useRef(height);
  heightRef.current = height;
  const requestedHeightRef = useRef(height);
  const dragStartHeightRef = useRef<number | null>(null);

  const availableHeight = (): number =>
    panelRef.current?.parentElement?.clientHeight ?? window.innerHeight;

  const applyHeight = (requested: number) => {
    requestedHeightRef.current = requested;
    setHeight(clampTreeHeight(requested, availableHeight()));
  };

  const startResize = () => {
    dragStartHeightRef.current = heightRef.current;
  };

  const resizeBy = (deltaY: number) => {
    applyHeight((dragStartHeightRef.current ?? heightRef.current) + deltaY);
  };

  const commitHeight = () => {
    dragStartHeightRef.current = null;
    storeTreeHeight(heightRef.current);
  };

  useLayoutEffect(() => {
    const parent = panelRef.current?.parentElement;
    if (parent === null || parent === undefined) return;
    const fit = () => {
      const next = clampTreeHeight(
        requestedHeightRef.current,
        parent.clientHeight,
      );
      if (next !== heightRef.current) setHeight(next);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  const openMenu = (event: React.MouseEvent, node: TreeNode) => {
    event.preventDefault();
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        {
          label: "Copy absolute path",
          onSelect: () =>
            copy(
              root === ""
                ? node.path
                : root.includes("\\")
                  ? `${root}\\${node.path.replace(/\//g, "\\")}`
                  : `${root}/${node.path}`,
              "Absolute path copied",
            ),
        },
        {
          label: "Copy relative path",
          onSelect: () => copy(node.path, "Relative path copied"),
        },
        {
          label: "Copy filename",
          onSelect: () => copy(node.name, "Filename copied"),
        },
      ],
    });
  };

  const tree = useMemo(() => buildTree(entries), [entries]);
  const filtered = useMemo(() => filterTree(tree, query), [tree, query]);

  useEffect(() => {
    setExpanded((current) => {
      const next = new Set(current);
      for (const ancestor of ancestorsOf(activePath)) next.add(ancestor);
      return next;
    });
  }, [activePath]);

  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [activePath, entries.length]);

  const effectiveExpanded = useMemo(() => {
    if (filtered.expand.size === 0) return expanded;
    return new Set([...expanded, ...filtered.expand]);
  }, [expanded, filtered.expand]);

  const toggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div
      ref={panelRef}
      style={{
        height,
        ...(background === null ? {} : { backgroundColor: background }),
      }}
      className={cn(
        "flex shrink-0 flex-col",
        background === null && "bg-surface-recessed",
      )}
    >
      {}
      <div className="flex h-9 shrink-0 items-center gap-1.5 bg-surface-raised px-4">
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            if (query !== "") setQuery("");
            else onClose();
          }}
          placeholder="Filter files…"
          aria-label="Filter files"
          spellCheck={false}
          className={cn(
            "h-6 min-w-0 flex-1 rounded-sm bg-state-hover px-2 text-sm text-foreground",
            "placeholder:text-muted-foreground",
            "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
          )}
        />
        <button
          type="button"
          onClick={onClose}
          title="Hide files"
          aria-label="Hide files"
          className={cn(
            "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md",
            "text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground",
            "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
          )}
        >
          <svg viewBox="0 0 24 24" fill="none" className="size-3.5" aria-hidden>
            <path
              d="M18 6L6 18M6 6l12 12"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-1">
        {error !== null ? (
          <Message tone="error">{error}</Message>
        ) : isLoading ? (
          <Message>Loading files…</Message>
        ) : filtered.nodes.length === 0 ? (
          <Message>
            {query.trim() === "" ? "No files" : `No files match “${query}”`}
          </Message>
        ) : (
          <Rows
            activePath={activePath}
            activeRowRef={activeRowRef}
            expanded={effectiveExpanded}
            level={0}
            nodes={filtered.nodes}
            onContextMenu={openMenu}
            onOpenFile={onOpenFile}
            onToggle={toggle}
          />
        )}
        {truncated && error === null ? (
          <Message>
            Showing the first {entries.length.toLocaleString()} entries; this
            project is larger.
          </Message>
        ) : null}
      </div>
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
      <ResizeHandle
        onResize={resizeBy}
        onResizeEnd={commitHeight}
        onResizeStart={startResize}
      />
    </div>
  );
}

function ResizeHandle({
  onResize,
  onResizeEnd,
  onResizeStart,
}: {
  onResize: (deltaY: number) => void;
  onResizeEnd: () => void;
  onResizeStart: () => void;
}) {
  const dividerRef = useRef<HTMLDivElement | null>(null);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const startY = event.clientY;
    const divider = dividerRef.current;
    if (divider !== null) divider.dataset.dragging = "true";
    onResizeStart();
    target.setPointerCapture(pointerId);

    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      onResize(moveEvent.clientY - startY);
    };
    const finish = (finishEvent: PointerEvent) => {
      if (finishEvent.pointerId !== pointerId) return;
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", finish);
      target.removeEventListener("pointercancel", finish);
      if (target.hasPointerCapture(pointerId)) {
        target.releasePointerCapture(pointerId);
      }
      if (divider !== null) delete divider.dataset.dragging;
      onResizeEnd();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", finish);
    target.addEventListener("pointercancel", finish);
  };

  return (
    <div
      ref={dividerRef}
      role="separator"
      aria-label="Resize the file tree"
      aria-orientation="horizontal"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "ArrowUp") onResize(-KEYBOARD_RESIZE_STEP_PX);
        else if (event.key === "ArrowDown") onResize(KEYBOARD_RESIZE_STEP_PX);
        else return;
        event.preventDefault();
        onResizeEnd();
      }}
      className={cn(
        "relative z-10 h-px shrink-0 cursor-row-resize bg-border transition-colors",
        "hover:bg-ring/40 data-[dragging]:bg-ring/40",
        "focus-visible:bg-ring focus-visible:outline-none",
      )}
    >
      <div
        aria-hidden
        onPointerDown={handlePointerDown}
        className="absolute -top-1.5 left-0 h-3 w-full cursor-row-resize touch-none bg-transparent"
      />
    </div>
  );
}

const KEYBOARD_RESIZE_STEP_PX = 24;

function copy(text: string, successMessage: string): void {
  void navigator.clipboard
    .writeText(text)
    .then(() => toast.success(successMessage))
    .catch(() => toast.error("Failed to copy"));
}

function Rows({
  activePath,
  activeRowRef,
  expanded,
  level,
  nodes,
  onContextMenu,
  onOpenFile,
  onToggle,
}: {
  activePath: string;
  activeRowRef: React.RefObject<HTMLButtonElement | null>;
  expanded: ReadonlySet<string>;
  level: number;
  nodes: readonly TreeNode[];
  onContextMenu: (event: React.MouseEvent, node: TreeNode) => void;
  onOpenFile: (path: string) => void;
  onToggle: (path: string) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        const isDirectory = node.kind === "directory";
        const isOpen = isDirectory && expanded.has(node.path);
        const isActive = !isDirectory && node.path === activePath;
        return (
          <div key={node.path}>
            <button
              type="button"
              ref={isActive ? activeRowRef : undefined}
              onClick={() =>
                isDirectory ? onToggle(node.path) : onOpenFile(node.path)
              }
              onContextMenu={(event) => onContextMenu(event, node)}
              title={node.path}
              aria-expanded={isDirectory ? isOpen : undefined}
              aria-current={isActive ? "true" : undefined}
              style={{ paddingLeft: 8 + level * INDENT_PER_LEVEL_PX }}
              className={cn(
                "flex h-6 w-full cursor-pointer items-center gap-1 pr-2 text-left text-sm",
                "hover:bg-state-hover",
                isActive
                  ? "bg-state-hover font-medium text-file-accent"
                  : "text-foreground",
              )}
            >
              <span className="flex size-3 shrink-0 items-center justify-center text-subtle-foreground">
                {isDirectory ? <Chevron isOpen={isOpen} /> : null}
              </span>
              <span className="truncate">{node.name}</span>
            </button>
            {isDirectory && isOpen ? (
              <Rows
                activePath={activePath}
                activeRowRef={activeRowRef}
                expanded={expanded}
                level={level + 1}
                nodes={node.children}
                onContextMenu={onContextMenu}
                onOpenFile={onOpenFile}
                onToggle={onToggle}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

function Chevron({ isOpen }: { isOpen: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={cn("size-3 transition-transform", isOpen && "rotate-90")}
      aria-hidden
    >
      <path
        d="M9 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Message({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "error";
}) {
  return (
    <p
      className={cn(
        "px-3 py-2 text-sm",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </p>
  );
}
