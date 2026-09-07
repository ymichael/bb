import { useState } from "react";
import {
  definePluginApp,
  type PluginFileOpenerProps,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";

const LABEL = "Beta";

function BetaThreadList({
  activeProjectId,
  activeThreadId,
  Original,
  searchQuery,
}: PluginThreadListProps) {
  const [embedOriginal, setEmbedOriginal] = useState(false);
  const [shouldCrash, setShouldCrash] = useState(false);
  if (shouldCrash) throw new Error("Beta thread-list test crash");

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground">
      <LabHeader
        kind="Thread list"
        embedOriginal={embedOriginal}
        onEmbedOriginalChange={setEmbedOriginal}
        onCrash={() => setShouldCrash(true)}
      />
      {embedOriginal ? (
        <div className="flex min-h-0 flex-1 flex-col border-t border-border">
          <Original />
        </div>
      ) : (
        <div className="space-y-3 overflow-auto p-3 text-xs">
          <p className="rounded-md border border-dashed border-border bg-muted/30 p-3">
            Beta owns the scrolling thread-list region.
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-muted-foreground">
            <dt>Thread</dt>
            <dd className="truncate font-mono">{activeThreadId ?? "none"}</dd>
            <dt>Project</dt>
            <dd className="truncate font-mono">{activeProjectId ?? "none"}</dd>
            <dt>Search</dt>
            <dd className="truncate font-mono">{searchQuery || "empty"}</dd>
          </dl>
          <p className="text-muted-foreground">
            Disable Alpha to see Automatic reveal this provider.
          </p>
        </div>
      )}
    </section>
  );
}

function BetaFileOpener({ Original, path, source }: PluginFileOpenerProps) {
  const [embedOriginal, setEmbedOriginal] = useState(false);
  const [shouldCrash, setShouldCrash] = useState(false);
  if (shouldCrash) throw new Error("Beta file-opener test crash");

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground">
      <LabHeader
        kind="File opener"
        embedOriginal={embedOriginal}
        onEmbedOriginalChange={setEmbedOriginal}
        onCrash={() => setShouldCrash(true)}
      />
      <div className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
        <span className="font-mono text-foreground">{path}</span>
        <span className="ml-2">({source.kind})</span>
      </div>
      {embedOriginal ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <Original />
        </div>
      ) : (
        <div className="grid flex-1 place-items-center p-6 text-center">
          <div>
            <p className="text-lg font-medium">Beta Markdown renderer</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Disable Alpha to exercise automatic fallback.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

function LabHeader({
  embedOriginal,
  kind,
  onCrash,
  onEmbedOriginalChange,
}: {
  embedOriginal: boolean;
  kind: string;
  onCrash: () => void;
  onEmbedOriginalChange: (next: boolean) => void;
}) {
  return (
    <header className="flex items-center gap-2 border-b border-border bg-muted/20 px-3 py-2 text-xs">
      <strong className="mr-auto">
        {LABEL} · {kind}
      </strong>
      <label className="flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={embedOriginal}
          onChange={(event) => onEmbedOriginalChange(event.target.checked)}
        />
        Embed BB original
      </label>
      <button
        type="button"
        className="rounded border border-border px-2 py-1 hover:bg-muted"
        onClick={onCrash}
      >
        Crash
      </button>
    </header>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadList({
    id: "beta-list",
    title: "Replacement Lab Beta",
    description: "Test provider Beta.",
    component: BetaThreadList,
  });
  app.slots.fileOpener({
    id: "beta-markdown",
    title: "Beta Markdown",
    extensions: ["md", "mdx"],
    component: BetaFileOpener,
  });
});
