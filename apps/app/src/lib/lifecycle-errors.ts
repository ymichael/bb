import { assertNever } from "@bb/core-ui";
import { BbHttpError } from "@bb/sdk/browser";
import {
  lifecycleApiErrorSchema,
  type LifecycleApiError,
} from "@bb/server-contract";
import { HttpError } from "./api";

type LifecycleErrorSeverity = "info" | "warning" | "error";
export type LifecycleErrorOperation =
  | "archive_thread"
  | "commit"
  | "create_thread"
  | "edit_message"
  | "load_diff"
  | "load_git_status"
  | "load_thread_storage"
  | "open_terminal"
  | "queue_message"
  | "reorder_queued_message"
  | "resolve_interaction"
  | "send_message"
  | "send_queued_message"
  | "set_queued_message_group_boundary"
  | "stop_thread"
  | "update_queued_message"
  | "update_merge_base";

export interface LifecycleErrorDescription {
  body: string;
  severity: LifecycleErrorSeverity;
  title: string;
}

interface DescribeLifecycleErrorOptions {
  error: unknown;
  operation?: LifecycleErrorOperation | undefined;
}

interface LifecycleDescriptionArgs {
  body: string;
  operation?: LifecycleErrorOperation | undefined;
  severity: LifecycleErrorSeverity;
  title: string;
}

interface LifecycleDescriptionWithoutSeverityArgs {
  body: string;
  operation?: LifecycleErrorOperation | undefined;
  title: string;
}

interface EnvironmentNotReadyDescriptionArgs {
  error: Extract<LifecycleApiError, { code: "environment_not_ready" }>;
  operation?: LifecycleErrorOperation | undefined;
}

interface ThreadEnvironmentUnavailableDescriptionArgs {
  error: Extract<LifecycleApiError, { code: "thread_environment_unavailable" }>;
  operation?: LifecycleErrorOperation | undefined;
}

interface ThreadNotWritableDescriptionArgs {
  error: Extract<LifecycleApiError, { code: "thread_not_writable" }>;
  operation?: LifecycleErrorOperation | undefined;
}

interface HostUnavailableDescriptionArgs {
  error: Extract<LifecycleApiError, { code: "host_unavailable" }>;
  operation?: LifecycleErrorOperation | undefined;
}

interface ProjectUnavailableDescriptionArgs {
  error: Extract<LifecycleApiError, { code: "project_unavailable" }>;
  operation?: LifecycleErrorOperation | undefined;
}

interface ParentThreadInvalidDescriptionArgs {
  error: Extract<LifecycleApiError, { code: "parent_thread_invalid" }>;
  operation?: LifecycleErrorOperation | undefined;
}

interface DispatchRejectedDescriptionArgs {
  error: Extract<LifecycleApiError, { code: "dispatch_rejected" }>;
  operation?: LifecycleErrorOperation | undefined;
}

interface DispatchHookFailedDescriptionArgs {
  error: Extract<LifecycleApiError, { code: "dispatch_hook_failed" }>;
  operation?: LifecycleErrorOperation | undefined;
}

function operationTitle(operation: LifecycleErrorOperation): string {
  switch (operation) {
    case "archive_thread":
      return "Failed to archive thread";
    case "commit":
      return "Commit failed";
    case "create_thread":
      return "Failed to create thread";
    case "edit_message":
      return "Failed to edit message";
    case "load_diff":
      return "Failed to load diff";
    case "load_git_status":
      return "Workspace status unavailable";
    case "load_thread_storage":
      return "Failed to load thread storage";
    case "open_terminal":
      return "Failed to open terminal";
    case "queue_message":
      return "Failed to queue message";
    case "reorder_queued_message":
      return "Failed to reorder queued message";
    case "resolve_interaction":
      return "Failed to submit response";
    case "send_message":
      return "Failed to send message";
    case "send_queued_message":
      return "Failed to send queued message";
    case "set_queued_message_group_boundary":
      return "Failed to group queued messages";
    case "stop_thread":
      return "Failed to stop thread";
    case "update_queued_message":
      return "Failed to update queued message";
    case "update_merge_base":
      return "Failed to update merge base";
    default:
      return assertNever(operation);
  }
}

function lifecycleDescription({
  body,
  operation,
  severity,
  title,
}: LifecycleDescriptionArgs): LifecycleErrorDescription {
  return {
    title: operation ? operationTitle(operation) : title,
    body,
    severity,
  };
}

function info({
  body,
  operation,
  title,
}: LifecycleDescriptionWithoutSeverityArgs): LifecycleErrorDescription {
  return lifecycleDescription({ title, body, operation, severity: "info" });
}

function warning({
  body,
  operation,
  title,
}: LifecycleDescriptionWithoutSeverityArgs): LifecycleErrorDescription {
  return lifecycleDescription({ title, body, operation, severity: "warning" });
}

function errorDescription({
  body,
  operation,
  title,
}: LifecycleDescriptionWithoutSeverityArgs): LifecycleErrorDescription {
  return lifecycleDescription({ title, body, operation, severity: "error" });
}

function describeEnvironmentNotReady({
  error,
  operation,
}: EnvironmentNotReadyDescriptionArgs): LifecycleErrorDescription {
  const { details } = error;
  switch (details.environmentStatus) {
    case "provisioning":
      return info({
        operation,
        title: "Workspace starting",
        body: "Workspace is still starting.",
      });
    case "ready":
      return warning({
        operation,
        title: "Workspace unavailable",
        body: "Workspace is unavailable.",
      });
    case "error":
      return errorDescription({
        operation,
        title: "Workspace setup failed",
        body: "Workspace setup failed.",
      });
    case "retiring":
    case "destroying":
      return info({
        operation,
        title: "Workspace cleaning up",
        body: "Workspace is being cleaned up.",
      });
    case "destroyed":
      return warning({
        operation,
        title: "Workspace unavailable",
        body: "Workspace no longer exists.",
      });
    default:
      return assertNever(details.environmentStatus);
  }
}

function describeThreadEnvironmentUnavailable({
  error,
  operation,
}: ThreadEnvironmentUnavailableDescriptionArgs): LifecycleErrorDescription {
  const { details } = error;
  switch (details.reason) {
    case "never_attached":
      return info({
        operation,
        title: "Workspace unavailable",
        body: "Workspace is not available yet.",
      });
    case "destroyed":
      return warning({
        operation,
        title: "Workspace unavailable",
        body: "Workspace no longer exists.",
      });
    case "destroying":
      return info({
        operation,
        title: "Workspace cleaning up",
        body: "Workspace is being cleaned up.",
      });
    case "provisioning":
      return info({
        operation,
        title: "Workspace starting",
        body: "Workspace is still starting.",
      });
    case "errored":
      return errorDescription({
        operation,
        title: "Workspace setup failed",
        body: "Workspace setup failed.",
      });
    default:
      return assertNever(details.reason);
  }
}

function describeThreadNotWritable({
  error,
  operation,
}: ThreadNotWritableDescriptionArgs): LifecycleErrorDescription {
  const { details } = error;
  switch (details.reason) {
    case "archived":
      return info({
        operation,
        title: "Thread archived",
        body: "Unarchive the thread first.",
      });
    case "stopping":
      return warning({
        operation,
        title: "Thread stopping",
        body: "The thread is stopping.",
      });
    case "deleted":
      return errorDescription({
        operation,
        title: "Thread deleted",
        body: "This thread was deleted.",
      });
    case "not_started":
      return info({
        operation,
        title: "Thread starting",
        body: "The thread is still starting.",
      });
    case "not_active":
      return warning({
        operation,
        title: "Thread not running",
        body: "The thread is not running.",
      });
    case "errored":
      return errorDescription({
        operation,
        title: "Thread failed",
        body: "This thread failed and cannot continue.",
      });
    case "already_active":
      return warning({
        operation,
        title: "Thread already running",
        body: "The thread is already running.",
      });
    case "still_starting":
      return info({
        operation,
        title: "Thread starting",
        body: "The thread is still starting.",
      });
    default:
      return assertNever(details.reason);
  }
}

function describeHostUnavailable({
  error,
  operation,
}: HostUnavailableDescriptionArgs): LifecycleErrorDescription {
  const { details } = error;
  switch (details.reason) {
    case "suspended":
      return warning({
        operation,
        title: "Host paused",
        body: "Host is paused.",
      });
    case "disconnected":
      return warning({
        operation,
        title: "Host offline",
        body: "Host is offline.",
      });
    case "destroyed":
      return errorDescription({
        operation,
        title: "Host removed",
        body: "Host was removed.",
      });
    default:
      return assertNever(details.reason);
  }
}

function describeProjectUnavailable({
  error,
  operation,
}: ProjectUnavailableDescriptionArgs): LifecycleErrorDescription {
  switch (error.details.reason) {
    case "pending_deletion":
      return info({
        operation,
        title: "Project deletion in progress",
        body: "This project is being deleted.",
      });
    case "deleted":
      return errorDescription({
        operation,
        title: "Project deleted",
        body: "This project was deleted.",
      });
    default:
      return assertNever(error.details.reason);
  }
}

function describeParentThreadInvalid({
  error,
  operation,
}: ParentThreadInvalidDescriptionArgs): LifecycleErrorDescription {
  const isSenderThread = error.details.subject === "sender";
  const title = isSenderThread
    ? "Sender thread unavailable"
    : "Parent thread unavailable";

  switch (error.details.reason) {
    case "not_found":
      return errorDescription({
        operation,
        title,
        body: isSenderThread
          ? "The sender thread no longer exists."
          : "That parent thread no longer exists.",
      });
    case "archived":
      return warning({
        operation,
        title,
        body: isSenderThread
          ? "The sender thread is archived."
          : "Unarchive the parent thread first or choose another parent.",
      });
    case "deleted":
      return errorDescription({
        operation,
        title,
        body: isSenderThread
          ? "The sender thread was deleted."
          : "That parent thread was deleted.",
      });
    case "self":
      return errorDescription({
        operation,
        title,
        body: "A thread cannot be its own parent.",
      });
    case "cycle":
      return errorDescription({
        operation,
        title,
        body: "Choose a thread that is not a child of this thread.",
      });
    case "too_deep":
      return errorDescription({
        operation,
        title,
        body: "Thread nesting is limited to 4 levels.",
      });
    default:
      return assertNever(error.details.reason);
  }
}

function describeDispatchRejected({
  error,
  operation,
}: DispatchRejectedDescriptionArgs): LifecycleErrorDescription {
  return warning({
    operation,
    title: "Blocked by a plugin",
    body: `Blocked by the "${error.details.pluginId}" plugin: ${error.message}`,
  });
}

function describeDispatchHookFailed({
  error,
  operation,
}: DispatchHookFailedDescriptionArgs): LifecycleErrorDescription {
  const reason = error.message.trim();
  const sentence = reason.endsWith(".") ? reason : `${reason}.`;
  return errorDescription({
    operation,
    title: "Plugin dispatch hook failed",
    body: `${sentence} Disable that plugin to continue.`,
  });
}

export function parseLifecycleError(error: unknown): LifecycleApiError | null {
  if (!(error instanceof HttpError) && !(error instanceof BbHttpError)) {
    return null;
  }

  const result = lifecycleApiErrorSchema.safeParse(error.body);
  return result.success ? result.data : null;
}

export function formatLifecycleErrorDescription(
  description: LifecycleErrorDescription,
): string {
  return `${description.title}. ${description.body}`;
}

export function describeLifecycleError({
  error,
  operation,
}: DescribeLifecycleErrorOptions): LifecycleErrorDescription | null {
  const lifecycleError = parseLifecycleError(error);
  if (!lifecycleError) {
    return null;
  }

  switch (lifecycleError.code) {
    case "environment_not_ready":
      return describeEnvironmentNotReady({
        error: lifecycleError,
        operation,
      });
    case "thread_environment_unavailable":
      return describeThreadEnvironmentUnavailable({
        error: lifecycleError,
        operation,
      });
    case "thread_not_writable":
      return describeThreadNotWritable({ error: lifecycleError, operation });
    case "host_unavailable":
      return describeHostUnavailable({ error: lifecycleError, operation });
    case "project_unavailable":
      return describeProjectUnavailable({
        error: lifecycleError,
        operation,
      });
    case "parent_thread_invalid":
      return describeParentThreadInvalid({
        error: lifecycleError,
        operation,
      });
    case "dispatch_rejected":
      return describeDispatchRejected({ error: lifecycleError, operation });
    case "dispatch_hook_failed":
      return describeDispatchHookFailed({ error: lifecycleError, operation });
    default:
      return assertNever(lifecycleError);
  }
}
