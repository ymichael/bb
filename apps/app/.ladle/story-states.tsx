import type { CSSProperties, ReactNode } from "react";

export function StoryStates({
  title,
  description,
  renderedLabel = "Rendered page",
  renderedNote = "The real component",
  children,
}: {
  title: string;
  description: string;
  renderedLabel?: string;
  renderedNote?: string;
  children: ReactNode;
}) {
  return (
    <main
      className="mx-auto w-full max-w-[72rem] space-y-4 px-5 py-6"
      style={{ "--story-doc-width": "232px" } as CSSProperties}
    >
      <header>
        <h1 className="text-lg font-semibold text-foreground">{title}</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          {description}
        </p>
      </header>
      <div className="divide-y divide-border overflow-hidden rounded-md border border-border bg-card">
        <div className="grid grid-cols-[var(--story-doc-width)_minmax(0,1fr)] max-[900px]:hidden">
          <span className="flex flex-col border-r border-border bg-surface-recessed px-4 py-2">
            <span className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
              State
            </span>
            <span className="text-2xs text-subtle-foreground">
              When it happens
            </span>
          </span>
          <span className="flex flex-col px-4 py-2">
            <span className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
              {renderedLabel}
            </span>
            <span className="text-2xs text-subtle-foreground">
              {renderedNote}
            </span>
          </span>
        </div>
        {children}
      </div>
    </main>
  );
}

export function StoryState({
  name,
  note,
  children,
}: {
  name: string;
  note: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid grid-cols-[var(--story-doc-width)_minmax(0,1fr)] items-start max-[900px]:grid-cols-1">
      <div className="h-full border-r border-border bg-surface-recessed max-[900px]:border-b max-[900px]:border-r-0">
        <div className="sticky top-0 px-4 py-4">
          <h2 className="text-sm font-medium text-foreground">{name}</h2>
          <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {note}
          </div>
        </div>
      </div>
      <div className="min-w-0 px-5 py-5">{children}</div>
    </section>
  );
}

export function StoryStateGroup({
  title,
  note,
}: {
  title: string;
  note?: string;
}) {
  return (
    <div className="border-b border-border bg-surface-recessed px-5 py-2.5">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-foreground">
        {title}
      </h2>
      {note ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>
      ) : null}
    </div>
  );
}
