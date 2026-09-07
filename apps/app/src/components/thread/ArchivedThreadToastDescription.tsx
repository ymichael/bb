interface ArchivedThreadToastDescriptionProps {
  archivedThreadCount: number;
  onOpenThread: () => void;
  threadTitle: string;
}

function formatArchivedChildThreadLabel(childThreadCount: number): string {
  return childThreadCount === 1
    ? "and 1 child thread"
    : `and ${childThreadCount} child threads`;
}

export function ArchivedThreadToastDescription({
  archivedThreadCount,
  onOpenThread,
  threadTitle,
}: ArchivedThreadToastDescriptionProps) {
  const childThreadCount = archivedThreadCount - 1;

  return (
    <span className="flex min-w-0 items-baseline gap-1">
      <button
        type="button"
        className="min-w-0 flex-1 cursor-pointer truncate rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        title={threadTitle}
        onClick={onOpenThread}
      >
        {threadTitle}
      </button>
      {childThreadCount > 0 ? (
        <>
          <span className="shrink-0" aria-hidden>
            +{childThreadCount}
          </span>
          <span className="sr-only">
            {` ${formatArchivedChildThreadLabel(childThreadCount)}`}
          </span>
        </>
      ) : null}
    </span>
  );
}
