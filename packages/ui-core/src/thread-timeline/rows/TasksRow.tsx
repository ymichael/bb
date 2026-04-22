import { taskStatusGlyph } from "@bb/core-ui";
import type { ViewTasksMessage } from "@bb/domain";
import { ExpandablePanel } from "../../disclosure.js";
import { useLatestInitialExpanded } from "../latestInitialExpanded.js";
import {
  EventTitle,
  ExpandableDetailScrollArea,
  getEventHeaderToneClass,
} from "./shared.js";

interface TasksRowProps {
  initialExpanded?: boolean;
  message: ViewTasksMessage;
}

function statusLabel(message: ViewTasksMessage): string {
  switch (message.status) {
    case "pending":
      return "Updating";
    case "error":
      return "Failed";
    case "interrupted":
      return "Interrupted";
    case "completed":
      return "Updated";
  }
}

export function TasksRow({
  message,
  initialExpanded = false,
}: TasksRowProps) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(initialExpanded);
  const summaryContent = (
    <EventTitle
      prefix={`${statusLabel(message)} tasks`}
      tone={message.status === "error" ? "destructive" : "default"}
      shimmerPrefix={message.status === "pending"}
    />
  );

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <ExpandablePanel
          isExpanded={isExpanded}
          summaryContent={summaryContent}
          headerToneClass={getEventHeaderToneClass(
            isExpanded,
            message.status === "error" ? "destructive" : "default",
          )}
          onToggle={onToggle}
        >
          <ExpandableDetailScrollArea className="mt-0.5 space-y-1">
            {message.tasks.map((task, index) => (
              <div
                key={`${message.id}:${index}`}
                className="grid grid-cols-[auto_1fr] gap-2 font-mono text-xs text-foreground/85"
              >
                <span>{taskStatusGlyph(task.status)}</span>
                <span
                  className={
                    task.status === "completed"
                      ? "line-through text-muted-foreground"
                      : task.status === "active"
                        ? "font-semibold"
                        : ""
                  }
                >
                  {task.text}
                </span>
              </div>
            ))}
          </ExpandableDetailScrollArea>
        </ExpandablePanel>
      </div>
    </div>
  );
}
