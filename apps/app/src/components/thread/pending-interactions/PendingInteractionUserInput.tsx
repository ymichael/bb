import {
  type PendingInteraction,
  type PendingInteractionUserInputQuestion,
} from "@bb/domain";
import { StatusPill } from "@bb/ui-core";
import { cn } from "@/lib/utils";
import { Input } from "../../ui/input";
import { Textarea } from "../../ui/textarea";
import { type UserInputDraftState } from "./banner-helpers";

interface QuestionAnswerFieldProps {
  disabled: boolean;
  draftState: UserInputDraftState;
  interaction: PendingInteraction;
  onDraftStateChange: (nextState: UserInputDraftState) => void;
}

interface QuestionOptionPreviewProps {
  preview: string | null;
}

interface InteractionQuestionAnswerArgs {
  draftState: UserInputDraftState;
  question: PendingInteractionUserInputQuestion;
}

function buildUserInputAnswers(
  args: InteractionQuestionAnswerArgs,
): string[] {
  const selectedOptions =
    args.draftState.selectedOptionsByQuestionId[args.question.id] ?? [];
  const customAnswer =
    args.draftState.customAnswersByQuestionId[args.question.id]?.trim() ?? "";

  if (args.question.multiSelect) {
    return customAnswer.length > 0
      ? [...selectedOptions, customAnswer]
      : selectedOptions;
  }

  if (customAnswer.length > 0) {
    return [customAnswer];
  }

  return selectedOptions.length > 0 ? [selectedOptions[0]] : [];
}

function QuestionOptionPreview({
  preview,
}: QuestionOptionPreviewProps) {
  if (!preview) {
    return null;
  }

  return (
    <div className="rounded bg-background/70 px-2 py-1 font-mono text-xs text-muted-foreground">
      {preview}
    </div>
  );
}

export function createInitialUserInputDraftState(
  interaction: PendingInteraction,
): UserInputDraftState {
  if (interaction.payload.kind !== "user_input_request") {
    return {
      customAnswersByQuestionId: {},
      selectedOptionsByQuestionId: {},
    };
  }

  return {
    customAnswersByQuestionId: Object.fromEntries(
      interaction.payload.questions.map((question) => [question.id, ""]),
    ),
    selectedOptionsByQuestionId: Object.fromEntries(
      interaction.payload.questions.map((question) => [question.id, []]),
    ),
  };
}

export function buildUserInputResolution(
  draftState: UserInputDraftState,
  interaction: PendingInteraction,
) {
  if (interaction.payload.kind !== "user_input_request") {
    return null;
  }
  if (interaction.payload.questions.length === 0) {
    return null;
  }

  const answers = Object.fromEntries(
    interaction.payload.questions.map((question) => [
      question.id,
      buildUserInputAnswers({
        draftState,
        question,
      }),
    ]),
  );

  const hasMissingAnswer = interaction.payload.questions.some((question) =>
    answers[question.id].length === 0
  );
  if (hasMissingAnswer) {
    return null;
  }

  return {
    kind: "user_input_request" as const,
    answers,
  };
}

export function PendingInteractionUserInputFields({
  disabled,
  draftState,
  interaction,
  onDraftStateChange,
}: QuestionAnswerFieldProps) {
  if (interaction.payload.kind !== "user_input_request") {
    return null;
  }
  if (interaction.payload.questions.length === 0) {
    return (
      <div className="rounded-md border border-border/60 bg-background/45 px-3 py-2 text-sm text-muted-foreground">
        This request did not include any questions.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {interaction.payload.questions.map((question) => {
        const selectedOptions =
          draftState.selectedOptionsByQuestionId[question.id] ?? [];
        const customAnswer =
          draftState.customAnswersByQuestionId[question.id] ?? "";
        const textInputType = question.isSecret ? "password" : "text";
        const answerCount = buildUserInputAnswers({
          draftState,
          question,
        }).length;

        return (
          <div
            key={question.id}
            className="rounded-md border border-border/60 bg-background/45 px-3 py-2"
          >
            <div className="mb-2 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">
                  {question.header}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {question.question}
                </p>
              </div>
              <StatusPill variant={answerCount > 0 ? "secondary" : "outline"}>
                {answerCount > 0 ? "Ready" : "Answer needed"}
              </StatusPill>
            </div>

            {question.options.length > 0 ? (
              <div className="space-y-2">
                {question.options.map((option) => {
                  const checked = selectedOptions.includes(option.label);
                  return (
                    <label
                      key={option.label}
                      className={cn(
                        "flex cursor-pointer items-start gap-2 rounded-md border border-border/60 px-2.5 py-2 text-sm transition-colors",
                        checked
                          ? "bg-muted/50 text-foreground"
                          : "bg-background/60 text-muted-foreground hover:bg-muted/35",
                      )}
                    >
                      <input
                        type={question.multiSelect ? "checkbox" : "radio"}
                        name={question.id}
                        value={option.label}
                        checked={checked}
                        disabled={disabled}
                        onChange={() => {
                          const nextSelectedOptions = question.multiSelect
                            ? checked
                              ? selectedOptions.filter((value) => value !== option.label)
                              : [...selectedOptions, option.label]
                            : [option.label];
                          onDraftStateChange({
                            ...draftState,
                            customAnswersByQuestionId: {
                              ...draftState.customAnswersByQuestionId,
                              [question.id]: question.multiSelect
                                ? customAnswer
                                : "",
                            },
                            selectedOptionsByQuestionId: {
                              ...draftState.selectedOptionsByQuestionId,
                              [question.id]: nextSelectedOptions,
                            },
                          });
                        }}
                        className="mt-0.5"
                      />
                      <span className="min-w-0 flex-1 space-y-1">
                        <span className="block text-foreground">{option.label}</span>
                        <span className="block text-xs text-muted-foreground">
                          {option.description}
                        </span>
                        <QuestionOptionPreview preview={option.preview} />
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : null}

            {question.allowsOther || question.options.length === 0 ? (
              <div className="mt-2">
                {question.multiSelect || question.options.length === 0 ? (
                  <Textarea
                    value={customAnswer}
                    disabled={disabled}
                    placeholder={
                      question.options.length === 0
                        ? "Type your answer"
                        : "Add another answer"
                    }
                    onChange={(event) => {
                      onDraftStateChange({
                        ...draftState,
                        customAnswersByQuestionId: {
                          ...draftState.customAnswersByQuestionId,
                          [question.id]: event.target.value,
                        },
                        selectedOptionsByQuestionId: {
                          ...draftState.selectedOptionsByQuestionId,
                          [question.id]:
                            question.multiSelect || question.options.length === 0
                              ? selectedOptions
                              : [],
                        },
                      });
                    }}
                    className="min-h-[76px] bg-background/70"
                  />
                ) : (
                  <Input
                    type={textInputType}
                    value={customAnswer}
                    disabled={disabled}
                    placeholder={question.options.length > 0 ? "Other" : "Type your answer"}
                    onChange={(event) => {
                      onDraftStateChange({
                        ...draftState,
                        customAnswersByQuestionId: {
                          ...draftState.customAnswersByQuestionId,
                          [question.id]: event.target.value,
                        },
                        selectedOptionsByQuestionId: {
                          ...draftState.selectedOptionsByQuestionId,
                          [question.id]: [],
                        },
                      });
                    }}
                    className="bg-background/70"
                  />
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
