import {
  createProviderVisibilityMetadata,
  getRecordProperty,
  getStringProperty,
  isRecord,
  type JsonRpcMessage,
  type ProviderRawEventCoverage,
  type ProviderRawEventDescription,
  type ProviderVisibilityMetadata,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { ServerNotification } from "./generated/codex-app-server/schema/ServerNotification.js";

type CodexServerNotificationMethod = ServerNotification["method"];

interface CodexNotificationRawEvent {
  kind: "notification";
  method: CodexServerNotificationMethod;
  params: JsonRpcMessage["params"];
}

interface CodexMcpStartupStatusRawEvent {
  kind: "mcp-startup-status";
}

interface CodexRemoteControlStatusRawEvent {
  kind: "remote-control-status";
}

interface CodexThreadSettingsUpdatedRawEvent {
  kind: "thread-settings-updated";
}

interface CodexUnknownRawEvent {
  kind: "unknown";
  method: string;
}

type CodexRawEvent =
  | CodexNotificationRawEvent
  | CodexMcpStartupStatusRawEvent
  | CodexRemoteControlStatusRawEvent
  | CodexThreadSettingsUpdatedRawEvent
  | CodexUnknownRawEvent;

const CODEX_SERVER_NOTIFICATION_METHODS = {
  "account/login/completed": true,
  "account/rateLimits/updated": true,
  "account/updated": true,
  "app/list/updated": true,
  "autoApprovalReview/strictReviewRequired": true,
  "command/exec/outputDelta": true,
  configWarning: true,
  deprecationNotice: true,
  error: true,
  "externalAgentConfig/import/completed": true,
  "externalAgentConfig/import/progress": true,
  "fs/changed": true,
  "fuzzyFileSearch/sessionCompleted": true,
  "fuzzyFileSearch/sessionUpdated": true,
  guardianWarning: true,
  "hook/completed": true,
  "hook/started": true,
  "item/agentMessage/delta": true,
  "item/autoApprovalReview/completed": true,
  "item/autoApprovalReview/started": true,
  "item/commandExecution/outputDelta": true,
  "item/commandExecution/terminalInteraction": true,
  "item/completed": true,
  "item/fileChange/patchUpdated": true,
  "item/fileChange/outputDelta": true,
  "item/mcpToolCall/progress": true,
  "item/plan/delta": true,
  "item/reasoning/summaryPartAdded": true,
  "item/reasoning/summaryTextDelta": true,
  "item/reasoning/textDelta": true,
  "item/started": true,
  "mcpServer/oauthLogin/completed": true,
  "mcpServer/startupStatus/updated": true,
  "model/verification": true,
  "model/rerouted": true,
  "model/safetyBuffering/updated": true,
  "process/exited": true,
  "process/outputDelta": true,
  "project/changed": true,
  "rawResponse/completed": true,
  "rawResponseItem/completed": true,
  "remoteControl/status/changed": true,
  "serverRequest/resolved": true,
  "skills/changed": true,
  "thread/archived": true,
  "thread/closed": true,
  "thread/compacted": true,
  "thread/deleted": true,
  "thread/environment/connected": true,
  "thread/environment/disconnected": true,
  "thread/goal/cleared": true,
  "thread/goal/updated": true,
  "thread/name/updated": true,
  "thread/project/updated": true,
  "thread/queue/changed": true,
  "thread/settings/updated": true,
  "thread/realtime/closed": true,
  "thread/realtime/error": true,
  "thread/realtime/itemAdded": true,
  "thread/realtime/outputAudio/delta": true,
  "thread/realtime/sdp": true,
  "thread/realtime/started": true,
  "thread/realtime/transcript/delta": true,
  "thread/realtime/transcript/done": true,
  "thread/reverted": true,
  "thread/started": true,
  "thread/status/changed": true,
  "thread/tokenUsage/updated": true,
  "thread/unarchived": true,
  "turn/completed": true,
  "turn/diff/updated": true,
  "turn/moderationMetadata": true,
  "turn/plan/updated": true,
  "turn/started": true,
  warning: true,
  "windows/worldWritableWarning": true,
  "windowsSandbox/setupCompleted": true,
} satisfies Record<CodexServerNotificationMethod, true>;

const CODEX_NOTIFICATION_COVERAGE = {
  "account/login/completed": "unknown",
  "account/rateLimits/updated": "normalized",
  "account/updated": "unknown",
  "app/list/updated": "unknown",
  "autoApprovalReview/strictReviewRequired": "unknown",
  "command/exec/outputDelta": "unknown",
  configWarning: "normalized",
  deprecationNotice: "normalized",
  error: "normalized",
  "externalAgentConfig/import/completed": "unknown",
  "externalAgentConfig/import/progress": "unknown",
  "fs/changed": "unknown",
  "fuzzyFileSearch/sessionCompleted": "unknown",
  "fuzzyFileSearch/sessionUpdated": "unknown",
  guardianWarning: "unknown",
  "hook/completed": "unknown",
  "hook/started": "unknown",
  "item/agentMessage/delta": "normalized",
  "item/autoApprovalReview/completed": "noise",
  "item/autoApprovalReview/started": "noise",
  "item/commandExecution/outputDelta": "normalized",
  "item/commandExecution/terminalInteraction": "unknown",
  "item/completed": "normalized",
  "item/fileChange/patchUpdated": "unknown",
  "item/fileChange/outputDelta": "normalized",
  "item/mcpToolCall/progress": "normalized",
  "item/plan/delta": "normalized",
  "item/reasoning/summaryPartAdded": "unknown",
  "item/reasoning/summaryTextDelta": "normalized",
  "item/reasoning/textDelta": "normalized",
  "item/started": "normalized",
  "mcpServer/oauthLogin/completed": "unknown",
  "mcpServer/startupStatus/updated": "noise",
  "model/verification": "unknown",
  "model/rerouted": "unknown",
  "model/safetyBuffering/updated": "unknown",
  "process/exited": "unknown",
  "process/outputDelta": "unknown",
  "project/changed": "unknown",
  "rawResponse/completed": "noise",
  "rawResponseItem/completed": "noise",
  "remoteControl/status/changed": "noise",
  "serverRequest/resolved": "noise",
  "skills/changed": "noise",
  "thread/archived": "noise",
  "thread/closed": "unknown",
  "thread/compacted": "normalized",
  "thread/deleted": "unknown",
  "thread/environment/connected": "unknown",
  "thread/environment/disconnected": "unknown",
  "thread/goal/cleared": "normalized",
  "thread/goal/updated": "normalized",
  "thread/name/updated": "normalized",
  "thread/project/updated": "unknown",
  "thread/queue/changed": "unknown",
  "thread/settings/updated": "noise",
  "thread/realtime/closed": "unknown",
  "thread/realtime/error": "unknown",
  "thread/realtime/itemAdded": "unknown",
  "thread/realtime/outputAudio/delta": "unknown",
  "thread/realtime/sdp": "unknown",
  "thread/realtime/started": "unknown",
  "thread/realtime/transcript/delta": "unknown",
  "thread/realtime/transcript/done": "unknown",
  "thread/reverted": "unknown",
  "thread/started": "normalized",
  "thread/status/changed": "noise",
  "thread/tokenUsage/updated": "normalized",
  "thread/unarchived": "noise",
  "turn/completed": "normalized",
  "turn/diff/updated": "normalized",
  "turn/moderationMetadata": "noise",
  "turn/plan/updated": "normalized",
  "turn/started": "normalized",
  warning: "unknown",
  "windows/worldWritableWarning": "unknown",
  "windowsSandbox/setupCompleted": "unknown",
} satisfies Record<CodexServerNotificationMethod, ProviderRawEventCoverage>;

function assertNever(value: never): never {
  throw new Error(`Unhandled Codex visibility value: ${String(value)}`);
}

function isCodexServerNotificationMethod(
  method: string,
): method is CodexServerNotificationMethod {
  return method in CODEX_SERVER_NOTIFICATION_METHODS;
}

function parseCodexRawEvent(event: JsonRpcMessage): CodexRawEvent {
  if (event.method === "mcpServer/startupStatus/updated") {
    return {
      kind: "mcp-startup-status",
    };
  }

  if (event.method === "remoteControl/status/changed") {
    return {
      kind: "remote-control-status",
    };
  }

  if (event.method === "thread/settings/updated") {
    return {
      kind: "thread-settings-updated",
    };
  }

  if (isCodexServerNotificationMethod(event.method)) {
    return {
      kind: "notification",
      method: event.method,
      params: event.params,
    };
  }

  return {
    kind: "unknown",
    method: event.method,
  };
}

function describeParsedCodexRawEvent(
  event: CodexRawEvent,
): ProviderRawEventDescription {
  switch (event.kind) {
    case "mcp-startup-status":
      return { kind: "mcpServer/startupStatus/updated", coverage: "noise" };

    case "remote-control-status":
      return { kind: "remoteControl/status/changed", coverage: "noise" };

    case "thread-settings-updated":
      return { kind: "thread/settings/updated", coverage: "noise" };

    case "notification":
      if (
        (event.method === "item/started" ||
          event.method === "item/completed") &&
        isCodexUserMessageItemEvent(event)
      ) {
        return { kind: event.method, coverage: "noise" };
      }
      if (event.method === "item/commandExecution/terminalInteraction") {
        if (isRecord(event.params)) {
          const stdin = getStringProperty(event.params, "stdin");
          if (stdin !== undefined && stdin.length === 0) {
            return { kind: event.method, coverage: "noise" };
          }
        }
        return { kind: event.method, coverage: "unknown" };
      }
      return {
        kind: event.method,
        coverage: CODEX_NOTIFICATION_COVERAGE[event.method],
      };

    case "unknown":
      return { kind: event.method, coverage: "unknown" };

    default:
      return assertNever(event);
  }
}

function isCodexUserMessageItemEvent(
  event: CodexNotificationRawEvent,
): boolean {
  if (!isRecord(event.params)) {
    return false;
  }
  const item = getRecordProperty(event.params, "item");
  return item ? getStringProperty(item, "type") === "userMessage" : false;
}

export const codexVisibilityMetadata: ProviderVisibilityMetadata<CodexRawEvent> =
  createProviderVisibilityMetadata({
    parseRawEvent: parseCodexRawEvent,
    describeParsedRawEvent: describeParsedCodexRawEvent,
  });
