export type ReasoningLevel = "low" | "medium" | "high" | "xhigh";

export type SandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

export type PromptInput =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string };
