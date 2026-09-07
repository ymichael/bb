import type { TaskPriority, TaskStatus } from "../../shared/contract.js";
import { cn } from "@bb/shared-ui/lib/utils";

const STATUS_CLASS: Record<TaskStatus, string> = {
  backlog: "text-muted-foreground",
  todo: "text-muted-foreground",
  in_progress: "text-attention",
  in_review: "text-timeline-accent",
  done: "text-success",
  canceled: "text-muted-foreground",
};

function statusArtwork(status: TaskStatus) {
  switch (status) {
    case "backlog":
      return (
        <circle
          cx="7"
          cy="7"
          r="5.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeDasharray="1.8 2"
        />
      );
    case "todo":
      return (
        <circle
          cx="7"
          cy="7"
          r="5.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        />
      );
    case "in_progress":
      return (
        <>
          <circle
            cx="7"
            cy="7"
            r="5.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          />
          <path d="M7 7 L7 2.4 A4.6 4.6 0 0 1 11.2 9.5 Z" fill="currentColor" />
        </>
      );
    case "in_review":
      return (
        <>
          <circle
            cx="7"
            cy="7"
            r="5.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          />
          <path d="M7 7 L7 2.4 A4.6 4.6 0 1 1 6.99 2.4 Z" fill="currentColor" />
        </>
      );
    case "done":
      return (
        <>
          <circle cx="7" cy="7" r="6" fill="currentColor" />
          <path
            d="M4.4 7.2 l1.8 1.8 3.4-3.8"
            stroke="var(--canvas)"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
          />
        </>
      );
    case "canceled":
      return (
        <>
          <circle cx="7" cy="7" r="6" fill="currentColor" />
          <path
            d="M5 5 l4 4 M9 5 l-4 4"
            stroke="var(--canvas)"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </>
      );
  }
}

export function StatusIcon({
  status,
  className,
}: {
  status: TaskStatus;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 14 14"
      aria-hidden
      data-status-icon={status}
      className={cn("size-3.5 shrink-0", STATUS_CLASS[status], className)}
    >
      {statusArtwork(status)}
    </svg>
  );
}

const PRIORITY_LIT_BARS: Record<Exclude<TaskPriority, "urgent">, number> = {
  high: 3,
  medium: 2,
  low: 1,
  none: 0,
};

export function PriorityIcon({
  priority,
  className,
}: {
  priority: TaskPriority;
  className?: string;
}) {
  if (priority === "urgent") {
    return (
      <svg
        viewBox="0 0 14 14"
        aria-hidden
        data-priority-icon={priority}
        className={cn("size-3.5 shrink-0", className)}
      >
        <rect width="14" height="14" rx="3" className="fill-warning" />
        <path
          d="M7 3.2v4.4"
          stroke="var(--canvas)"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <circle cx="7" cy="10.6" r="1.1" fill="var(--canvas)" />
      </svg>
    );
  }
  const lit = PRIORITY_LIT_BARS[priority];
  const bars = [
    { x: 1.5, height: 5 },
    { x: 5.5, height: 8 },
    { x: 9.5, height: 11 },
  ];
  return (
    <svg
      viewBox="0 0 14 14"
      aria-hidden
      data-priority-icon={priority}
      className={cn(
        "size-3.5 shrink-0",
        priority === "none" && "opacity-40",
        className,
      )}
    >
      {bars.map((bar, index) => (
        <rect
          key={bar.x}
          x={bar.x}
          y={13 - bar.height}
          width="3"
          height={bar.height}
          rx="1"
          className={index < lit ? "fill-muted-foreground" : "fill-muted"}
        />
      ))}
    </svg>
  );
}
