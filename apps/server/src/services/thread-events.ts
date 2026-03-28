import { eq, max, sql } from "drizzle-orm";
import {
  createEventId,
  events,
} from "@bb/db";
import type {
  PromptInput,
  ThreadEventType,
  ResolvedThreadExecutionOptions,
  ThreadTurnInitiator,
} from "@bb/domain";
import { turnRequestEventDataSchema } from "@bb/domain";
import type { AppDeps } from "../types.js";

export interface AppendThreadEventArgs {
  data: Record<string, unknown>;
  environmentId?: string | null;
  providerThreadId?: string | null;
  threadId: string;
  turnId?: string | null;
  type: ThreadEventType;
}

export interface ClientTurnEventArgs {
  environmentId: string | null;
  execution: ResolvedThreadExecutionOptions;
  initiator: ThreadTurnInitiator;
  input: PromptInput[];
  requestMethod: "thread/start" | "turn/start";
  source: "spawn" | "tell";
  threadId: string;
  type: "client/thread/start" | "client/turn/requested" | "client/turn/start";
}

export function appendThreadEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: AppendThreadEventArgs,
): number {
  const now = Date.now();
  const nextSequence = deps.db.transaction(
    (tx) => {
      const maxRow = tx
        .select({ maxSeq: max(events.sequence) })
        .from(events)
        .where(eq(events.threadId, args.threadId))
        .get();
      const sequence = (maxRow?.maxSeq ?? 0) + 1;

      tx.run(
        sql`INSERT INTO events
          (id, thread_id, environment_id, turn_id, provider_thread_id, sequence, type, data, created_at)
          VALUES (
            ${createEventId()},
            ${args.threadId},
            ${args.environmentId ?? null},
            ${args.turnId ?? null},
            ${args.providerThreadId ?? null},
            ${sequence},
            ${args.type},
            ${JSON.stringify(args.data)},
            ${now}
          )`,
      );

      return sequence;
    },
    { behavior: "immediate" },
  );

  deps.hub.notifyThread(args.threadId, ["events-appended"]);
  return nextSequence;
}

export function appendClientTurnEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: ClientTurnEventArgs,
): number {
  return appendThreadEvent(deps, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    type: args.type,
    data: {
      direction: "outbound",
      source: args.source,
      initiator: args.initiator,
      input: args.input,
      request: {
        method: args.requestMethod,
        params: {},
      },
      execution: args.execution,
    },
  });
}

export function appendProvisioningEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    entries: Array<Record<string, unknown>>;
    environmentId: string;
    status: "completed" | "failed" | "in_progress" | "started";
    threadId: string;
  },
): number {
  return appendThreadEvent(deps, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    type: "system/provisioning",
    data: {
      status: args.status,
      environmentId: args.environmentId,
      entries: args.entries,
    },
  });
}

export function appendSystemErrorEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    code: string;
    detail?: string;
    environmentId?: string | null;
    message: string;
    threadId: string;
  },
): number {
  return appendThreadEvent(deps, {
    threadId: args.threadId,
    environmentId: args.environmentId ?? null,
    type: "system/error",
    data: {
      code: args.code,
      message: args.message,
      ...(args.detail ? { detail: args.detail } : {}),
    },
  });
}

export function appendThreadInterruptedEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    message?: string;
    threadId: string;
  },
): number {
  return appendThreadEvent(deps, {
    threadId: args.threadId,
    type: "system/thread/interrupted",
    data: {
      reason: "user",
      ...(args.message ? { message: args.message } : {}),
    },
  });
}

export function appendThreadTitleUpdatedEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    nextTitle: string;
    previousTitle?: string | null;
    threadId: string;
  },
): number {
  return appendThreadEvent(deps, {
    threadId: args.threadId,
    type: "system/thread-title/updated",
    data: {
      title: args.nextTitle,
      ...(args.previousTitle ? { previousTitle: args.previousTitle } : {}),
      source: "provider",
      providerMethod: "server/thread-title",
    },
  });
}

export function getLastTurnId(
  deps: Pick<AppDeps, "db">,
  threadId: string,
): string | null {
  const row = deps.db
    .select({ turnId: events.turnId })
    .from(events)
    .where(
      sql`${events.threadId} = ${threadId} AND ${events.turnId} IS NOT NULL`,
    )
    .orderBy(sql`${events.sequence} DESC`)
    .limit(1)
    .get();
  return row?.turnId ?? null;
}

export function getLastProviderThreadId(
  deps: Pick<AppDeps, "db">,
  threadId: string,
): string | null {
  const row = deps.db
    .select({ providerThreadId: events.providerThreadId })
    .from(events)
    .where(
      sql`${events.threadId} = ${threadId}
        AND ${events.providerThreadId} IS NOT NULL`,
    )
    .orderBy(sql`${events.sequence} DESC`)
    .limit(1)
    .get();
  return row?.providerThreadId ?? null;
}

export function getLastExecutionOptions(
  deps: Pick<AppDeps, "db">,
  threadId: string,
): ResolvedThreadExecutionOptions | null {
  const rows = deps.db
    .select({ data: events.data })
    .from(events)
    .where(
      sql`${events.threadId} = ${threadId}
        AND ${events.type} IN ('client/thread/start', 'client/turn/requested', 'client/turn/start')`,
    )
    .orderBy(sql`${events.sequence} DESC`)
    .all();

  for (const row of rows) {
    let eventData: unknown;
    try {
      eventData = JSON.parse(row.data);
    } catch {
      continue;
    }

    const parsed = turnRequestEventDataSchema.safeParse(eventData);
    if (!parsed.success) {
      continue;
    }

    return parsed.data.execution;
  }

  return null;
}
