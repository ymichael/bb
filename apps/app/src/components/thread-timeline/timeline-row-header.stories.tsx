import { TimelineStaticRowHeader } from "./TimelineRowHeader.js";

export default {
  title: "Thread Timeline/TimelineRowHeader",
};

export function HeaderPadding() {
  return (
    <div className="flex max-w-3xl flex-col gap-4 bg-background p-6 text-foreground">
      <div className="rounded-md border border-border/70">
        <TimelineStaticRowHeader>
          <span className="text-sm font-medium text-foreground">
            Default timeline row header
          </span>
        </TimelineStaticRowHeader>
      </div>
      <div className="rounded-md border border-border/70">
        <TimelineStaticRowHeader horizontalPadding="flush">
          <span className="text-sm font-medium text-foreground">
            Flush header for nested row groups
          </span>
        </TimelineStaticRowHeader>
      </div>
      <div className="rounded-md border border-destructive/40">
        <TimelineStaticRowHeader className="text-destructive">
          <span className="truncate text-sm font-medium">
            Error row header with a long command that must truncate before it
            overlaps adjacent content
          </span>
        </TimelineStaticRowHeader>
      </div>
    </div>
  );
}
