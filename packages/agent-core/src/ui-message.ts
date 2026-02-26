import type { Thread, ThreadEvent } from "./types.js";

export type UIMessageStatus =
  | "streaming"
  | "pending"
  | "completed"
  | "error"
  | "interrupted";

export interface UIMessageBase {
  id: string;
  threadId: string;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  createdAt: number;
  turnId?: string;
}

export interface UIUserMessage extends UIMessageBase {
  kind: "user";
  text: string;
  attachments?: {
    webImages: number;
    localImages: number;
  };
}

export interface UIAssistantReasoningMessage extends UIMessageBase {
  kind: "assistant-reasoning";
  text: string;
  status: Extract<UIMessageStatus, "streaming" | "completed">;
}

export interface UIAssistantTextMessage extends UIMessageBase {
  kind: "assistant-text";
  text: string;
  status: Extract<UIMessageStatus, "streaming" | "completed">;
}

export type UIToolParsedIntent =
  | {
      type: "read";
      cmd: string;
      name: string;
      path: string | null;
    }
  | {
      type: "list_files";
      cmd: string;
      path: string | null;
    }
  | {
      type: "search";
      cmd: string;
      query: string | null;
      path: string | null;
    }
  | {
      type: "unknown";
      cmd: string;
    };

export interface UIToolCallSummary {
  callId: string;
  command?: string;
  cwd?: string;
  parsedCmd: UIToolParsedIntent[];
  source?: string;
  output?: string;
  exitCode?: number;
  duration?: string;
  status: Extract<
    UIMessageStatus,
    "pending" | "completed" | "error" | "interrupted"
  >;
}

export interface UIToolExploringMessage extends UIMessageBase {
  kind: "tool-exploring";
  status: Extract<UIMessageStatus, "pending" | "completed">;
  calls: UIToolCallSummary[];
}

export interface UIToolCallMessage extends UIMessageBase {
  kind: "tool-call";
  toolName: string;
  callId: string;
  command?: string;
  cwd?: string;
  parsedCmd?: UIToolParsedIntent[];
  source?: string;
  output?: string;
  exitCode?: number;
  duration?: string;
  status: Extract<
    UIMessageStatus,
    "pending" | "completed" | "error" | "interrupted"
  >;
}

export interface UIWebSearchMessage extends UIMessageBase {
  kind: "web-search";
  callId: string;
  query?: string;
  action?: string;
  status: Extract<UIMessageStatus, "pending" | "completed">;
}

export interface UIFileEditChange {
  path: string;
  kind?: string;
  movePath?: string | null;
  diff?: string;
}

export interface UIFileEditMessage extends UIMessageBase {
  kind: "file-edit";
  callId: string;
  changes: UIFileEditChange[];
  stdout?: string;
  stderr?: string;
  status: Extract<
    UIMessageStatus,
    "pending" | "completed" | "error" | "interrupted"
  >;
}

export interface UIOperationMessage extends UIMessageBase {
  kind: "operation";
  opType: string;
  title: string;
  detail?: string;
}

export interface UIErrorMessage extends UIMessageBase {
  kind: "error";
  message: string;
  rawType: string;
}

export interface UIDebugRawEventMessage extends UIMessageBase {
  kind: "debug/raw-event";
  rawType: string;
  rawEvent: ThreadEvent;
  reason: "ignored-noise" | "duplicate-event" | "unhandled";
}

export type UIMessage =
  | UIUserMessage
  | UIAssistantReasoningMessage
  | UIAssistantTextMessage
  | UIToolExploringMessage
  | UIToolCallMessage
  | UIWebSearchMessage
  | UIFileEditMessage
  | UIOperationMessage
  | UIErrorMessage
  | UIDebugRawEventMessage;

export interface ToUIMessagesOptions {
  includeDebugRawEvents?: boolean;
  includeOptionalOperations?: boolean;
  threadStatus?: Thread["status"];
}
