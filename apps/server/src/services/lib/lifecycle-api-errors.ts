import type { Environment, Host, Thread, ThreadStatus } from "@bb/domain";
import type {
  EnvironmentNotReadyErrorDetails,
  HostUnavailableErrorDetails,
  ParentThreadInvalidErrorDetails,
  ParentThreadInvalidReason,
  ParentThreadInvalidSubject,
  ProjectUnavailableErrorDetails,
  ThreadEnvironmentUnavailableErrorDetails,
  ThreadNotWritableErrorDetails,
  ThreadNotWritableReason,
} from "@bb/server-contract";
import { ApiError } from "../../errors.js";

type EnvironmentReadinessFields = Pick<Environment, "path" | "status">;

type ThreadEnvironmentStatusFields = Pick<Environment, "status">;

type ThreadWritableFields = Pick<Thread, "archivedAt" | "deletedAt" | "status">;

type HostUnavailableStatus = 404 | 502;

interface ParentThreadInvalidDetailsArgs {
  reason: ParentThreadInvalidReason;
  subject: ParentThreadInvalidSubject;
}

function environmentNotReadyDetails(
  environment: EnvironmentReadinessFields,
): EnvironmentNotReadyErrorDetails {
  return {
    environmentStatus: environment.status,
    hasPath: environment.path !== null && environment.path.length > 0,
  };
}

export function throwEnvironmentNotReady(
  environment: EnvironmentReadinessFields,
): never {
  throw new ApiError(409, "environment_not_ready", "Environment unavailable", {
    details: environmentNotReadyDetails(environment),
  });
}

export function threadEnvironmentUnavailableDetails(
  reason: ThreadEnvironmentUnavailableErrorDetails["reason"],
  environmentStatus: ThreadEnvironmentUnavailableErrorDetails["environmentStatus"],
): ThreadEnvironmentUnavailableErrorDetails {
  return { reason, environmentStatus };
}

export function destroyedThreadEnvironmentDetails(
  environment: ThreadEnvironmentStatusFields,
): ThreadEnvironmentUnavailableErrorDetails | null {
  if (environment.status !== "destroyed") {
    return null;
  }
  return threadEnvironmentUnavailableDetails("destroyed", environment.status);
}

export function goneThreadEnvironmentDetails(
  environment: ThreadEnvironmentStatusFields,
): ThreadEnvironmentUnavailableErrorDetails | null {
  if (
    environment.status !== "destroying" &&
    environment.status !== "destroyed"
  ) {
    return null;
  }
  return threadEnvironmentUnavailableDetails(
    environment.status,
    environment.status,
  );
}

export function throwThreadEnvironmentUnavailable(
  details: ThreadEnvironmentUnavailableErrorDetails,
): never {
  throw new ApiError(
    409,
    "thread_environment_unavailable",
    "Thread environment is unavailable",
    { details },
  );
}

function threadNotWritableDetails(
  thread: ThreadWritableFields,
  reason: ThreadNotWritableReason,
): ThreadNotWritableErrorDetails {
  return {
    reason,
    archivedAt: thread.archivedAt,
    threadStatus: thread.status,
  };
}

export function threadNotWritableReasonForStatus(
  status: ThreadStatus,
): ThreadNotWritableReason {
  switch (status) {
    // A pending thread has never dispatched, so "not started" is literally
    // what it is. It reuses `starting`'s reason rather than earning its own:
    // the caller's remedy is identical (wait for the first dispatch to clear),
    // and a distinct reason would only be worth its fan-out once a surface
    // renders pending differently.
    case "pending":
    case "starting":
      return "not_started";
    case "idle":
      return "not_active";
    case "active":
      return "already_active";
    case "stopping":
      return "stopping";
    case "error":
      return "errored";
  }
}

export function throwThreadNotWritable(
  thread: ThreadWritableFields,
  reason: ThreadNotWritableReason,
  message: string,
): never {
  throw new ApiError(409, "thread_not_writable", message, {
    details: threadNotWritableDetails(thread, reason),
  });
}

export function disconnectedHostUnavailableDetails(
  hostStatus: Host["status"] = "disconnected",
): HostUnavailableErrorDetails {
  return {
    reason: "disconnected",
    hostStatus,
    suspendedAt: null,
    destroyedAt: null,
  };
}

export function destroyedHostUnavailableDetails(
  destroyedAt: number,
): HostUnavailableErrorDetails {
  return {
    reason: "destroyed",
    hostStatus: null,
    suspendedAt: null,
    destroyedAt,
  };
}

export function throwHostUnavailable(
  status: HostUnavailableStatus,
  message: string,
  details: HostUnavailableErrorDetails,
): never {
  throw new ApiError(status, "host_unavailable", message, {
    details,
  });
}

export function throwProjectUnavailable(
  details: ProjectUnavailableErrorDetails,
): never {
  throw new ApiError(404, "project_unavailable", "Project is unavailable", {
    details,
  });
}

export function throwParentThreadInvalid(
  reason: ParentThreadInvalidReason,
): never {
  throw new ApiError(400, "parent_thread_invalid", "Parent thread is invalid", {
    details: parentThreadInvalidDetails({ reason, subject: "parent" }),
  });
}

export function throwSenderThreadInvalid(
  reason: Extract<ParentThreadInvalidReason, "deleted" | "not_found">,
): never {
  throw new ApiError(400, "parent_thread_invalid", "Sender thread is invalid", {
    details: parentThreadInvalidDetails({ reason, subject: "sender" }),
  });
}

function parentThreadInvalidDetails({
  reason,
  subject,
}: ParentThreadInvalidDetailsArgs): ParentThreadInvalidErrorDetails {
  return { reason, subject };
}
