import { StatusPill } from "./status-pill";
import { ThreePaneLayout } from "./three-pane-layout";

export default {
  title: "Primitives/ThreePaneLayout",
};

export function MainAndRightPane() {
  return (
    <div className="max-w-5xl p-6">
      <ThreePaneLayout
        main={<MainPane />}
        right={<RightPane />}
        mainClassName="rounded-md border border-border bg-card p-4"
        rightClassName="rounded-md border border-border bg-card p-4"
      />
    </div>
  );
}

export function MainOnly() {
  return (
    <div className="max-w-5xl p-6">
      <ThreePaneLayout
        main={<MainPane />}
        mainClassName="rounded-md border border-border bg-card p-4"
      />
    </div>
  );
}

function MainPane() {
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Thread timeline</h3>
        <StatusPill variant="emphasis">Running</StatusPill>
      </div>
      <div className="grid gap-2">
        <TimelineBlock title="Plan updated" />
        <TimelineBlock title="Files inspected" />
        <TimelineBlock title="Patch ready" />
      </div>
    </div>
  );
}

function RightPane() {
  return (
    <div className="grid gap-3 text-sm">
      <h3 className="font-semibold">Context</h3>
      <p className="text-muted-foreground">
        Workspace notes stay visible while timeline activity continues.
      </p>
      <div className="rounded-md bg-muted p-3">3 changed files</div>
    </div>
  );
}

interface TimelineBlockProps {
  title: string;
}

function TimelineBlock({ title }: TimelineBlockProps) {
  return (
    <div className="rounded-md border border-border bg-background p-3 text-sm">
      {title}
    </div>
  );
}
