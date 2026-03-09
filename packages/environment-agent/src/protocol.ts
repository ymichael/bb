export type EnvironmentAgentTransportKind = "command-stdio" | "http";

export type EnvironmentAgentConnectionTarget =
  | {
      transport: "command-stdio";
      command: string;
      args: string[];
      cwd?: string;
      env?: Record<string, string | undefined>;
      providerLaunch?: {
        command: string;
        args: string[];
      };
    }
  | {
      transport: "http";
      baseUrl: string;
      headers?: Record<string, string>;
    };

export type EnvironmentAgentCommand =
  | {
      type: "thread.start";
      threadId: string;
      projectId: string;
    }
  | {
      type: "thread.resume";
      threadId: string;
      projectId: string;
      providerThreadId: string;
    }
  | {
      type: "thread.stop";
      threadId: string;
    }
  | {
      type: "turn.start";
      threadId: string;
      providerThreadId: string;
    }
  | {
      type: "turn.steer";
      threadId: string;
      providerThreadId: string;
      turnId: string;
    }
  | {
      type: "workspace.status";
      threadId: string;
    }
  | {
      type: "workspace.diff";
      threadId: string;
    };

export interface EnvironmentAgentCommandEnvelope<
  TCommand extends EnvironmentAgentCommand = EnvironmentAgentCommand,
> {
  idempotencyKey: string;
  command: TCommand;
}

export type EnvironmentAgentEvent =
  | {
      type: "environment.ready";
      threadId: string;
    }
  | {
      type: "environment.degraded";
      threadId: string;
      message: string;
    }
  | {
      type: "thread.started";
      threadId: string;
      providerThreadId: string;
    }
  | {
      type: "thread.stopped";
      threadId: string;
    }
  | {
      type: "turn.started";
      threadId: string;
      turnId?: string;
    }
  | {
      type: "turn.completed";
      threadId: string;
      turnId?: string;
    }
  | {
      type: "provider.event";
      threadId: string;
      method: string;
      payload: unknown;
    }
  | {
      type: "workspace.status.changed";
      threadId: string;
    };

export interface EnvironmentAgentEventEnvelope<
  TEvent extends EnvironmentAgentEvent = EnvironmentAgentEvent,
> {
  sequence: number;
  emittedAt: number;
  event: TEvent;
}

export interface EnvironmentAgentReplayCursor {
  sequence: number;
}
