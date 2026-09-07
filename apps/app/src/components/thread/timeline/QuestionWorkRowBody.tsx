import type {
  PendingInteractionUserAnswer,
  PendingInteractionUserQuestionQuestion,
} from "@bb/domain";
import type { TimelineQuestionViewWorkRow } from "@bb/thread-view";
import { formatPendingInteractionUserQuestionOptionLabel } from "@bb/core-ui";

interface QuestionWorkRowBodyProps {
  row: TimelineQuestionViewWorkRow;
}

interface AnsweredQuestionRowProps {
  question: PendingInteractionUserQuestionQuestion;
  answer: PendingInteractionUserAnswer | null;
}

export function QuestionWorkRowBody({ row }: QuestionWorkRowBodyProps) {
  if (row.lifecycle !== "answered" && row.lifecycle !== "resolving") {
    return null;
  }
  return (
    <div className="space-y-3 text-xs leading-snug">
      {row.questions.map((question) => (
        <AnsweredQuestionRow
          key={question.id}
          question={question}
          answer={row.answers?.[question.id] ?? null}
        />
      ))}
    </div>
  );
}

function AnsweredQuestionRow({ question, answer }: AnsweredQuestionRowProps) {
  const selectedLabels =
    answer?.selected.map((value) =>
      formatPendingInteractionUserQuestionOptionLabel({ question, value }),
    ) ?? [];
  const freeText = answer?.freeText ?? null;
  const hasContent = selectedLabels.length > 0 || freeText !== null;

  return (
    <div>
      {}
      <div className="text-subtle-foreground">{question.prompt}</div>
      {hasContent ? (
        <div className="mt-0.5 text-foreground">
          {selectedLabels.length > 0 ? (
            <div>{selectedLabels.join(", ")}</div>
          ) : null}
          {freeText ? (
            <div className="whitespace-pre-wrap">{freeText}</div>
          ) : null}
        </div>
      ) : (
        <div className="mt-0.5 text-subtle-foreground">No answer</div>
      )}
    </div>
  );
}
