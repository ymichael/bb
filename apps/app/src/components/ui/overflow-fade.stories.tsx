import type { ReactNode } from "react";
import { cn } from "./cn";
import { OverflowFade } from "./overflow-fade";

export default {
  title: "Primitives/OverflowFade",
};

export function Placements() {
  return (
    <div className="grid max-w-3xl gap-6 p-6 md:grid-cols-2">
      <FadeFrame label="Above">
        <OverflowFade placement="above" tone="background" />
      </FadeFrame>
      <FadeFrame label="Below">
        <OverflowFade placement="below" tone="background" />
      </FadeFrame>
    </div>
  );
}

export function Tones() {
  return (
    <div className="grid max-w-3xl gap-6 p-6 md:grid-cols-2">
      <FadeFrame label="Background">
        <OverflowFade placement="above" tone="background" />
      </FadeFrame>
      <FadeFrame label="Sidebar" className="bg-sidebar">
        <OverflowFade placement="above" tone="sidebar" />
      </FadeFrame>
    </div>
  );
}

interface FadeFrameProps {
  children: ReactNode;
  className?: string;
  label: string;
}

function FadeFrame({ children, className, label }: FadeFrameProps) {
  return (
    <div className="pt-8">
      <div
        className={cn(
          "relative h-28 overflow-visible rounded-md border border-border bg-background p-4",
          className,
        )}
      >
        {children}
        <div className="space-y-2 text-sm">
          <p className="font-medium">{label}</p>
          <p className="text-muted-foreground">Pinned panel edge</p>
        </div>
      </div>
    </div>
  );
}
