import type {
  PendingInteractionUserAnswer,
  PendingInteractionUserQuestionQuestion,
} from "@bb/domain";
import type { TimelineQuestionViewWorkRow } from "@bb/thread-view";
import { formatPendingInteractionUserQuestionOptionLabel } from "@bb/core-ui";
import { DetailCard, DetailRow } from "@/components/ui/detail-card.js";

interface QuestionWorkRowBodyProps {
  row: TimelineQuestionViewWorkRow;
}

interface AnsweredQuestionRowProps {
  question: PendingInteractionUserQuestionQuestion;
  answer: PendingInteractionUserAnswer | null;
}

export function QuestionWorkRowBody({ row }: QuestionWorkRowBodyProps) {
  // `resolving` and `answered` both have a recorded answer set — the
  // projection wires `row.answers` from the resolution as soon as the user
  // submits. Pending, interrupted, and expired states are fully described by
  // the row title (see `mapQuestionTitle` in @bb/thread-view), so their body
  // collapses out and the row renders title-only like web-search/web-fetch.
  if (row.lifecycle !== "answered" && row.lifecycle !== "resolving") {
    return null;
  }
  return (
    <DetailCard labelWidth="120px">
      {row.questions.map((question) => (
        <AnsweredQuestionRow
          key={question.id}
          question={question}
          answer={row.answers?.[question.id] ?? null}
        />
      ))}
    </DetailCard>
  );
}

function AnsweredQuestionRow({ question, answer }: AnsweredQuestionRowProps) {
  const label = question.shortLabel ?? question.prompt;
  const selectedLabels =
    answer?.selected.map((value) =>
      formatPendingInteractionUserQuestionOptionLabel({ question, value }),
    ) ?? [];
  const freeText = answer?.freeText ?? null;
  const hasContent = selectedLabels.length > 0 || freeText !== null;

  if (!hasContent) {
    return (
      <DetailRow label={label}>
        <span className="text-muted-foreground">No answer</span>
      </DetailRow>
    );
  }

  return (
    <DetailRow label={label} align="start">
      {selectedLabels.length > 0 ? (
        <div>{selectedLabels.join(", ")}</div>
      ) : null}
      {freeText ? (
        <div className="whitespace-pre-wrap">{freeText}</div>
      ) : null}
    </DetailRow>
  );
}
