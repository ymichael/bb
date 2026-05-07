import type { ReactNode } from "react";
import { cn } from "./cn";
import { TruncateStart } from "./truncate-start";

export default {
  title: "Primitives/TruncateStart",
};

const longPath =
  "/Users/michael/src/bb/apps/app/src/components/promptbox/PromptMentionMenu.tsx";

export function Widths() {
  return (
    <div className="grid max-w-xl gap-3 p-6 text-sm">
      <PathFrame className="max-w-sm">
        <TruncateStart title={longPath}>{longPath}</TruncateStart>
      </PathFrame>
      <PathFrame className="max-w-xs">
        <TruncateStart title={longPath}>{longPath}</TruncateStart>
      </PathFrame>
      <PathFrame className="max-w-48">
        <TruncateStart title={longPath}>{longPath}</TruncateStart>
      </PathFrame>
    </div>
  );
}

interface PathFrameProps {
  children: ReactNode;
  className: string;
}

function PathFrame({ children, className }: PathFrameProps) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-md border border-border bg-card p-3",
        className,
      )}
    >
      {children}
    </div>
  );
}
