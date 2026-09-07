import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_useCodeTheme,
  useRpc,
  type PluginFileOpenerProps,
} from "@get-bb/plugin-sdk/app";
import type * as MonacoNs from "monaco-editor";
import type { rpcContract } from "./server.js";
import { CLAIMED_EXTENSIONS, languageForPath } from "./lib/languages.js";
import {
  loadMonaco,
  overflowWidgetsNode,
  setOverflowWidgetsTheme,
} from "./lib/monaco-loader.js";
import { applyCodeTheme, editorBackground } from "./lib/monaco-theme.js";
import { cn } from "@bb/shared-ui/lib/utils";
import { FileToolbar, type SaveIndicator } from "./components/FileToolbar.js";
import { FileTreePanel } from "./components/FileTreePanel.js";
import type { FlatEntry } from "./lib/file-tree.js";
import {
  EDITOR_COMMANDS,
  forgetEditor,
  isCommandAvailable,
  markEditorActive,
  runEditorCommand,
} from "./lib/editor-commands.js";

type SaveState =
  | { kind: "clean" }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "error"; message: string }
  | { kind: "conflict" };

function MonacoFileOpener({ path, source, Original }: PluginFileOpenerProps) {
  const rpc = useRpc<typeof rpcContract>();
  const codeTheme = experimental_useCodeTheme();
  const codeThemeRef = useRef(codeTheme);
  codeThemeRef.current = codeTheme;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const monacoRef = useRef<typeof MonacoNs | null>(null);
  const editorRef = useRef<MonacoNs.editor.IStandaloneCodeEditor | null>(null);

  const [activePath, setActivePath] = useState(path);
  useEffect(() => setActivePath(path), [path]);

  const sha256Ref = useRef<string | null>(null);
  const saveStateRef = useRef<SaveState>({ kind: "clean" });

  const [saveState, setSaveStateValue] = useState<SaveState>({ kind: "clean" });
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [pendingDiscard, setPendingDiscard] = useState(false);
  const [isFilesOpen, setIsFilesOpen] = useState(false);
  const [pendingOpen, setPendingOpen] = useState<string | null>(null);
  const [tree, setTree] = useState<{
    entries: readonly FlatEntry[];
    root: string;
    truncated: boolean;
    isLoading: boolean;
    error: string | null;
  }>({
    entries: [],
    root: "",
    truncated: false,
    isLoading: false,
    error: null,
  });
  const [status, setStatus] = useState<
    | { kind: "loading" }
    | { kind: "ready" }
    | { kind: "delegate"; reason: string }
    | { kind: "error"; message: string }
  >({ kind: "loading" });

  const setSaveState = useCallback((next: SaveState) => {
    saveStateRef.current = next;
    setSaveStateValue(next);
  }, []);

  const save = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor) return;
    if (saveStateRef.current.kind === "saving") return;
    setSaveState({ kind: "saving" });
    try {
      const result = await rpc.call("write", {
        path: activePath,
        source,
        content: editor.getValue(),
        expectedSha256: sha256Ref.current,
      });
      if (result.outcome === "conflict") {
        setSaveState({ kind: "conflict" });
        return;
      }
      sha256Ref.current = result.sha256;
      setSaveState({ kind: "clean" });
    } catch (error) {
      setSaveState({
        kind: "error",
        message: error instanceof Error ? error.message : "Save failed",
      });
    }
  }, [activePath, rpc, setSaveState, source]);

  const saveRef = useRef(save);
  saveRef.current = save;

  const reloadFromDisk = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor) return;
    setIsRefreshing(true);
    try {
      const file = await rpc.call("read", { path: activePath, source });
      if (file.kind !== "text") return;
      sha256Ref.current = file.sha256;
      editor.setValue(file.content);
      setSaveState({ kind: "clean" });
    } catch (error) {
      setSaveState({
        kind: "error",
        message: error instanceof Error ? error.message : "Reload failed",
      });
    } finally {
      setIsRefreshing(false);
    }
  }, [activePath, rpc, setSaveState, source]);

  const treeRequestedRef = useRef(false);
  useEffect(() => {
    if (!isFilesOpen || treeRequestedRef.current) return;
    treeRequestedRef.current = true;
    let cancelled = false;
    setTree((current) => ({ ...current, isLoading: true, error: null }));
    void rpc
      .call("tree", { source })
      .then((result) => {
        if (cancelled) return;
        setTree({
          entries: result.entries,
          root: result.root,
          truncated: result.truncated,
          isLoading: false,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        treeRequestedRef.current = false;
        setTree({
          entries: [],
          root: "",
          truncated: false,
          isLoading: false,
          error:
            error instanceof Error ? error.message : "Could not list files",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [isFilesOpen, rpc, source]);

  const openFromTree = useCallback(
    (next: string) => {
      if (next === activePath) return;
      if (saveStateRef.current.kind === "dirty") {
        setPendingOpen(next);
        return;
      }
      setActivePath(next);
    },
    [activePath],
  );

  const requestRefresh = useCallback(() => {
    if (saveStateRef.current.kind === "dirty") {
      setPendingDiscard(true);
      return;
    }
    void reloadFromDisk();
  }, [reloadFromDisk]);

  const overwrite = useCallback(async () => {
    sha256Ref.current = null;
    const editor = editorRef.current;
    if (!editor) return;
    setSaveState({ kind: "saving" });
    try {
      const result = await rpc.call("write", {
        path: activePath,
        source,
        content: editor.getValue(),
        expectedSha256: null,
      });
      if (result.outcome === "conflict") {
        setSaveState({ kind: "conflict" });
        return;
      }
      sha256Ref.current = result.sha256;
      setSaveState({ kind: "clean" });
    } catch (error) {
      setSaveState({
        kind: "error",
        message: error instanceof Error ? error.message : "Save failed",
      });
    }
  }, [activePath, rpc, setSaveState, source]);

  useEffect(() => {
    let disposed = false;
    setStatus({ kind: "loading" });

    void (async () => {
      try {
        const [{ baseUrl }, file] = await Promise.all([
          rpc.call("assets"),
          rpc.call("read", { path: activePath, source }),
        ]);
        if (disposed) return;
        if (file.kind === "unsupported") {
          setStatus({ kind: "delegate", reason: file.reason });
          return;
        }

        const monaco = await loadMonaco(baseUrl);
        if (disposed) return;
        const container = containerRef.current;
        if (!container) return;
        monacoRef.current = monaco;

        sha256Ref.current = file.sha256;
        const applied = applyCodeTheme(monaco, codeThemeRef.current);
        setOverflowWidgetsTheme(applied.base);
        const editor = monaco.editor.create(container, {
          value: file.content,
          language: languageForPath(activePath),
          automaticLayout: true,
          lineNumbers: "on",
          theme: applied.name,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 12,
          lineHeight: 20,
          fontFamily:
            getComputedStyle(document.documentElement).getPropertyValue(
              "--font-mono",
            ) || undefined,
          fixedOverflowWidgets: true,
          overflowWidgetsDomNode: overflowWidgetsNode(),
        });
        editorRef.current = editor;
        const active = {
          editor,
          absolutePath: file.absolutePath,
          relativePath: file.relativePath,
        };
        markEditorActive(active);
        editor.onDidFocusEditorWidget(() => markEditorActive(active));
        setStatus({ kind: "ready" });

        editor.onDidChangeModelContent(() => {
          if (saveStateRef.current.kind === "clean") {
            setSaveState({ kind: "dirty" });
          }
        });
        editor.addCommand(
          monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
          () => void saveRef.current(),
        );
      } catch (error) {
        if (disposed) return;
        setStatus({
          kind: "error",
          message:
            error instanceof Error ? error.message : "Could not open this file",
        });
      }
    })();

    return () => {
      disposed = true;
      if (editorRef.current) forgetEditor(editorRef.current);
      editorRef.current?.getModel()?.dispose();
      editorRef.current?.dispose();
      editorRef.current = null;
    };
  }, [activePath, rpc, setSaveState, source]);

  useEffect(() => {
    const monaco = monacoRef.current;
    if (monaco === null) return;
    const applied = applyCodeTheme(monaco, codeTheme);
    editorRef.current?.updateOptions({ theme: applied.name });
    setOverflowWidgetsTheme(applied.base);
  }, [codeTheme, status]);

  if (status.kind === "delegate") return <Original />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {isFilesOpen ? (
        <FileTreePanel
          activePath={activePath}
          background={editorBackground(codeTheme.theme)}
          entries={tree.entries}
          error={tree.error}
          isLoading={tree.isLoading}
          root={tree.root}
          onClose={() => setIsFilesOpen(false)}
          onOpenFile={openFromTree}
          truncated={tree.truncated}
        />
      ) : null}
      <FileToolbar
        path={activePath}
        indicator={indicatorFor(saveState, status)}
        isRefreshing={isRefreshing}
        onRefresh={requestRefresh}
        isFilesOpen={isFilesOpen}
        onToggleFiles={() => setIsFilesOpen((open) => !open)}
      />
      <Notice
        onDiscardCancel={() => setPendingDiscard(false)}
        onDiscardConfirm={() => {
          setPendingDiscard(false);
          void reloadFromDisk();
        }}
        onOpenCancel={() => setPendingOpen(null)}
        onOpenConfirm={() => {
          const next = pendingOpen;
          setPendingOpen(null);
          if (next !== null) setActivePath(next);
        }}
        onOverwrite={() => void overwrite()}
        onReload={() => void reloadFromDisk()}
        pendingDiscard={pendingDiscard}
        pendingOpen={pendingOpen}
        saveState={saveState}
        status={status}
      />
      <div ref={containerRef} className="min-h-0 flex-1" />
    </div>
  );
}

function indicatorFor(
  saveState: SaveState,
  status: { kind: string },
): SaveIndicator {
  if (status.kind === "error") return "error";
  switch (saveState.kind) {
    case "saving":
      return "saving";
    case "dirty":
      return "dirty";
    case "error":
    case "conflict":
      return "error";
    default:
      return "clean";
  }
}

function Notice({
  onDiscardCancel,
  onDiscardConfirm,
  onOpenCancel,
  onOpenConfirm,
  onOverwrite,
  onReload,
  pendingDiscard,
  pendingOpen,
  saveState,
  status,
}: {
  onDiscardCancel: () => void;
  onDiscardConfirm: () => void;
  onOpenCancel: () => void;
  onOpenConfirm: () => void;
  onOverwrite: () => void;
  onReload: () => void;
  pendingDiscard: boolean;
  pendingOpen: string | null;
  saveState: SaveState;
  status: { kind: string; message?: string };
}) {
  if (status.kind === "error") {
    return <NoticeRow tone="error">{status.message}</NoticeRow>;
  }
  if (saveState.kind === "conflict") {
    return (
      <NoticeRow tone="error">
        This file changed on disk since you opened it.
        <NoticeAction onClick={onReload}>Reload</NoticeAction>
        <NoticeAction onClick={onOverwrite}>Overwrite</NoticeAction>
      </NoticeRow>
    );
  }
  if (pendingOpen !== null) {
    return (
      <NoticeRow tone="warning">
        Open {pendingOpen.split("/").at(-1)} and discard your unsaved changes?
        <NoticeAction onClick={onOpenConfirm}>Discard and open</NoticeAction>
        <NoticeAction onClick={onOpenCancel}>Cancel</NoticeAction>
      </NoticeRow>
    );
  }
  if (pendingDiscard) {
    return (
      <NoticeRow tone="warning">
        Reload from disk and discard your unsaved changes?
        <NoticeAction onClick={onDiscardConfirm}>Discard</NoticeAction>
        <NoticeAction onClick={onDiscardCancel}>Cancel</NoticeAction>
      </NoticeRow>
    );
  }
  if (saveState.kind === "error") {
    return <NoticeRow tone="error">{saveState.message}</NoticeRow>;
  }
  return null;
}

function NoticeRow({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "error" | "warning";
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex shrink-0 items-center gap-2 px-4 py-1.5 text-xs",
        tone === "error"
          ? "bg-destructive/10 text-destructive"
          : "bg-surface-recessed text-foreground",
      )}
    >
      {children}
    </div>
  );
}

function NoticeAction({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-pointer rounded-sm font-medium underline underline-offset-2 hover:opacity-80 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
    >
      {children}
    </button>
  );
}

export default definePluginApp((app) => {
  app.slots.fileOpener({
    id: "monaco",
    title: "File Editor",
    extensions: CLAIMED_EXTENSIONS,
    component: MonacoFileOpener,
  });

  for (const command of EDITOR_COMMANDS) {
    app.slots.commandPaletteAction({
      id: command.id,
      title: command.title,
      isAvailable: () => isCommandAvailable(command),
      run: () => runEditorCommand(command),
    });
  }
});
