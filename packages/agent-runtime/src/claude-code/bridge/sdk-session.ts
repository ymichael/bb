import {
  query,
  type CanUseTool,
  type McpSdkServerConfigWithInstance,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ClaudePermissionMode } from "../interactive-contract.js";

export interface SdkSessionOptions {
  cwd: string;
  systemPrompt: Exclude<Options["systemPrompt"], undefined>;
  model?: string;
  additionalDirectories?: readonly string[];
  effort?: Options["effort"];
  sessionId?: string;
  permissionMode?: ClaudePermissionMode;
  sandbox?: Options["sandbox"];
  hooks?: Options["hooks"];
  mcpServers?: Record<string, McpSdkServerConfigWithInstance>;
  allowedTools?: string[];
  disallowedTools?: string[];
  tools?: string[];
  canUseTool?: CanUseTool;
  env?: NodeJS.ProcessEnv;
  pathToClaudeCodeExecutable?: Options["pathToClaudeCodeExecutable"];
  thinking?: Options["thinking"];
}

type SdkSessionMessageHandler = (message: SDKMessage) => void;
type SdkSessionDoneHandler = (error?: unknown) => void;

export class SdkSession {
  private query: Query | undefined;
  private sessionId: string | undefined;
  private inputResolve:
    | ((value: IteratorResult<SDKUserMessage>) => void)
    | null = null;
  private readonly inputQueue: SDKUserMessage[] = [];
  private inputDone = false;
  private readonly abortController = new AbortController();
  private isProcessing = false;
  private readonly completion: Promise<void>;
  private complete: (() => void) | null = null;

  constructor(
    private readonly options: SdkSessionOptions,
    private readonly onMessage: SdkSessionMessageHandler,
    private readonly onDone: SdkSessionDoneHandler,
  ) {
    this.completion = new Promise((resolve) => {
      this.complete = resolve;
    });
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  getIsProcessing(): boolean {
    return this.isProcessing;
  }

  start(resumeSessionId?: string): void {
    if (resumeSessionId) {
      this.sessionId = resumeSessionId;
    } else if (this.options.sessionId) {
      this.sessionId = this.options.sessionId;
    }

    const sdkOptions: Options = {
      abortController: this.abortController,
      cwd: this.options.cwd,
      systemPrompt: this.options.systemPrompt,
      permissionMode: this.options.permissionMode ?? "default",
      includePartialMessages: true,
      // Mirror the Claude CLI cascade so the SDK loads both the user's global
      // configuration (~/.claude/settings.json, ~/.claude/CLAUDE.md) and the
      // workspace's project and local settings. Restricting this to "project"
      // hid global home configuration from bb-managed sessions.
      settingSources: ["user", "project", "local"],
      persistSession: true,
      env: this.options.env ?? process.env,
      ...(this.options.mcpServers
        ? { mcpServers: this.options.mcpServers }
        : {}),
      ...(this.options.allowedTools
        ? { allowedTools: this.options.allowedTools }
        : {}),
      ...(this.options.disallowedTools
        ? { disallowedTools: this.options.disallowedTools }
        : {}),
      ...(this.options.tools ? { tools: this.options.tools } : {}),
      ...(this.options.canUseTool
        ? { canUseTool: this.options.canUseTool }
        : {}),
      ...(this.options.sandbox ? { sandbox: this.options.sandbox } : {}),
      ...(this.options.hooks ? { hooks: this.options.hooks } : {}),
      ...(this.options.permissionMode === "bypassPermissions"
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      ...(!resumeSessionId && this.options.sessionId
        ? { sessionId: this.options.sessionId }
        : {}),
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.additionalDirectories
        ? { additionalDirectories: [...this.options.additionalDirectories] }
        : {}),
      ...(this.options.effort ? { effort: this.options.effort } : {}),
      ...(this.options.pathToClaudeCodeExecutable
        ? { pathToClaudeCodeExecutable: this.options.pathToClaudeCodeExecutable }
        : {}),
      ...(this.options.thinking ? { thinking: this.options.thinking } : {}),
    };

    this.query = query({
      prompt: this.createInputIterable(),
      options: sdkOptions,
    });

    void this.consumeStream();
  }

  pushInput(text: string): void {
    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: this.sessionId ?? "",
    };

    if (this.inputDone) return;

    if (this.inputResolve) {
      const resolve = this.inputResolve;
      this.inputResolve = null;
      resolve({ value: message, done: false });
      return;
    }

    this.inputQueue.push(message);
  }

  stop(): void {
    this.inputDone = true;
    this.resolveInputDone();
    this.abortController.abort();
    this.query?.close();
    this.query = undefined;
    this.isProcessing = false;
  }

  async closeGracefully(timeoutMs: number): Promise<void> {
    this.inputDone = true;
    this.resolveInputDone();

    if (!this.query) {
      return;
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.completion,
        new Promise<void>((_, reject) => {
          timeout = setTimeout(() => {
            reject(
              new Error(
                `Claude SDK session did not close within ${timeoutMs}ms`,
              ),
            );
          }, timeoutMs);
        }),
      ]);
    } catch {
      this.stop();
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private createInputIterable(): AsyncIterable<SDKUserMessage> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<SDKUserMessage>> {
            if (self.inputQueue.length > 0) {
              const value = self.inputQueue.shift();
              if (!value) {
                return { value: undefined, done: true };
              }
              return { value, done: false };
            }
            if (self.inputDone) {
              return { value: undefined, done: true };
            }
            return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
              self.inputResolve = resolve;
            });
          },
          async return(): Promise<IteratorResult<SDKUserMessage>> {
            self.inputDone = true;
            self.resolveInputDone();
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  private resolveInputDone(): void {
    if (!this.inputResolve) return;
    const resolve = this.inputResolve;
    this.inputResolve = null;
    resolve({ value: undefined, done: true });
  }

  private async consumeStream(): Promise<void> {
    const q = this.query;
    if (!q) return;

    try {
      for await (const message of q) {
        this.captureSessionId(message);
        this.trackProcessingState(message);
        this.onMessage(message);
      }
      this.isProcessing = false;
      this.onDone();
    } catch (error) {
      this.isProcessing = false;
      this.onDone(error);
    } finally {
      this.query = undefined;
      if (this.complete) {
        this.complete();
        this.complete = null;
      }
    }
  }

  private captureSessionId(message: SDKMessage): void {
    const { session_id } = message;
    const providerThreadId = session_id?.trim() ?? "";
    if (providerThreadId.length > 0) {
      this.sessionId = providerThreadId;
    }
  }

  private trackProcessingState(message: SDKMessage): void {
    if (message.type === "assistant" || message.type === "stream_event") {
      this.isProcessing = true;
    }
    if (message.type === "result") {
      this.isProcessing = false;
    }
  }
}
