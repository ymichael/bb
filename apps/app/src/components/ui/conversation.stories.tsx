import { ConversationEmptyState, ConversationTimeline } from "./conversation";

export default {
  title: "Primitives/Conversation",
};

export function TimelineSpacing() {
  return (
    <div className="max-w-3xl bg-background p-6 text-foreground">
      <ConversationTimeline>
        <div className="rounded-md border border-border/70 bg-card px-3 py-2 text-sm">
          User asked for timeline renderer cleanup.
        </div>
        <div className="rounded-md border border-border/70 bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Assistant is auditing component boundaries before editing.
        </div>
        <div className="rounded-md border border-border/70 bg-card px-3 py-2 text-sm">
          `pnpm exec turbo run typecheck --filter=@bb/app` passed.
        </div>
      </ConversationTimeline>
    </div>
  );
}

export function EmptyStates() {
  return (
    <div className="grid max-w-4xl grid-cols-1 gap-4 bg-background p-6 text-foreground md:grid-cols-2">
      <section className="rounded-md border border-border/70 p-4">
        <ConversationEmptyState message="No messages yet." />
      </section>
      <section className="rounded-md border border-border/70 p-4">
        <ConversationEmptyState
          message="No timeline activity for this turn."
          spacing="compact"
          alignment="left"
        />
      </section>
    </div>
  );
}
