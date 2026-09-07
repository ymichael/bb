import { useLayoutEffect, useRef, useState } from "react";
import { StoryCard, StoryRow } from "../../../../.ladle/story-card";
import {
  TimelineSelectionMenu,
  type TimelineSelectionMenuProps,
} from "./TimelineSelectionMenu";
import type { MessageProseSelection } from "./SelectableMessageProse";

export default {
  title: "thread/timeline/SelectionMenu",
};

const AGENT_TEXT =
  "The migration runs in three phases. First we backfill the new column with a default value at the server boundary, then flip reads over once every row is populated. Only after that do we drop the legacy field, so a rollback at any point keeps the table readable.";

type Handlers = Pick<TimelineSelectionMenuProps, "onAddToChat" | "onDismiss">;

const logHandlers: Handlers = {
  onAddToChat: (text) => console.log("onAddToChat", text),
  onDismiss: () => console.log("onDismiss"),
};

function AgentMessageWithMenu({
  text = AGENT_TEXT,
  selected,
  handlers = logHandlers,
}: {
  text?: string;
  selected: string;
  handlers?: Handlers;
}) {
  const spanRef = useRef<HTMLSpanElement>(null);
  const [selection, setSelection] = useState<MessageProseSelection | null>(
    null,
  );

  useLayoutEffect(() => {
    const el = spanRef.current;
    if (!el) return;
    const measure = () =>
      setSelection({ text: selected, rect: el.getBoundingClientRect() });
    measure();
    const raf = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [selected]);

  const start = text.indexOf(selected);
  const before = start >= 0 ? text.slice(0, start) : text;
  const after = start >= 0 ? text.slice(start + selected.length) : "";

  return (
    <div
      data-thread-window
      className="relative w-full overflow-hidden rounded-md border bg-background p-3"
    >
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-subtle-foreground">
        Agent
      </p>
      <div className="group/message text-sm leading-relaxed">
        <p className="whitespace-pre-wrap break-words">
          {before}
          {start >= 0 ? (
            <span
              ref={spanRef}
              className="rounded-sm bg-surface-selected ring-1 ring-surface-selected-border"
            >
              {selected}
            </span>
          ) : null}
          {after}
        </p>
      </div>
      {selection ? (
        <TimelineSelectionMenu selection={selection} {...handlers} />
      ) : null}
    </div>
  );
}

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="Selection in an agent message"
        hint="The menu floats just above the highlighted text"
      >
        <AgentMessageWithMenu selected="flip reads over once every row is populated" />
      </StoryRow>
      <StoryRow label="Short selection" hint="A single phrase">
        <AgentMessageWithMenu selected="backfill the new column" />
      </StoryRow>
    </StoryCard>
  );
}

export function CompactViewport() {
  return (
    <StoryCard>
      <StoryRow
        label="Compact viewport"
        hint="The selection menu remains anchored instead of becoming a drawer"
      >
        <div className="w-[360px]">
          <AgentMessageWithMenu selected="drop the legacy field" />
        </div>
      </StoryRow>
    </StoryCard>
  );
}

export function Interactive() {
  const [log, setLog] = useState<string[]>([]);
  const push = (entry: string) =>
    setLog((prev) => [entry, ...prev].slice(0, 6));

  return (
    <StoryCard>
      <StoryRow
        label="Click actions / Escape"
        hint="Buttons log; Escape or outside-click dismisses"
      >
        <div className="flex flex-col gap-3">
          <AgentMessageWithMenu
            selected="flip reads over once every row is populated"
            handlers={{
              onAddToChat: (text) => push(`Add to chat: "${text}"`),
              onDismiss: () => push("Dismissed"),
            }}
          />
          <ul className="text-xs text-muted-foreground">
            {log.length === 0 ? <li>No events yet</li> : null}
            {log.map((entry, index) => (
              <li key={index}>{entry}</li>
            ))}
          </ul>
        </div>
      </StoryRow>
    </StoryCard>
  );
}
