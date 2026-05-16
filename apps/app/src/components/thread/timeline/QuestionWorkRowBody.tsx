import { assertNever } from "@bb/core-ui";
import type { TimelineQuestionViewWorkRow } from "@bb/thread-view";
import { Pill } from "@/components/ui/pill.js";
import {
  UserQuestionAnswerSummaryList,
  UserQuestionLifecycleNotice,
  UserQuestionPromptList,
} from "@/components/thread/user-questions/UserQuestionInteractionContent.js";

interface QuestionWorkRowBodyProps {
  row: TimelineQuestionViewWorkRow;
}

interface QuestionWorkRowReadOnlyViewProps {
  row: TimelineQuestionViewWorkRow;
}

function PendingQuestionsView({ row }: QuestionWorkRowReadOnlyViewProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <Pill variant="secondary">Waiting</Pill>
      </div>
      <UserQuestionPromptList questions={row.questions} />
    </div>
  );
}

function AnsweredQuestionsView({ row }: QuestionWorkRowReadOnlyViewProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <Pill variant="secondary">Answered</Pill>
      </div>
      <UserQuestionAnswerSummaryList
        answers={row.answers}
        questions={row.questions}
      />
    </div>
  );
}

export function QuestionWorkRowBody({ row }: QuestionWorkRowBodyProps) {
  switch (row.lifecycle) {
    case "pending":
      return <PendingQuestionsView row={row} />;
    case "resolving":
      return (
        <UserQuestionLifecycleNotice
          message="Answer submitted. Delivering it to the provider."
          statusReason={row.statusReason}
          tone="default"
        />
      );
    case "answered":
      return <AnsweredQuestionsView row={row} />;
    case "interrupted":
      return (
        <UserQuestionLifecycleNotice
          message="This question was interrupted."
          statusReason={row.statusReason}
          tone="danger"
        />
      );
    case "expired":
      return (
        <UserQuestionLifecycleNotice
          message="This question expired."
          statusReason={row.statusReason}
          tone="danger"
        />
      );
    default:
      return assertNever(row.lifecycle);
  }
}
