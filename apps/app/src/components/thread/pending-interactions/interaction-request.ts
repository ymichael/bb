import {
  isExtensionKind,
  parseExtensionKind,
  type ApprovalPendingInteractionPayload,
  type ExtensionKind,
  type JsonValue,
  type PendingInteraction,
  type PendingInteractionApprovalSubject,
  type PendingInteractionUserQuestionQuestion,
} from "@bb/domain";

export type InteractionRequestView =
  | {
      family: "approval";
      payload: ApprovalPendingInteractionPayload;
      subject: Exclude<PendingInteractionApprovalSubject, { kind: "plan" }>;
    }
  | {
      family: "request";
      kind: "user_question";
      questions: readonly PendingInteractionUserQuestionQuestion[];
    }
  | {
      family: "request";
      kind: "plan_review";
      review: Extract<PendingInteractionApprovalSubject, { kind: "plan" }>;
      approval: ApprovalPendingInteractionPayload;
    }
  | {
      family: "request";
      kind: ExtensionKind;
      pluginId: string;
      name: string;
      title: string;
      data: JsonValue;
    };

interface RequestBearingInteraction {
  payload: PendingInteraction["payload"];
  origin?: PendingInteraction["origin"];
}

export function classifyInteractionRequest(
  interaction: RequestBearingInteraction,
): InteractionRequestView {
  const { payload } = interaction;
  switch (payload.kind) {
    case "user_question":
      return {
        family: "request",
        kind: "user_question",
        questions: payload.questions,
      };
    case "plugin": {
      const origin = interaction.origin;
      if (origin === undefined || origin.kind !== "plugin") {
        throw new Error("a plugin pending interaction carries a plugin origin");
      }
      return {
        family: "request",
        kind: `${origin.pluginId}/${origin.rendererId}`,
        pluginId: origin.pluginId,
        name: origin.rendererId,
        title: payload.title,
        data: payload.data,
      };
    }
    case "approval": {
      const { subject } = payload;
      if (subject.kind === "plan") {
        return {
          family: "request",
          kind: "plan_review",
          review: subject,
          approval: payload,
        };
      }
      return { family: "approval", payload, subject };
    }
    default: {
      if (isExtensionKind(payload.kind)) {
        const { pluginId, name } = parseExtensionKind(payload.kind);
        return {
          family: "request",
          kind: payload.kind,
          pluginId,
          name,
          title: payload.title,
          data: payload.data,
        };
      }
      throw new Error(
        `unknown interaction payload kind ${JSON.stringify(payload.kind)}`,
      );
    }
  }
}
