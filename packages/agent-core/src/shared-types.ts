export type ReasoningLevel = "low" | "medium" | "high" | "xhigh";

export type ServiceTier = "fast" | "flex";

export type SandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

export type PromptInput =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string }
  | {
      type: "localFile";
      path: string;
      name?: string;
      sizeBytes?: number;
      mimeType?: string;
    };
