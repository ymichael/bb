import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ChevronDown,
} from "lucide-react";
import {
  type PendingInteraction,
  type PendingInteractionCommandApprovalDecision,
  type PendingInteractionGrantedPermissionProfile,
  type PendingInteractionPermissionGrantScope,
  type PendingInteractionRequestedPermissionProfile,
  type PendingInteractionUserInputQuestion,
  getPendingInteractionCommandApprovalDecisionKind,
} from "@bb/domain";
import {
  DetailCard,
  DetailRow,
  StatusPill,
} from "@bb/ui-core";
import { useResolveThreadPendingInteraction } from "@/hooks/mutations/thread-interaction-mutations";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

interface ThreadPendingInteractionBannerProps {
  interaction: PendingInteraction;
  threadId: string;
}

interface UserInputDraftState {
  customAnswersByQuestionId: Record<string, string>;
  selectedOptionsByQuestionId: Record<string, string[]>;
}

interface PendingInteractionSectionProps {
  children: ReactNode;
  isExpanded: boolean;
}

interface PendingInteractionActionButtonProps {
  children: ReactNode;
  disabled: boolean;
  onClick: () => void;
  variant: "default" | "outline" | "ghost";
}

type FileChangeDecisionAction = "accept_for_session" | "decline" | "cancel";

interface InteractionQuestionAnswerArgs {
  draftState: UserInputDraftState;
  question: PendingInteractionUserInputQuestion;
}

interface CommandDecisionButtonConfig {
  decision: PendingInteractionCommandApprovalDecision;
  label: string;
  variant: "default" | "outline" | "ghost";
}

interface PermissionDecisionButtonConfig {
  label: string;
  permissions: PendingInteractionGrantedPermissionProfile;
  scope: PendingInteractionPermissionGrantScope;
  variant: "default" | "outline";
}

interface PermissionPathListProps {
  label: string;
  paths: readonly string[];
}

interface QuestionOptionPreviewProps {
  preview: string | null;
}

interface QuestionAnswerFieldProps {
  disabled: boolean;
  draftState: UserInputDraftState;
  interaction: PendingInteraction;
  onDraftStateChange: (nextState: UserInputDraftState) => void;
}

function describeCommandDecision(
  decision: PendingInteractionCommandApprovalDecision,
): CommandDecisionButtonConfig {
  switch (getPendingInteractionCommandApprovalDecisionKind(decision)) {
    case "accept":
      return {
        decision,
        label: "Approve",
        variant: "default",
      };
    case "accept_for_session":
      return {
        decision,
        label: "Approve for session",
        variant: "default",
      };
    case "decline":
      return {
        decision,
        label: "Deny",
        variant: "outline",
      };
    case "cancel":
      return {
        decision,
        label: "Cancel",
        variant: "ghost",
      };
    case "accept_with_exec_policy_amendment":
      return {
        decision,
        label: "Approve with exec policy amendment",
        variant: "default",
      };
    case "apply_network_policy_amendment":
      return {
        decision,
        label: "Approve with network policy amendment",
        variant: "default",
      };
  }
}

function formatInteractionChipLabel(interaction: PendingInteraction): string {
  switch (interaction.payload.kind) {
    case "command_approval":
      return "Command approval";
    case "file_change_approval":
      return "File changes";
    case "permission_request":
      return "Permission request";
    case "user_input_request":
      return "User input";
  }
}

function formatInteractionSummary(interaction: PendingInteraction): string {
  switch (interaction.payload.kind) {
    case "command_approval":
      return interaction.payload.reason ?? interaction.payload.command ?? "Review requested command";
    case "file_change_approval":
      return interaction.payload.reason ?? "Allow file changes for this thread";
    case "permission_request": {
      const requestedPermissionSummary = summarizeRequestedPermissions(
        interaction.payload.permissions,
      );
      if (interaction.payload.reason) {
        return interaction.payload.reason;
      }
      if (requestedPermissionSummary.length > 0) {
        return requestedPermissionSummary.join(" . ");
      }
      return "Review requested permissions";
    }
    case "user_input_request":
      return interaction.payload.questions.length === 1
        ? interaction.payload.questions[0].question
        : `${interaction.payload.questions.length} questions need answers`;
  }
}

function summarizeRequestedPermissions(
  permissions: PendingInteractionRequestedPermissionProfile,
): string[] {
  const summaries: string[] = [];
  if (permissions.network?.enabled === true) {
    summaries.push("Network access");
  }
  if (permissions.fileSystem) {
    if (permissions.fileSystem.read.length > 0) {
      summaries.push(
        permissions.fileSystem.read.length === 1
          ? "Read 1 path"
          : `Read ${permissions.fileSystem.read.length} paths`,
      );
    }
    if (permissions.fileSystem.write.length > 0) {
      summaries.push(
        permissions.fileSystem.write.length === 1
          ? "Write 1 path"
          : `Write ${permissions.fileSystem.write.length} paths`,
      );
    }
  }
  return summaries;
}

function hasExpandableDetails(interaction: PendingInteraction): boolean {
  switch (interaction.payload.kind) {
    case "command_approval":
      return (
        interaction.payload.command !== null ||
        interaction.payload.cwd !== null ||
        interaction.payload.commandActions.length > 0 ||
        interaction.payload.requestedPermissions !== null
      );
    case "file_change_approval":
      return interaction.payload.grantRoot !== null || interaction.payload.reason !== null;
    case "permission_request":
      return (
        interaction.payload.toolName !== null ||
        summarizeRequestedPermissions(interaction.payload.permissions).length > 0
      );
    case "user_input_request":
      return true;
  }
}

function createInitialUserInputDraftState(
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

function buildUserInputResolution(
  draftState: UserInputDraftState,
  interaction: PendingInteraction,
) {
  if (interaction.payload.kind !== "user_input_request") {
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

function describeGrantedPermissions(
  permissions: PendingInteractionRequestedPermissionProfile,
): PendingInteractionGrantedPermissionProfile {
  return {
    network: permissions.network?.enabled === true
      ? { enabled: true }
      : null,
    fileSystem: permissions.fileSystem
      ? {
          read: permissions.fileSystem.read,
          write: permissions.fileSystem.write,
        }
      : null,
  };
}

function buildPermissionDecisionButtons(
  permissions: PendingInteractionRequestedPermissionProfile,
): PermissionDecisionButtonConfig[] {
  const grantedPermissions = describeGrantedPermissions(permissions);
  return [
    {
      label: "Allow for turn",
      permissions: grantedPermissions,
      scope: "turn",
      variant: "default",
    },
    {
      label: "Allow for session",
      permissions: grantedPermissions,
      scope: "session",
      variant: "default",
    },
    {
      label: "Deny",
      permissions: {
        network: null,
        fileSystem: null,
      },
      scope: "turn",
      variant: "outline",
    },
  ];
}

function PendingInteractionSection({
  children,
  isExpanded,
}: PendingInteractionSectionProps) {
  return (
    <div
      className={cn(
        "grid overflow-hidden transition-[grid-template-rows,opacity,margin,padding,border-color] duration-200 ease-out",
        isExpanded
          ? "mt-2 grid-rows-[1fr] border-t border-border/50 pt-2 opacity-100"
          : "grid-rows-[0fr] border-t border-transparent pt-0 opacity-0",
      )}
    >
      <div className="overflow-hidden">{children}</div>
    </div>
  );
}

function PendingInteractionActionButton({
  children,
  disabled,
  onClick,
  variant,
}: PendingInteractionActionButtonProps) {
  return (
    <Button
      type="button"
      size="sm"
      variant={variant}
      disabled={disabled}
      onClick={onClick}
      className="h-7"
    >
      {children}
    </Button>
  );
}

function PermissionPathList({
  label,
  paths,
}: PermissionPathListProps) {
  if (paths.length === 0) {
    return null;
  }

  return (
    <DetailRow
      label={label}
      align="start"
      valueClassName="space-y-1"
    >
      {paths.map((path) => (
        <code
          key={path}
          className="block rounded bg-background/70 px-2 py-1 font-mono text-xs text-foreground"
        >
          {path}
        </code>
      ))}
    </DetailRow>
  );
}

function renderInteractionDetails(interaction: PendingInteraction): ReactNode {
  switch (interaction.payload.kind) {
    case "command_approval":
      return (
        <DetailCard className="bg-background/50">
          {interaction.payload.command ? (
            <DetailRow label="Command" align="start">
              <code className="whitespace-pre-wrap break-all font-mono text-xs text-foreground">
                {interaction.payload.command}
              </code>
            </DetailRow>
          ) : null}
          {interaction.payload.cwd ? (
            <DetailRow label="Working dir" align="start">
              <code className="break-all font-mono text-xs text-foreground">
                {interaction.payload.cwd}
              </code>
            </DetailRow>
          ) : null}
          {interaction.payload.reason ? (
            <DetailRow label="Reason" align="start">
              <span>{interaction.payload.reason}</span>
            </DetailRow>
          ) : null}
          {interaction.payload.requestedPermissions ? (
            <DetailRow label="Permissions" align="start">
              <div className="space-y-1">
                {summarizeRequestedPermissions(
                  interaction.payload.requestedPermissions,
                ).map((summary) => (
                  <div key={summary}>{summary}</div>
                ))}
              </div>
            </DetailRow>
          ) : null}
        </DetailCard>
      );
    case "file_change_approval":
      return (
        <DetailCard className="bg-background/50">
          {interaction.payload.reason ? (
            <DetailRow label="Reason" align="start">
              <span>{interaction.payload.reason}</span>
            </DetailRow>
          ) : null}
          {interaction.payload.grantRoot ? (
            <DetailRow label="Grant root" align="start">
              <code className="break-all font-mono text-xs text-foreground">
                {interaction.payload.grantRoot}
              </code>
            </DetailRow>
          ) : null}
        </DetailCard>
      );
    case "permission_request":
      return (
        <DetailCard className="bg-background/50">
          {interaction.payload.toolName ? (
            <DetailRow label="Tool">
              <span>{interaction.payload.toolName}</span>
            </DetailRow>
          ) : null}
          {interaction.payload.reason ? (
            <DetailRow label="Reason" align="start">
              <span>{interaction.payload.reason}</span>
            </DetailRow>
          ) : null}
          {interaction.payload.permissions.network?.enabled === true ? (
            <DetailRow label="Network">
              <span>Enabled</span>
            </DetailRow>
          ) : null}
          {interaction.payload.permissions.fileSystem ? (
            <>
              <PermissionPathList
                label="Read paths"
                paths={interaction.payload.permissions.fileSystem.read}
              />
              <PermissionPathList
                label="Write paths"
                paths={interaction.payload.permissions.fileSystem.write}
              />
            </>
          ) : null}
        </DetailCard>
      );
    case "user_input_request":
      return null;
  }
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

function QuestionAnswerField({
  disabled,
  draftState,
  interaction,
  onDraftStateChange,
}: QuestionAnswerFieldProps) {
  if (interaction.payload.kind !== "user_input_request") {
    return null;
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

export function ThreadPendingInteractionBanner({
  interaction,
  threadId,
}: ThreadPendingInteractionBannerProps) {
  const resolvePendingInteraction = useResolveThreadPendingInteraction();
  const [isExpanded, setIsExpanded] = useState(
    interaction.payload.kind === "user_input_request",
  );
  const [userInputDraftState, setUserInputDraftState] = useState(
    () => createInitialUserInputDraftState(interaction),
  );

  useEffect(() => {
    setIsExpanded(interaction.payload.kind === "user_input_request");
    setUserInputDraftState(createInitialUserInputDraftState(interaction));
  }, [interaction]);

  const details = useMemo(
    () => renderInteractionDetails(interaction),
    [interaction],
  );
  const canExpand = hasExpandableDetails(interaction) && interaction.payload.kind !== "user_input_request";
  const mutationErrorMessage =
    resolvePendingInteraction.error
      ? getMutationErrorMessage({
          error: resolvePendingInteraction.error,
          fallbackMessage: "Failed to resolve pending interaction.",
        })
      : null;

  const handleCommandDecision = (decision: PendingInteractionCommandApprovalDecision) => {
    void resolvePendingInteraction.mutateAsync({
      threadId,
      interactionId: interaction.id,
      resolution: {
        kind: "command_approval",
        decision,
      },
    });
  };

  const handleFileChangeDecision = (decision: FileChangeDecisionAction) => {
    void resolvePendingInteraction.mutateAsync({
      threadId,
      interactionId: interaction.id,
      resolution: {
        kind: "file_change_approval",
        decision,
      },
    });
  };

  const handlePermissionDecision = (decision: PermissionDecisionButtonConfig) => {
    void resolvePendingInteraction.mutateAsync({
      threadId,
      interactionId: interaction.id,
      resolution: {
        kind: "permission_request",
        permissions: decision.permissions,
        scope: decision.scope,
      },
    });
  };

  const userInputResolution = buildUserInputResolution(
    userInputDraftState,
    interaction,
  );

  return (
    <div className="mb-2 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <StatusPill variant="outline">{formatInteractionChipLabel(interaction)}</StatusPill>
            <span className="truncate text-sm text-foreground">
              {formatInteractionSummary(interaction)}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{interaction.providerId}</span>
            {interaction.payload.kind === "permission_request" && interaction.payload.toolName ? (
              <span>Tool: {interaction.payload.toolName}</span>
            ) : null}
          </div>
        </div>
        {canExpand ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7 text-muted-foreground"
            onClick={() => {
              setIsExpanded((current) => !current);
            }}
            aria-label={isExpanded ? "Hide interaction details" : "Show interaction details"}
          >
            <ChevronDown
              className={cn(
                "size-3.5 transition-transform duration-200",
                isExpanded && "rotate-180",
              )}
            />
          </Button>
        ) : null}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {interaction.payload.kind === "command_approval"
          ? interaction.payload.availableDecisions.map((decision) => {
              const button = describeCommandDecision(decision);
              return (
                <PendingInteractionActionButton
                  key={button.label}
                  variant={button.variant}
                  disabled={resolvePendingInteraction.isPending}
                  onClick={() => {
                    handleCommandDecision(button.decision);
                  }}
                >
                  {button.label}
                </PendingInteractionActionButton>
              );
            })
          : null}
        {interaction.payload.kind === "file_change_approval" ? (
          <>
            <PendingInteractionActionButton
              variant="default"
              disabled={resolvePendingInteraction.isPending}
              onClick={() => {
                handleFileChangeDecision("accept_for_session");
              }}
            >
              Approve for session
            </PendingInteractionActionButton>
            <PendingInteractionActionButton
              variant="outline"
              disabled={resolvePendingInteraction.isPending}
              onClick={() => {
                handleFileChangeDecision("decline");
              }}
            >
              Deny
            </PendingInteractionActionButton>
            <PendingInteractionActionButton
              variant="ghost"
              disabled={resolvePendingInteraction.isPending}
              onClick={() => {
                handleFileChangeDecision("cancel");
              }}
            >
              Cancel
            </PendingInteractionActionButton>
          </>
        ) : null}
        {interaction.payload.kind === "permission_request"
          ? buildPermissionDecisionButtons(interaction.payload.permissions).map((decision) => (
              <PendingInteractionActionButton
                key={decision.label}
                variant={decision.variant}
                disabled={resolvePendingInteraction.isPending}
                onClick={() => {
                  handlePermissionDecision(decision);
                }}
              >
                {decision.label}
              </PendingInteractionActionButton>
            ))
          : null}
      </div>

      {interaction.payload.kind === "user_input_request" ? (
        <PendingInteractionSection isExpanded={true}>
          <QuestionAnswerField
            interaction={interaction}
            draftState={userInputDraftState}
            disabled={resolvePendingInteraction.isPending}
            onDraftStateChange={setUserInputDraftState}
          />
          <div className="mt-3 flex items-center gap-2">
            <PendingInteractionActionButton
              variant="default"
              disabled={resolvePendingInteraction.isPending || userInputResolution === null}
              onClick={() => {
                if (!userInputResolution) {
                  return;
                }

                void resolvePendingInteraction.mutateAsync({
                  threadId,
                  interactionId: interaction.id,
                  resolution: userInputResolution,
                });
              }}
            >
              Send answers
            </PendingInteractionActionButton>
          </div>
        </PendingInteractionSection>
      ) : details ? (
        <PendingInteractionSection isExpanded={isExpanded}>
          {details}
        </PendingInteractionSection>
      ) : null}

      {mutationErrorMessage ? (
        <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/[0.06] px-2 py-1 text-xs text-destructive">
          {mutationErrorMessage}
        </div>
      ) : null}
    </div>
  );
}
