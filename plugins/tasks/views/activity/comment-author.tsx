import type { DisplayComment } from "../../shared/contract.js";
import { commentByline } from "./time.js";

export function CommentAuthor({
  comment,
  onOpenThread,
}: {
  comment: DisplayComment;
  onOpenThread: (threadId: string) => void;
}) {
  const byline = commentByline(comment);
  if (byline.kind === "thread-link") {
    return (
      <button
        type="button"
        onClick={() => onOpenThread(byline.threadId)}
        className="truncate font-semibold text-primary hover:underline"
        title={byline.title}
      >
        {byline.title}
      </button>
    );
  }
  return <span className="font-semibold">{byline.name}</span>;
}
